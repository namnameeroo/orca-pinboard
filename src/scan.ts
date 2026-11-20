// Pure: a Claude Code transcript (JSONL) as what the pinboard panel shows.
// No Node or Orca imports, so the worker, the panel and the tests all load it.
// scan / rollup / jiraMatcher are ported from ../pinboard/hooks/register.tsx;
// keep the two in step when one changes.

export type ToolUse = {
  tool: string
  tool_use_id: string
  input: Record<string, unknown>
  text?: string // the tool's result, as pinboard's SessionMessage carries it
}
export type Msg = {
  role: 'user' | 'assistant'
  text: string
  toolUses: ToolUse[]
  toolResults: { text: string }[]
}

export type Pr = {
  number: number
  title: string
  state: 'OPEN' | 'DRAFT' | 'MERGED' | 'CLOSED'
  review: string
  checks: string // CI rollup: ◐ running, ● pass, ✗ fail, '' none
  comments: number
  url: string
}
export type Doc = { path: string; kind: 'new' | 'ref'; tag: 'tmp' | 'repo' | 'out' }
export type Bg = {
  id: string
  label: string
  command: string
  status: string // running | completed | failed | killed
  out: string
  port?: number
}
// structurally Orca's TreeItem, so the panel hands it to <Tree> as is
export type TreeNode = { key: string; label: string; icon?: 'next'; children?: TreeNode[] }

export type Snap = {
  workspace: string
  cwd: string
  home: string
  sid: string
  branch: string
  worktree: string
  prs: Pr[]
  jira: { key: string; url: string }[]
  links: string[]
  tree: TreeNode[]
  current: string // the key of the intent the session is on now, '' for none
  prompts: string[]
  docs: Doc[]
  bg: Bg[]
  at: number
}

const blockText = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c
          .filter((b) => b?.type === 'text')
          .map((b) => String(b.text ?? ''))
          .join('\n')
      : ''

// One transcript line a message; meta rows (a skill's body, a hook's note) and
// sidechains (a subagent's) are not the conversation the person had.
export function toMessages(jsonl: string): Msg[] {
  const msgs: Msg[] = []
  const results = new Map<string, string>()
  for (const line of jsonl.split('\n')) {
    if (!line) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue // a line cut mid-write while the session runs
    }
    if ((d.type !== 'user' && d.type !== 'assistant') || d.isMeta || d.isSidechain) continue
    const content = d.message?.content
    const blocks: any[] = Array.isArray(content) ? content : []
    const toolResults = blocks
      .filter((b) => b?.type === 'tool_result')
      .map((b) => {
        const text = blockText(b.content)
        results.set(String(b.tool_use_id), text)
        return { text }
      })
    msgs.push({
      role: d.type,
      text: blockText(content),
      toolUses: blocks
        .filter((b) => b?.type === 'tool_use')
        .map((b) => ({ tool: String(b.name), tool_use_id: String(b.id), input: b.input ?? {} })),
      toolResults
    })
  }
  for (const m of msgs) for (const t of m.toolUses) t.text = results.get(t.tool_use_id)
  return msgs
}

// Claude Code's folder for a cwd under ~/.claude/projects.
// ponytail: no hashing of paths past 200 characters; add it if one comes up
export const slug = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-')

export const list = (v: unknown) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

// the listed projects only: any other KEY-123 is a model, a CVE, a spec (GPT-4, CVE-2024)
export const jiraMatcher = (projects: string) => {
  const keys = list(projects)
    .map((k) => k.toUpperCase())
    .filter((k) => /^[A-Z][A-Z0-9_]+$/.test(k))
  return keys.length ? new RegExp(`\\b(?:${keys.join('|')})-\\d{1,6}\\b`, 'g') : null
}

export const CI = { ok: '●', run: '◐', fail: '✗' } as const

export const rollup = (checks: unknown): string => {
  if (!Array.isArray(checks) || checks.length === 0) return ''
  const st = checks.map((c: any) => c.conclusion ?? c.state ?? '')
  // GitHub's conclusions that are not a pass (SKIPPED and NEUTRAL pass)
  if (st.some((s) => /FAIL|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED/i.test(s))) return CI.fail
  if (st.some((s) => /PENDING|IN_PROGRESS|QUEUED|^$/i.test(s))) return CI.run
  return CI.ok
}

const uniq = <T>(xs: T[]) => [...new Set(xs)]
// the last n distinct, ranked by their latest mention, oldest first
const recent = <T>(xs: T[], n: number) => uniq([...xs].reverse()).slice(0, n).reverse()

