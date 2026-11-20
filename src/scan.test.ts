import { assert, test } from 'orca/testing'
import {
  bgFromLog,
  intentTree,
  jiraMatcher,
  openPlan,
  rollup,
  scan,
  slug,
  toMessages,
  toPr,
  type Msg,
  type ToolUse
} from './scan'

const line = (o: object) => JSON.stringify(o)
const user = (content: unknown, extra: object = {}) => line({ type: 'user', message: { role: 'user', content }, ...extra })
const asst = (content: unknown[]) => line({ type: 'assistant', message: { role: 'assistant', content } })

const JSONL = [
  line({ type: 'mode', mode: 'auto' }), // not a message
  user([{ type: 'text', text: 'PR 올려줘\n둘째 줄' }]),
  user('Base directory for this skill: …', { isMeta: true }), // a skill body, not typed
  user('<command-name>/clear</command-name>'), // engine-written
  user([{ type: 'text', text: 'a subagent prompt' }], { isSidechain: true }), // a subagent's, not this session's
  asst([
    { type: 'text', text: 'see https://github.com/acme/web/pull/12 and https://acme.atlassian.net/browse/WEB-7' },
    { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/repo/docs/plan.md' } },
    { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/private/tmp/x/scratchpad/n.md' } },
    {
      type: 'tool_use',
      id: 't3',
      name: 'Bash',
      input: { command: 'pnpm dev --port 5180', run_in_background: true, description: 'dev server' }
    }
  ]),
  user([
    { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
    { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'body' }] },
    {
      type: 'tool_result',
      tool_use_id: 't3',
      content: 'Command running in background with ID: b9. Output is being written to: /tmp/b9.output.'
    }
  ]),
  '{"type":"user","message":{"cont' // cut mid-write
].join('\n')

// small fixtures, as in pinboard's own tests: one message each
const say = (text: string): Msg => ({ role: 'assistant', text, toolUses: [], toolResults: [] })
const said = (text: string): Msg => ({ role: 'user', text, toolUses: [], toolResults: [] })
const uses = (...toolUses: ToolUse[]): Msg => ({ role: 'assistant', text: '', toolUses, toolResults: [] })
const results = (...texts: string[]): Msg => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: texts.map((text) => ({ text }))
})
const doc = (tool: 'Read' | 'Write', file_path: string): ToolUse => ({ tool, tool_use_id: file_path, input: { file_path } })
const bgUse = (id: string, command: string, description?: string): ToolUse => ({
  tool: 'Bash',
  tool_use_id: `tu-${id}`,
  input: { command, description, run_in_background: true },
  text: `Command running in background with ID: ${id}. Output is being written to: /t/${id}.output. You will be notified when it completes.`
})
const notice = (id: string, status: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>tu-${id}</tool-use-id>\n<output-file>/t/${id}.output</output-file>\n<status>${status}</status>\n</task-notification>`
const KEYS = jiraMatcher('WEB,APP,DATA,OPS,PM')

test('reads the transcript as messages, results attached to their calls', () => {
  const msgs = toMessages(JSONL)
  assert.equal(msgs.length, 4) // meta, sidechain and non-message lines dropped, the cut line skipped
  const bash = msgs[2]!.toolUses[2]!
  assert.match(bash.text ?? '', /background with ID: b9/)
  assert.equal(msgs[3]!.toolResults[1]!.text, 'body')
})

test('scans prompts, PRs, Jira, links, docs and background tasks', () => {
  const s = scan(toMessages(JSONL), '/repo', 'feat/WEB-9-x', jiraMatcher('web, app'))
  assert.deepEqual(s.prompts, ['PR 올려줘'])
  assert.deepEqual(s.prRefs, ['acme/web#12'])
  assert.deepEqual(s.jira, ['WEB-7', 'WEB-9']) // the branch's key last
  assert.deepEqual(s.links, ['https://acme.atlassian.net/browse/WEB-7'])
  assert.deepEqual(
    s.docs.map((d) => [d.path, d.kind, d.tag]),
    [
      ['/repo/docs/plan.md', 'new', 'repo'],
      ['/private/tmp/x/scratchpad/n.md', 'ref', 'tmp']
    ]
  )
  assert.deepEqual(
    s.bg.map((b) => [b.id, b.out, b.label, b.status]),
    [['b9', '/tmp/b9.output', 'dev server', 'running']]
  )
})

// ported from pinboard's tests: "scan picks PRs, Jira keys, links and touched .md"
test('a bare domain is no link; the artifact URL form is; an interrupt is no prompt', () => {
  const r = scan(
    [
      said('https://github.com/acme/web/pull/45 리뷰 반영'),
      said('[Request interrupted by user]'),
      {
        ...say(
          'WEB-123 확인. ADR-0001 참고. https://acme.atlassian.net 기획: https://acme.atlassian.net/wiki/x 설명: https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000000'
        ),
        toolUses: [doc('Write', '/repo/docs/plan.md'), doc('Read', '/repo/README.md'), doc('Read', '/repo/src/a.ts')]
      }
    ],
    '/repo',
    'feat/WEB-123-x',
    KEYS
  )
  assert.deepEqual(r.prRefs, ['acme/web#45'])
  assert.deepEqual(r.jira, ['WEB-123'])
  assert.deepEqual(r.links, [
    'https://acme.atlassian.net/wiki/x',
    'https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000000'
  ])
  assert.deepEqual(
    r.docs.map((d) => [d.path, d.kind, d.tag]),
    [
      ['/repo/docs/plan.md', 'new', 'repo'],
      ['/repo/README.md', 'ref', 'repo']
    ]
  )
  assert.deepEqual(r.prompts, ['https://github.com/acme/web/pull/45 리뷰 반영'])
})

// ported: "scan pairs a background Bash with its notification; a foreground one is not a task"
test('a background Bash pairs with its notification; a foreground one is no task', () => {
  const r = scan(
    [
      uses(bgUse('b1', 'pnpm dev', 'dev 서버'), bgUse('b2', 'pnpm test\n--watch'), {
        tool: 'Bash',
        tool_use_id: 'tu-x',
        input: { command: 'ls' },
        text: 'a.md'
      }),
      said(notice('b2', 'failed'))
    ],
    '/repo',
    'main'
  )
  assert.deepEqual(
    r.bg.map((b) => [b.id, b.label, b.status]),
    [
      ['b1', 'dev 서버', 'running'],
      ['b2', 'pnpm test', 'failed'] // no description: the command's first line
    ]
  )
})

// ported R7
test('a task notification inside another tool result still ends its task', () => {
  const r = scan([uses(bgUse('b3', 'pnpm build')), results(`ok\n${notice('b3', 'completed')}`)], '/repo', 'main')
  assert.equal(r.bg[0]?.status, 'completed')
})

// ported R3
test('PRs, Jira keys and links keep the most recent; the branch key always stays', () => {
  const r = scan(
    [
      say('https://github.com/o/r/pull/1 WEB-1 https://x.atlassian.net/wiki/1'),
      ...[2, 3, 4, 5, 6].map((n) => say(`https://github.com/o/r/pull/${n} WEB-${n} https://x.atlassian.net/wiki/${n}`)),
      say('https://github.com/o/r/pull/1 again') // mentioned again: recent now
    ],
    '/repo',
    'feat/APP-9-x',
    KEYS
  )
  assert.deepEqual(r.prRefs, ['o/r#3', 'o/r#4', 'o/r#5', 'o/r#6', 'o/r#1'])
  assert.deepEqual(r.jira, ['WEB-5', 'WEB-6', 'APP-9'])
  assert.equal(r.links.at(-1), 'https://x.atlassian.net/wiki/6')
})

