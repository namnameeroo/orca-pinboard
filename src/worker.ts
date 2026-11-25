// Gathers what the panel shows: Orca names the focused workspace and its path,
// Claude Code's transcript and intent files say what the session did, gh the PRs.
import { execFile } from 'node:child_process'
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PluginRequestOutput } from 'orca/host'
import type { OrcaWorkerApi } from 'orca/worker'
import './protocol'
import {
  bgFromLog,
  intentTree,
  jiraMatcher,
  LOST,
  openPlan,
  scan,
  slug,
  tilde,
  toMessages,
  toPr,
  type Bg,
  type Pr,
  type Snap
} from './scan'

// what failed, for `orca plugin logs`; activate points it at orca.log
let log = (_: string) => {}
// an error as one line, never empty (an Error with no message reads as its name)
const why = (e: unknown) => (e instanceof Error ? e.message || e.name : String(e)) || 'unknown error'
// a log line keeps the stack: a parsing bug and a missing file read alike otherwise
const traced = (e: unknown) => (e instanceof Error && e.stack ? e.stack : why(e))
const codeOf = (e: unknown) => (e as { code?: string } | null)?.code

// Why a command failed, for the panel: a timeout says so (Node kills it and its message is
// the command line alone); otherwise its stderr, the "Command failed: …" line dropped, its
// lines joined (gh's sign-in hint spans two).
const TIMEOUT_MS = 15_000
export const reason = (e: unknown) => {
  if ((e as { killed?: boolean } | null)?.killed) return `${TIMEOUT_MS / 1000}초 안에 끝나지 않음`
  const lines = why(e)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Command failed:'))
  return (lines.join(' / ') || why(e)).slice(0, 160)
}

