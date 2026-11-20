// Gathers what the panel shows: Orca names the focused workspace and its path,
// Claude Code's transcript and intent files say what the session did, gh the PRs.
import { execFile } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import './protocol'
import { bgFromLog, intentTree, jiraMatcher, openPlan, scan, slug, tilde, toMessages, toPr, type Bg, type Pr, type Snap } from './scan'

// what failed, for `orca plugin logs`; activate points it at orca.log
let log = (_: string) => {}
const why = (e: unknown) => (e instanceof Error ? e.message : String(e))
// a command's error is "Command failed: <cmd>" and its stderr: the last line says why
const lastLine = (s: string) => (s.trim().split('\n').filter(Boolean).at(-1) ?? s).slice(0, 160)

// Orca hands its children the login shell's PATH (measured: /opt/homebrew/bin is on it);
// the two dirs are a fallback should that change. Relative entries are dropped so a file
// in a workspace can never stand in for gh; open and pbcopy go by absolute path.
const PATH = [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin']
  .filter((p) => p.startsWith('/'))
  .join(':')

const run = (file: string, args: string[], input?: string) =>
  new Promise<string>((ok, fail) => {
    const child = execFile(file, args, { timeout: 15_000, env: { ...process.env, PATH } }, (e, out) =>
      e ? fail(e) : ok(out)
    )
    if (input === undefined) return
    child.stdin?.on('error', () => {}) // a child gone before it read: the callback above says why
    child.stdin?.end(input)
  })

// A doc opens in its app only when its real path is a .md or .markdown file; anything
// else (a link to an app or a script included) is only shown in Finder, so a path the
// model wrote never starts a program by itself.
// ponytail: macOS (/usr/bin/open, /usr/bin/pbcopy); xdg-open / wl-copy if Orca runs elsewhere
async function openDoc(path: string) {
  if (!path.startsWith('/')) return { ok: false, error: '절대 경로가 아닙니다' }
  const real = await realpath(path).catch(() => null)
  if (!real) return { ok: false, error: '파일이 없습니다' }
  const plan = openPlan(real)
  try {
    await run('/usr/bin/open', plan.args)
    return { ok: true, how: plan.how }
  } catch (e) {
    log(`doc.open ${real}: ${why(e)}`)
    return { ok: false, error: lastLine(why(e)) }
  }
}

// each PR's last answer: a merged or closed one is not asked again, and when gh fails
// (offline, signed out, a timeout) the row keeps its last answer, marked with why.
// ponytail: in memory, so it lasts one worker run (Orca stops an idle worker) and is
// never pruned; keep it in orca.storage if asking gh again after a restart matters
const prs = new Map<string, Pr>()

async function pr(ref: string): Promise<Pr> {
  const [repo = '', n = ''] = ref.split('#')
  const url = `https://github.com/${repo}/pull/${n}`
  const last = prs.get(url)
  if (last?.state === 'MERGED' || last?.state === 'CLOSED') return last
  try {
    // --jq counts the comments: their bodies could pass execFile's 1 MiB output limit
    const p = toPr(
      JSON.parse(
        await run('gh', [
          'pr',
          'view',
          n,
          '--repo',
          repo,
          '--json',
          'number,title,state,isDraft,reviewDecision,statusCheckRollup,url,comments',
          '--jq',
          '.comments |= length'
        ])
      )
    )
    prs.set(url, p)
    return p
  } catch (e) {
    log(`gh pr view ${ref}: ${why(e)}`)
    const known = last ?? { number: Number(n), title: ref, state: 'UNKNOWN', review: '', checks: '', comments: 0, url }
    return { ...known, error: lastLine(why(e)) }
  }
}

// the session last written to, by mtime: in Orca chat each turn forks a new transcript,
// so the newest one is the conversation now. A file stat cannot read (a dangling link,
// one removed meanwhile) is passed over.
// ponytail: two Claude sessions in one workspace show whichever wrote last; pick by
// agents.list sessionId if that matters
async function newest(dir: string): Promise<{ name: string; t: number } | null> {
  const names = await readdir(dir).catch((e: { code?: string }) => {
    if (e.code !== 'ENOENT') log(`readdir ${dir}: ${why(e)}`)
    return [] as string[]
  })
  const dated = await Promise.all(
    names
      .filter((n) => n.endsWith('.jsonl'))
      .map(async (name) => ({ name, t: await stat(join(dir, name)).then((s) => s.mtimeMs, () => -1) }))
  )
  return dated.filter((d) => d.t >= 0).sort((a, b) => b.t - a.t)[0] ?? null
}

// a running task's state from its output file: gone = lost (its shell went with it).
// ponytail: a log over 4 MiB is not read, as in pinboard: it reads running, its port
// from the command alone
const LOG_CAP = 4 * 1024 * 1024
async function bgStatus(b: Bg): Promise<Bg> {
  if (b.status !== 'running') return b
  const st = await stat(b.out).catch((e: { code?: string }) => {
    if (e.code === 'ENOENT') return null
    log(`bg ${b.out}: ${why(e)}`)
    return undefined
  })
  if (st === null) return { ...b, status: 'lost' }
  if (!st || st.size > LOG_CAP) return bgFromLog(b, '')
  const text = await readFile(b.out, 'utf8').catch((e) => {
    log(`bg ${b.out}: ${why(e)}`)
    return ''
  })
  return bgFromLog(b, text)
}

async function snapshot(orca: OrcaWorkerApi): Promise<{ snap: Snap | null; note?: string }> {
  const ctx = await orca.host.call('workspace.readContext', {})
  if (!ctx) return { snap: null, note: '포커스된 워크스페이스가 없습니다.' }
  const { workspaces } = await orca.host.call('workspace.list', {})
  // readContext's workspaceId need not be workspace.list's id: fall back to name and branch
  const ws =
    workspaces.find((w) => w.id === ctx.workspaceId) ??
    workspaces.find((w) => w.name === ctx.displayName && (w.branch ?? '') === ctx.branch)
  if (!ws) return { snap: null, note: `워크스페이스 경로를 찾지 못했습니다: ${ctx.displayName}` }
  if (ws.hostId && ws.hostId !== 'local') return { snap: null, note: '원격 워크스페이스는 아직 지원하지 않습니다.' }

  const home = homedir()
  // ponytail: ~/.claude only (transcripts and intent); a session under another
  // CLAUDE_CONFIG_DIR reads "no session". Add a setting for more config dirs if one is used
  const dir = join(home, '.claude', 'projects', slug(ws.path))
  const file = await newest(dir)
  if (!file)
    return {
      snap: null,
      note: `이 워크스페이스에서 연 Claude 세션이 없습니다.\n${tilde(dir, home)}에 기록이 없습니다.`
    }
  const sid = file.name.replace(/\.jsonl$/, '')
  const branch = ws.branch ?? ctx.branch ?? ''

  const settings = await orca.settings.get()
  const jiraBase = String(settings.jiraBase ?? '').trim().replace(/\/+$/, '')
  const jiraKey = jiraBase ? jiraMatcher(String(settings.jiraProjects ?? '')) : null

  const msgs = toMessages(await readFile(join(dir, file.name), 'utf8'))
  const found = scan(msgs, ws.path, branch, jiraKey)
  const [prList, bg, intentRaw] = await Promise.all([
    Promise.all(found.prRefs.map(pr)),
    Promise.all(found.bg.map(bgStatus)),
    readFile(join(home, '.claude', 'intent', `${sid}.json`), 'utf8').catch(() => '')
  ])
  // none: the card reads 없음; broken: 없음 too, and the log says why
  let intent: Pick<Snap, 'tree' | 'current'> = { tree: [], current: '' }
  if (intentRaw)
    try {
      intent = intentTree(JSON.parse(intentRaw))
    } catch (e) {
      log(`intent ${sid}.json: ${why(e)}`)
    }

  return {
    snap: {
      workspace: ws.name,
      workspaceId: ws.id,
      cwd: ws.path,
      home,
      sid,
      branch,
      worktree: ws.kind === 'worktree' ? ws.name : '',
      prs: prList,
      jira: found.jira.map((key) => ({ key, url: `${jiraBase}/browse/${key}` })),
      links: found.links,
      tree: intent.tree,
      current: intent.current,
      prompts: found.prompts,
      docs: found.docs,
      bg,
      writtenAt: file.t,
      at: Date.now()
    }
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  log = (m) => orca.log(m)
  // a failure answers why rather than throwing: Orca would hand the panel only "action_failed"
  orca.panels.handle('snap.get', () =>
    snapshot(orca).catch((e) => {
      log(`snap.get: ${why(e)}`)
      return { snap: null, error: why(e) }
    })
  )
  // a panel has no clipboard; the worker is a Node process running as the user, so pbcopy
  // reaches their clipboard
  orca.panels.handle('clip.copy', ({ text }) =>
    run('/usr/bin/pbcopy', [], text).then(
      () => ({ ok: true }),
      (e) => {
        log(`clip.copy: ${why(e)}`)
        return { ok: false, error: lastLine(why(e)) }
      }
    )
  )
  orca.panels.handle('doc.open', ({ path }) => openDoc(path))
}