// ported R4, plus a key that would break the RegExp
test('Jira keys: the configured projects only; none configured, none picked', () => {
  const msgs = [say('GPT-4, CVE-2024-1234, ECMA-262, UTF-8 vs DATA-1476 · OPS-7 · PM-8')]
  assert.deepEqual(scan(msgs, '/repo', 'main', KEYS).jira, ['DATA-1476', 'OPS-7', 'PM-8'])
  assert.deepEqual(scan(msgs, '/repo', 'main').jira, [])
  assert.equal(jiraMatcher(' , 1A, a-b, W(B'), null) // nothing a project key can be
})

// ported R6
test('PRs, Jira keys and links come from message text, not tool output', () => {
  const dump = 'https://x.atlassian.net/wiki/1 https://github.com/o/r/pull/9 OPS-3'
  const r = scan(
    [
      said('https://github.com/acme/web/pull/45 리뷰 반영'),
      {
        ...say('WEB-7 생성: https://acme.atlassian.net/browse/WEB-7'),
        toolUses: [{ tool: 'Bash', tool_use_id: 'tu-g', input: { command: 'grep -rn https tests' }, text: dump }]
      },
      results(dump),
      // a slash command's arguments: typed, though the engine wraps them in tags
      said(
        '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>https://github.com/acme/web/pull/46 https://acme.atlassian.net/wiki/y</command-args>'
      )
    ],
    '/repo',
    'main',
    KEYS
  )
  assert.deepEqual(r.prRefs, ['acme/web#45', 'acme/web#46'])
  assert.deepEqual(r.jira, ['WEB-7'])
  assert.deepEqual(r.links, ['https://acme.atlassian.net/browse/WEB-7', 'https://acme.atlassian.net/wiki/y'])
})

