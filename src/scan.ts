// Pure: a Claude Code transcript (JSONL) as what the pinboard panel shows.
// No Node or Orca imports, so the worker, the panel and the tests all load it.
// scan, rollup, jiraMatcher, list, toPr, pinnable, trimUrl, bgFromLog (from collect)
// and intentTree (from layoutTree) are ported from pinboard's hooks/register.tsx in
// github.com/namnameeroo/claude-mods; keep them in step. They differ on purpose: rollup
// answers '' and plain marks; toPr reads a state it does not know as UNKNOWN and the
// comments as gh's --jq count; intentTree answers Tree items; list keeps a leading /.

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

export const CI = { ok: '●', run: '◐', fail: '✗' } as const
export type Checks = (typeof CI)[keyof typeof CI] | '' // '' = no checks

export type Pr = {
  number: number
  title: string
  state: 'OPEN' | 'DRAFT' | 'MERGED' | 'CLOSED' | 'UNKNOWN'
  review: string
  checks: Checks
  comments: number
  url: string
  error?: string // gh could not answer: the row is its last answer, or only the link
}
export type Doc = { path: string; kind: 'new' | 'ref'; tag: 'tmp' | 'repo' | 'out' }
export const LOST = 'lost'
export type Bg = {
  id: string
  label: string
  command: string
  // running, or the notification's word (completed, failed, killed, stopped, …), or
  // LOST: its output file is gone (a reboot, /tmp cleaned); usually the task went with
  // it, though a cleaned /tmp can drop the file of one still running
  status: string
  out: string
  port?: number
}
// structurally Orca's TreeItem, so the panel hands it to <Tree> as is
export type TreeNode = { key: string; label: string; icon?: 'next'; children?: TreeNode[] }

