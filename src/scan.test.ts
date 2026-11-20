import { assert, test } from 'orca/testing'
import { bgFromLog, intentTree, jiraMatcher, rollup, scan, slug, toMessages } from './scan'

const line = (o: object) => JSON.stringify(o)
const user = (content: unknown, extra: object = {}) => line({ type: 'user', message: { role: 'user', content }, ...extra })
const asst = (content: unknown[]) => line({ type: 'assistant', message: { role: 'assistant', content } })

const JSONL = [
  line({ type: 'mode', mode: 'auto' }), // not a message
  user([{ type: 'text', text: 'PR 올려줘\n둘째 줄' }]),
  user('Base directory for this skill: …', { isMeta: true }), // a skill body, not typed
  user('<command-name>/clear</command-name>'), // engine-written
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

test('reads the transcript as messages, results attached to their calls', () => {
  const msgs = toMessages(JSONL)
  assert.equal(msgs.length, 4) // meta and non-message lines dropped, the cut line skipped
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

test('a running task reads its exit, else its port', () => {
  const b = scan(toMessages(JSONL), '/repo', '').bg[0]!
  assert.equal(bgFromLog(b, 'ready\n[exited with code 1]\n').status, 'failed')
  assert.equal(bgFromLog(b, 'Local: http://localhost:5173/').port, 5173)
  assert.equal(bgFromLog(b, '').port, 5180) // from the command
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

test('slug, Jira keys and CI rollup', () => {
  assert.equal(slug('/Users/me/Desktop/toys'), '-Users-me-Desktop-toys')
  assert.equal(slug('/a/b.c_d'), '-a-b-c-d')
  assert.equal(jiraMatcher(''), null)
  assert.deepEqual('GPT-4 CVE-2024 WEB-12'.match(jiraMatcher('WEB')!), ['WEB-12'])
  assert.equal(rollup([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }]), '●')
  assert.equal(rollup([{ conclusion: 'SUCCESS' }, { state: 'PENDING' }]), '◐')
  assert.equal(rollup([{ conclusion: 'FAILURE' }]), '✗')
  assert.equal(rollup([]), '')
})