test('a link ends before trailing punctuation or a Korean particle', () => {
  const r = scan(
    [say('see https://acme.atlassian.net/browse/WEB-7. and https://www.notion.so/acme/Plan-abc123를 확인')],
    '/repo',
    'main'
  )
  assert.deepEqual(r.links, ['https://acme.atlassian.net/browse/WEB-7', 'https://www.notion.so/acme/Plan-abc123'])
})

test('a link is pinned by its host, not by a host name anywhere in it', () => {
  const r = scan(
    [say('https://evil.example/?figma.com https://figma.com.evil.example/x https://claude.ai/new https://www.figma.com/file/abc')],
    '/repo',
    'main'
  )
  assert.deepEqual(r.links, ['https://www.figma.com/file/abc'])
})

test('a PR mentioned in another letter case is one PR', () => {
  const r = scan([say('https://github.com/Acme/Web/pull/1 and https://github.com/acme/web/pull/1')], '/repo', 'main')
  assert.deepEqual(r.prRefs, ['acme/web#1'])
})

test('a doc written late stays in the list though it was read early', () => {
  const r = scan(
    [
      uses(doc('Read', '/repo/old.md')),
      uses(...[1, 2, 3, 4, 5, 6].map((n) => doc('Read', `/repo/d${n}.md`))),
      uses(doc('Write', '/repo/old.md'))
    ],
    '/repo',
    'main'
  )
  assert.equal(r.docs.length, 6)
  assert.deepEqual(r.docs.at(-1), { path: '/repo/old.md', kind: 'new', tag: 'repo' })
})

test('a sibling folder of the repo is not the repo', () => {
  const r = scan([uses(doc('Read', '/repo-feat/a.md'), doc('Read', '/repo/a.md'))], '/repo', 'main')
  assert.deepEqual(
    r.docs.map((d) => [d.path, d.tag]),
    [
      ['/repo-feat/a.md', 'out'],
      ['/repo/a.md', 'repo']
    ]
  )
})

