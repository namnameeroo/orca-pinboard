// Gathers what the panel shows: Orca names the focused workspace and its path,
// Claude Code's transcript and intent files say what the session did, gh the PRs.
import { execFile } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { bgFromLog, intentTree, jiraMatcher, rollup, scan, slug, toMessages, type Pr, type Snap } from './scan'

// Orca starts from Finder with launchd's PATH, which has no Homebrew: gh lives there.
// ponytail: fixed dirs; read `$SHELL -lc 'echo $PATH'` if gh sits elsewhere
const PATH = `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`
const run = (file: string, args: string[], opts: { cwd?: string; input?: string } = {}) =>
  new Promise<string>((ok, fail) => {
    const child = execFile(file, args, { cwd: opts.cwd, timeout: 15_000, env: { ...process.env, PATH } }, (e, out) =>
      e ? fail(e) : ok(out)
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })

const failed = (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })

// A doc the session wrote or read opens in its app; anything else (a .md that is a
// link to an app, say) is only shown in Finder: a path from the transcript never runs code.
// ponytail: macOS `open` and `pbcopy`; xdg-open / wl-copy if Orca runs elsewhere
async function openDoc(path: string) {
  if (!path.startsWith('/')) return { ok: false, error: '절대 경로가 아닙니다' }
  const real = await realpath(path).catch(() => null)
  if (!real) return { ok: false, error: '파일이 없습니다' }
  const isDoc = /\.(md|markdown)$/i.test(real)
  try {
    await run('open', isDoc ? [real] : ['-R', real])
    return { ok: true, how: isDoc ? ('opened' as const) : ('revealed' as const) }
  } catch (e) {
    return failed(e)
  }
}

// each PR's last answer: a merged or closed one is not asked again, and a failed
// ask (offline, signed out, a timeout) keeps it. ponytail: per worker run
const prs = new Map<string, Pr>()

async function pr(ref: string, cwd: string): Promise<Pr | null> {
  const [repo = '', n = ''] = ref.split('#')
  const url = `https://github.com/${repo}/pull/${n}`.toLowerCase()
  const last = prs.get(url) ?? null
  if (last?.state === 'MERGED' || last?.state === 'CLOSED') return last
  try {
    const j = JSON.parse(
      await run(
        'gh',
        ['pr', 'view', n, '--repo', repo, '--json', 'number,title,state,isDraft,reviewDecision,statusCheckRollup,url,comments'],
        { cwd }
      )
    )
    const p: Pr = {
      number: j.number,
      title: j.title,
      state: j.isDraft ? 'DRAFT' : j.state,
      review: j.reviewDecision ?? '',
      checks: rollup(j.statusCheckRollup),
      comments: j.comments?.length ?? 0,
      url: j.url
    }
    prs.set(url, p)
    return p
  } catch {
    return last
  }
}

// the session last written to: in Orca chat each turn forks a new transcript, so
// the newest one is the conversation now. ponytail: two agents in one workspace
// show whichever wrote last; pick by agents.list sessionId if that matters
async function newest(dir: string): Promise<string | null> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl'))
  const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(dir, n))).mtimeMs })))
  return dated.sort((a, b) => b.t - a.t)[0]?.n ?? null
}

async function snapshot(orca: OrcaWorkerApi): Promise<{ snap: Snap | null; note?: string }> {
  const ctx = await orca.host.call('workspace.readContext', {})
  if (!ctx) return { snap: null, note: '포커스된 워크스페이스가 없습니다.' }
  const { workspaces } = await orca.host.call('workspace.list', {})
  const ws =
    workspaces.find((w) => w.id === ctx.workspaceId) ??
    workspaces.find((w) => w.name === ctx.displayName && (w.branch ?? '') === ctx.branch)
  if (!ws) return { snap: null, note: `워크스페이스 경로를 찾지 못했습니다: ${ctx.displayName}` }
  if (ws.hostId && ws.hostId !== 'local') return { snap: null, note: '원격 워크스페이스는 아직 지원하지 않습니다.' }

  const home = homedir()
  // ponytail: ~/.claude only; CLAUDE_CONFIG_DIR (an Orca-managed account) keeps its own
  const dir = join(home, '.claude', 'projects', slug(ws.path))
  const file = await newest(dir)
  if (!file) return { snap: null, note: `이 워크스페이스에서 연 Claude 세션이 없습니다.\n${ws.path}` }
  const sid = file.replace(/\.jsonl$/, '')
  const branch = ws.branch ?? ctx.branch ?? ''

  const settings = await orca.settings.get()
  const jiraBase = String(settings.jiraBase ?? '').trim().replace(/\/+$/, '')
  const jiraKey = jiraBase ? jiraMatcher(String(settings.jiraProjects ?? '')) : null

  const msgs = toMessages(await readFile(join(dir, file), 'utf8'))
  const found = scan(msgs, ws.path, branch, jiraKey)
  const [prList, bg, intentRaw] = await Promise.all([
    Promise.all(found.prRefs.map((r) => pr(r, ws.path))),
    Promise.all(found.bg.map(async (b) => bgFromLog(b, await readFile(b.out, 'utf8').catch(() => '')))),
    readFile(join(home, '.claude', 'intent', `${sid}.json`), 'utf8').catch(() => '')
  ])
  let intent = { tree: [] as Snap['tree'], current: '' }
  try {
    intent = intentTree(JSON.parse(intentRaw)) // none or broken: the card reads 없음
  } catch {}

  return {
    snap: {
      workspace: ws.name,
      cwd: ws.path,
      home,
      sid,
      branch,
      worktree: ws.kind === 'worktree' ? ws.name : '',
      prs: prList.filter((p): p is Pr => p !== null),
      jira: found.jira.map((key) => ({ key, url: `${jiraBase}/browse/${key}` })),
      links: found.links,
      tree: intent.tree,
      current: intent.current,
      prompts: found.prompts,
      docs: found.docs,
      bg,
      at: Date.now()
    }
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('snap.get', () => snapshot(orca))
  // a panel has no clipboard; the worker is a process of the person's own
  orca.panels.handle('clip.copy', ({ text }) =>
    run('pbcopy', [], { input: text }).then(() => ({ ok: true }), failed)
  )
  orca.panels.handle('doc.open', ({ path }) => openDoc(path))
}