export type Snap = {
  workspace: string
  workspaceId: string // workspace.list's id: what agent events name as workspaceListId
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
  intentError?: string // the intent file is there but could not be read: the card says so
  prompts: string[]
  docs: Doc[]
  bg: Bg[]
  writtenAt: number // when the transcript was last written: an old session shows as old
  at: number // when the worker read it (the ⟳ time)
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
    if (!d || (d.type !== 'user' && d.type !== 'assistant') || d.isMeta || d.isSidechain) continue
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
// ponytail: no hashing of paths past 200 characters, so such a workspace reads
// "no Claude session"; add Claude Code's truncate + hash if one comes up
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

// A check's word: a CheckRun's conclusion once done, else its status (QUEUED, IN_PROGRESS,
// …); a StatusContext's state.
export const rollup = (checks: unknown): Checks => {
  const words = (Array.isArray(checks) ? checks : [])
    .filter(Boolean)
    .map((c: any) => String(c.conclusion || c.status || c.state || ''))
  if (!words.length) return ''
  // not a pass (SKIPPED and NEUTRAL pass); STALE: a run GitHub gave up on, it needs a re-run
  if (words.some((s) => /FAIL|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STALE/i.test(s))) return CI.fail
  // EXPECTED: a required status not reported yet
  if (words.some((s) => /PENDING|QUEUED|IN_PROGRESS|WAITING|REQUESTED|EXPECTED|^$/i.test(s))) return CI.run
  return CI.ok
}

// what gh pr view --json … --jq '.comments |= length' answers
export type GhPr = {
  number: number
  title: string
  state: string
  isDraft?: boolean
  reviewDecision?: string | null
  statusCheckRollup?: unknown
  comments?: number
  url: string
}
const PR_STATES: readonly Pr['state'][] = ['OPEN', 'MERGED', 'CLOSED']

export const toPr = (j: GhPr): Pr => ({
  number: j.number,
  title: j.title,
  // GitHub keeps isDraft on a draft it closed: only an open draft is a draft
  state: j.state === 'OPEN' && j.isDraft ? 'DRAFT' : (PR_STATES.find((s) => s === j.state) ?? 'UNKNOWN'),
  review: j.reviewDecision ?? '',
  checks: rollup(j.statusCheckRollup),
  comments: typeof j.comments === 'number' ? j.comments : 0, // the --jq count
  url: j.url
})

// how `open` treats a doc's real path: its app for a markdown file, Finder for anything
// else (a directory named x.md included)
export const openPlan = (real: string, isFile = true) =>
  isFile && /\.(md|markdown)$/i.test(real)
    ? { args: [real], how: 'opened' as const }
    : { args: ['-R', real], how: 'revealed' as const }

// a link worth pinning, judged by its host, read by hand: an Atlassian, Figma or Notion
// page, or a Claude artifact (the private and the public link)
export const pinnable = (u: string) => {
  const m = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:]+)(?::\d+)?(\/[^?#]*)?/i.exec(u)
  const host = (m?.[1] ?? '').toLowerCase()
  const path = m?.[2] ?? ''
  return host === 'claude.ai'
    ? /^\/((code\/)?artifact|public\/artifacts)\//.test(path)
    : /(^|\.)(atlassian\.net|figma\.com|notion\.so)$/.test(host) && path.length > 1 // a bare domain is not a page
}

// A URL as written in a message: up to a space, a quote, a bracket or a tag. Then less the
// punctuation that ends a sentence or markdown's emphasis, and a Korean particle glued on
// (Hangul right after an ASCII letter or digit, as in "…abc123를"); Hangul elsewhere in a
// path stays.
const URL_RE = /https?:\/\/[^\s<>"'`{}()[\]\\^|]+/g
export const trimUrl = (u: string) =>
  u
    .replace(/[.,;:!?*_~]+$/, '')
    .replace(/([A-Za-z0-9])[가-힣]+$/, '$1')
    .replace(/[.,;:!?*_~]+$/, '')

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const uniq = <T>(xs: T[]) => [...new Set(xs)]
// the last n distinct, ranked by their latest mention, oldest first
const recent = <T>(xs: T[], n: number) => uniq([...xs].reverse()).slice(0, n).reverse()

// What the transcript mentions: PRs, Jira keys, links, .md files, prompts, background Bash.
export function scan(msgs: readonly Msg[], root: string, branch: string, jiraKey: RegExp | null = null) {
  // message text only: tool output (a grep over fixtures) would crowd it out
  const said = msgs.map((m) => m.text).join('\n')

  // GitHub names are case-insensitive: Acme/Web#1 and acme/web#1 are one PR
  const prRefs = recent(
    [...said.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)].map((m) => `${m[1]!.toLowerCase()}#${m[2]}`),
    5
  )
  // the branch last: the latest mention, so its key always stays
  const jira = jiraKey ? recent(`${said} ${branch}`.match(jiraKey) ?? [], 3) : []
  const links = recent(
    [...said.matchAll(URL_RE)]
      .filter((m) => said[m.index! + m[0].length] !== '{') // a template in code (…/${key}, …/{KEY}): no page
      .map((m) => trimUrl(m[0]))
      .filter(pinnable),
    5
  )

  // a prompt row is its first line, cut at 300 characters: a pasted wall of text on one
  // line would otherwise swell every answer toward Orca's 1 MiB limit
  const prompts = msgs
    .filter(
      (m) =>
        m.role === 'user' &&
        !m.toolResults.length &&
        m.text &&
        !/^(<|\[Request interrupted)/.test(m.text) // engine-written, not typed
    )
    .map((m) => cut(m.text.split('\n')[0] ?? '', 300))
    .slice(-20)

  // under the root, not beside it: /repo-feat is not /repo
  const tag = (p: string): Doc['tag'] =>
    /scratchpad|^\/(private\/)?tmp\//.test(p) ? 'tmp' : p.startsWith(root.replace(/\/$/, '') + '/') ? 'repo' : 'out'
  // the docs Write created and Read opened (an Edit alone does not list one)
  const docMap = new Map<string, Doc>()
  for (const m of msgs)
    for (const t of m.toolUses) {
      const p = String(t.input.file_path ?? '')
      if (!p.endsWith('.md')) continue
      if (t.tool === 'Write') {
        docMap.delete(p) // a Map keeps a key where it was first set: written now, it moves last
        docMap.set(p, { path: p, kind: 'new', tag: tag(p) })
      } else if (t.tool === 'Read' && !docMap.has(p)) docMap.set(p, { path: p, kind: 'ref', tag: tag(p) })
    }
  const docs = [...docMap.values()].slice(-6)

  // background Bash: its result names the task and output file; a later
  // <task-notification> carrying its tool-use-id says how it ended. The notice can
  // arrive inside a tool result, so this reads tool output too.
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

// a running task's log: its exit if it ended, else the port it serves.
// ponytail: no notification and no exit line = running, so a task whose shell died with
// Claude Code reads running while its log file stays (a missing one reads lost in the
// worker); check the task's pid if stale ◐ rows matter
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
  const all = [intent.initial, ...(Array.isArray(intent.history) ? intent.history : [])]
  // parent by index, always an earlier entry: no cycle even if two ts collide.
  // A label the file holds as no string (a number, none) reads as one.
  const nodes: TreeNode[] = all.map((n, i) => ({ key: `i${i}`, label: String(n.label ?? '') }))
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