test('a running task reads its exit, else its port', () => {
  const b = scan(toMessages(JSONL), '/repo', '').bg[0]!
  assert.equal(bgFromLog(b, 'ready\n[exited with code 1]\n').status, 'failed')
  assert.equal(bgFromLog(b, 'ready\n[exited with code 0]\n').status, 'completed')
  assert.equal(bgFromLog(b, 'Local: http://localhost:5173/').port, 5173)
  assert.equal(bgFromLog(b, '').port, 5180) // a log not read (too big): the port from the command
  assert.deepEqual(bgFromLog({ ...b, status: 'completed' }, 'localhost:1'), { ...b, status: 'completed' })
})

test('the intent record as a tree, the last entry current', () => {
  const { tree, current } = intentTree({
    initial: { ts: 'a', label: '포팅' },
    history: [
      { ts: 'b', label: '패널', parent: 'a' },
      { ts: 'c', label: '테스트', parent: 'b' },
      { ts: 'd', label: '다른 일', parent: null },
      { ts: 'e', label: '옛 기록' } // no parent field: under the first topic
    ]
  })
  assert.deepEqual(
    tree.map((n) => [n.label, (n.children ?? []).map((c) => c.label)]),
    [
      ['포팅', ['패널', '옛 기록']],
      ['다른 일', []]
    ]
  )
  assert.equal(tree[0]!.children![0]!.children![0]!.label, '테스트')
  assert.equal(current, 'i4')
  assert.deepEqual(intentTree(null), { tree: [], current: '' })
})

test('gh answers as a PR row: a closed draft is closed, comments a count', () => {
  const j = { number: 3, title: 't', reviewDecision: null, statusCheckRollup: [], url: 'u', comments: 2 }
  assert.deepEqual(toPr({ ...j, state: 'CLOSED', isDraft: true }), {
    number: 3,
    title: 't',
    state: 'CLOSED',
    review: '',
    checks: '',
    comments: 2,
    url: 'u'
  })
  assert.equal(toPr({ ...j, state: 'OPEN', isDraft: true }).state, 'DRAFT')
  assert.equal(toPr({ ...j, state: 'MERGED', isDraft: false }).state, 'MERGED')
  assert.equal(toPr({ ...j, state: 'SOMETHING_NEW', isDraft: false }).state, 'UNKNOWN')
})

test('a doc opens in its app only when its real path is a markdown file', () => {
  for (const p of ['/a/x.md', '/a/X.MARKDOWN']) assert.deepEqual(openPlan(p), { args: [p], how: 'opened' })
  for (const p of ['/a/x.md.command', '/a/x.command', '/a/Evil.app', '/a/x.md/'])
    assert.deepEqual(openPlan(p), { args: ['-R', p], how: 'revealed' })
})

test('slug, Jira keys and CI rollup', () => {
  assert.equal(slug('/Users/me/Desktop/toys'), '-Users-me-Desktop-toys')
  assert.equal(slug('/a/b.c_d'), '-a-b-c-d')
  assert.equal(jiraMatcher(''), null)
  assert.deepEqual('GPT-4 CVE-2024 WEB-12'.match(jiraMatcher('WEB')!), ['WEB-12'])
  assert.equal(rollup([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }]), '●')
  assert.equal(rollup([{ conclusion: 'SUCCESS' }, { state: 'PENDING' }]), '◐')
  assert.equal(rollup([{ conclusion: '', status: 'IN_PROGRESS' }]), '◐') // gh's running CheckRun
  assert.equal(rollup([{ conclusion: 'FAILURE' }]), '✗')
  assert.equal(rollup([]), '')
})

// ported P6, plus a required status not reported yet and a stale run
test('CI: a timed-out, cancelled, blocked, expected or stale check is not a pass', () => {
  for (const c of ['TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
    assert.equal(rollup([{ conclusion: 'SUCCESS' }, { conclusion: c }]), '✗')
  assert.equal(rollup([{ conclusion: 'SUCCESS' }, { state: 'EXPECTED' }]), '◐')
  assert.equal(rollup([{ conclusion: 'SUCCESS' }, { conclusion: 'STALE' }]), '◐')
})