// What the transcript mentions: PRs, Jira keys, links, .md files, prompts, background Bash.
export function scan(msgs: readonly Msg[], root: string, branch: string, jiraKey: RegExp | null = null) {
  // message text only: tool output (a grep over fixtures) would crowd it out
  const said = msgs.map((m) => m.text).join('\n')

  const prRefs = recent(
    [...said.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)].map((m) => `${m[1]}#${m[2]}`),
    5
  )
  // the branch last: the latest mention, so its key always stays
  const jira = jiraKey ? recent(`${said} ${branch}`.match(jiraKey) ?? [], 3) : []
  const links = recent(
    [...said.matchAll(/https?:\/\/[^\s)<>\]"'`]+/g)]
      .map((m) => m[0])
      .filter(
        (u) =>
          /claude\.ai\/(code\/)?artifact|atlassian\.net|figma\.com|notion\.so/.test(u) &&
          /^https?:\/\/[^/]+\/[^/]/.test(u) && // a bare domain is not a link worth pinning
          !/[<>{}]/.test(u)
      ),
    5
  )

  const prompts = msgs
    .filter(
      (m) =>
        m.role === 'user' &&
        !m.toolResults.length &&
        m.text &&
        !/^(<|\[Request interrupted)/.test(m.text) // engine-written, not typed
    )
    .map((m) => m.text.split('\n')[0] ?? '')
    .slice(-20)

  const tag = (p: string): Doc['tag'] =>
    /scratchpad|^\/(private\/)?tmp\//.test(p) ? 'tmp' : p.startsWith(root) ? 'repo' : 'out'
  const docMap = new Map<string, Doc>()
  for (const m of msgs)
    for (const t of m.toolUses) {
      const p = String(t.input.file_path ?? '')
      if (!p.endsWith('.md')) continue
      if (t.tool === 'Write') docMap.set(p, { path: p, kind: 'new', tag: tag(p) })
      else if (t.tool === 'Read' && !docMap.has(p)) docMap.set(p, { path: p, kind: 'ref', tag: tag(p) })
    }
  const docs = [...docMap.values()].slice(-6)

  // background Bash: its result names the task and output file; a later
  // <task-notification> carrying its tool-use-id says how it ended
  const corpus = msgs
    .flatMap((m) => [m.text, ...m.toolUses.map((t) => t.text ?? ''), ...m.toolResults.map((r) => r.text)])
    .join('\n')
  const ended = new Map<string, string>(
    [...corpus.matchAll(/<tool-use-id>(\S+?)<\/tool-use-id>[\s\S]{0,600}?<status>(\w+)<\/status>/g)].map(
      (n) => [n[1]!, n[2]!]
    )
  )
  const bg = msgs
    .flatMap((m) => m.toolUses)
    .flatMap((t): Bg[] => {
      const r = /background with ID: (\S+?)\. Output is being written to: (\S+?)\.(?:\s|$)/.exec(t.text ?? '')
      if (t.tool !== 'Bash' || t.input.run_in_background !== true || !r) return []
      const command = String(t.input.command ?? '')
      return [
        {
          id: r[1]!,
          out: r[2]!,
          command,
          label: String(t.input.description || command.split('\n')[0]),
          status: ended.get(t.tool_use_id) ?? 'running'
        }
      ]
    })
    .slice(-6)

  return { prRefs, jira, links, prompts, docs, bg }
}

// a running task's log: its exit if it ended, else the port it serves
export function bgFromLog(b: Bg, log: string): Bg {
  if (b.status !== 'running') return b
  const exit = /\[exited with code (\d+)\]\s*$/.exec(log)
  if (exit) return { ...b, status: exit[1] === '0' ? 'completed' : 'failed' }
  const p = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})|--port[= ](\d{2,5})|\bPORT=(\d{2,5})/.exec(
    `${log}\n${b.command}`
  )
  return p ? { ...b, port: Number(p[1] ?? p[2] ?? p[3]) } : b
}

type IntentEntry = { ts: string; label: string; parent?: string | null }

// ~/.claude/intent/<sid>.json as a tree: `parent` is the ts of the entry it
// refines, null for a new topic, absent (older records) = under the first topic.
// The last entry is the current one.
export function intentTree(intent: { initial?: IntentEntry; history?: IntentEntry[] } | null): {
  tree: TreeNode[]
  current: string
} {
  if (!intent?.initial) return { tree: [], current: '' }
  const all = [intent.initial, ...(intent.history ?? [])]
  // parent by index, always an earlier entry: no cycle even if two ts collide
  const nodes: TreeNode[] = all.map((n, i) => ({ key: `i${i}`, label: n.label }))
  const tree: TreeNode[] = []
  all.forEach((n, i) => {
    const j = i === 0 || n.parent === null ? -1 : all.slice(0, i).map((m) => m.ts).lastIndexOf(n.parent ?? '')
    const parent = i === 0 || n.parent === null ? null : nodes[j >= 0 ? j : 0]!
    if (parent) (parent.children ??= []).push(nodes[i]!)
    else tree.push(nodes[i]!)
  })
  const current = nodes[nodes.length - 1]!
  current.icon = 'next'
  return { tree, current: current.key }
}

// home as ~, only where the path starts with it (/Users/meow is not under /Users/me)
export const tilde = (p: string, home: string) =>
  home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