// Orca hands its children the login shell's PATH (measured: /opt/homebrew/bin is on it);
// the two dirs are a fallback should that change. Relative entries are dropped so a file
// in a workspace can never stand in for gh; open and pbcopy go by absolute path.
export const safePath = (env: string | undefined) =>
  [...(env ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin'].filter((p) => p.startsWith('/')).join(':')
const PATH = safePath(process.env.PATH)

const run = (file: string, args: string[], input?: string) =>
  new Promise<string>((ok, fail) => {
    const child = execFile(file, args, { timeout: TIMEOUT_MS, env: { ...process.env, PATH } }, (e, out) =>
      e ? fail(e) : ok(out)
    )
    if (input === undefined) return
    // a child gone before it read: the callback above says why; this keeps the worker up
    child.stdin?.on('error', (e) => log(`${file} stdin: ${why(e)}`))
    child.stdin?.end(input)
  })
// gh runs through here, so a test can stand in for it
export const deps = { run }

// A doc opens in its app only when its real path is a .md or .markdown file; anything
// else (a link to an app or a script, a directory named x.md) is only shown in Finder, so
// a path the model wrote never starts a program by itself.
// ponytail: macOS (/usr/bin/open, /usr/bin/pbcopy); xdg-open / wl-copy if Orca runs elsewhere
export async function planFor(path: string): Promise<ReturnType<typeof openPlan> | { error: string }> {
  if (!path.startsWith('/')) return { error: '절대 경로가 아닙니다' }
  try {
    const real = await realpath(path)
    return openPlan(real, (await stat(real)).isFile())
  } catch (e) {
    return { error: codeOf(e) === 'ENOENT' ? '파일이 없습니다' : reason(e) }
  }
}

async function openDoc(path: string): Promise<PluginRequestOutput<'doc.open'>> {
  const plan = await planFor(path)
  if ('error' in plan) return { ok: false, error: plan.error }
  try {
    await run('/usr/bin/open', plan.args)
    return { ok: true, how: plan.how }
  } catch (e) {
    log(`doc.open ${plan.args.at(-1)}: ${why(e)}`)
    return { ok: false, error: reason(e) }
  }
}

// each PR's last answer: a merged one is not asked again (a closed one is: it can be
// reopened), and when gh fails (offline, signed out, a timeout) the row keeps its last
// answer, marked with why. A failure is logged once until its reason changes.
// ponytail: in memory, so it lasts one worker run (Orca stops an idle worker) and grows
// with every PR seen; keeping it in orca.storage would need storage:own back (a new
// approval), and dropping refs the latest scan no longer names bounds it
const prs = new Map<string, Pr>()
const failed = new Map<string, string>()

async function pr(ref: string): Promise<Pr> {
  const [repo = '', n = ''] = ref.split('#')
  const url = `https://github.com/${repo}/pull/${n}`
  const last = prs.get(url)
  if (last?.state === 'MERGED') return last
  const fallback = (error: string): Pr => {
    if (failed.get(url) !== error) log(`gh pr view ${ref}: ${error}`)
    failed.set(url, error)
    const known: Pr = last ?? { number: Number(n), title: ref, state: 'UNKNOWN', review: '', checks: '', comments: 0, url }
    return { ...known, error }
  }
  let out: string
  try {
    // --jq counts the comments: their bodies could pass execFile's 1 MiB output limit
    out = await deps.run('gh', [
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
  } catch (e) {
    return fallback(reason(e))
  }
  try {
    const p = toPr(JSON.parse(out))
    prs.set(url, p)
    failed.delete(url)
    return p
  } catch (e) {
    return fallback(`gh 출력 해석 실패: ${why(e)}`.slice(0, 160))
  }
}

// the session last written to, by mtime: in Orca chat each turn forks a new transcript,
// so the newest one is the conversation now. A file stat cannot read is passed over (a
// dangling link quietly, anything else logged); a folder that cannot be read is an error.
// ponytail: two Claude sessions in one workspace show whichever wrote last; pick by
// agents.list sessionId if that matters
async function newest(dir: string): Promise<{ name: string; t: number } | null> {
  const names = await readdir(dir).catch((e) => {
    if (codeOf(e) === 'ENOENT') return [] as string[]
    throw e
  })
  const dated = await Promise.all(
    names
      .filter((n) => n.endsWith('.jsonl'))
      .map(async (name) => {
        const t = await stat(join(dir, name)).then(
          (s) => s.mtimeMs,
          (e) => {
            if (codeOf(e) !== 'ENOENT') log(`stat ${name}: ${why(e)}`)
            return null
          }
        )
        return { name, t }
      })
  )
  return (
    dated
      .filter((d): d is { name: string; t: number } => d.t !== null)
      .sort((a, b) => b.t - a.t)[0] ?? null
  )
}

// A log over 4 MiB is read at its two ends only: the port is printed near the start, the
// exit line is the last.
const LOG_CAP = 4 * 1024 * 1024
const EDGE = 64 * 1024
async function readEdges(path: string, size: number): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const at = async (position: number) => {
      const buf = new Uint8Array(EDGE)
      const { bytesRead } = await fh.read(buf, 0, EDGE, position)
      return new TextDecoder().decode(buf.subarray(0, bytesRead))
    }
    return `${await at(0)}\n${await at(Math.max(0, size - EDGE))}`
  } finally {
    await fh.close()
  }
}

// a running task's state from its output file: gone = lost; unreadable = running, logged
async function bgStatus(b: Bg): Promise<Bg> {
  if (b.status !== 'running') return b
  try {
    const st = await stat(b.out)
    return bgFromLog(b, st.size > LOG_CAP ? await readEdges(b.out, st.size) : await readFile(b.out, 'utf8'))
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return { ...b, status: LOST }
    log(`bg ${b.out}: ${why(e)}`)
    return bgFromLog(b, '')
  }
}

async function snapshot(orca: OrcaWorkerApi): Promise<PluginRequestOutput<'snap.get'>> {
  const ctx = await orca.host.call('workspace.readContext', {})
  if (!ctx) return { snap: null, note: '포커스된 워크스페이스가 없습니다.' }
  const { workspaces, truncated } = await orca.host.call('workspace.list', {})
  // readContext's workspaceId need not be workspace.list's id: then name and branch, but
  // only when they name one workspace (two projects can each have a "web" on main)
  const byName = workspaces.filter((w) => w.name === ctx.displayName && (w.branch ?? '') === ctx.branch)
  const ws = workspaces.find((w) => w.id === ctx.workspaceId) ?? (byName.length === 1 ? byName[0] : undefined)
  if (!ws)
    return {
      snap: null,
      note:
        byName.length > 1
          ? `이름과 브랜치가 같은 워크스페이스가 여럿이라 하나로 정하지 못했습니다: ${ctx.displayName}`
          : `워크스페이스 경로를 찾지 못했습니다: ${ctx.displayName}${truncated ? ' (Orca가 목록을 잘라서 줌)' : ''}`
    }
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
  const intentFile = join(home, '.claude', 'intent', `${sid}.json`)
  const [prList, bg, intentRaw] = await Promise.all([
    Promise.all(found.prRefs.map(pr)),
    Promise.all(found.bg.map(bgStatus)),
    readFile(intentFile, 'utf8').catch((e) => (codeOf(e) === 'ENOENT' ? '' : e))
  ])
  // none: the card reads 없음; there but unreadable or broken: the card says so, the log why
  let intent: Pick<Snap, 'tree' | 'current'> = { tree: [], current: '' }
  let intentError: string | undefined
  try {
    if (typeof intentRaw !== 'string') throw intentRaw
    if (intentRaw) intent = intentTree(JSON.parse(intentRaw))
  } catch (e) {
    intentError = why(e)
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
      ...(intentError ? { intentError } : {}),
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
  // a failure answers why rather than throwing: a throw reaches the panel as a code only
  // (action_failed for one that is not Orca's), never its message
  orca.panels.handle('snap.get', () =>
    snapshot(orca).catch((e) => {
      log(`snap.get: ${traced(e)}`)
      return { snap: null, error: why(e) }
    })
  )
  // a panel has no clipboard; the worker is a Node process running as the user, so pbcopy
  // reaches their clipboard
  orca.panels.handle('clip.copy', ({ text }) =>
    run('/usr/bin/pbcopy', [], text).then(
      () => ({ ok: true as const }),
      (e) => {
        log(`clip.copy: ${why(e)}`)
        return { ok: false as const, error: reason(e) }
      }
    )
  )
  orca.panels.handle('doc.open', ({ path }) => openDoc(path))
}
