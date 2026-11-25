// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
// Orca fires workspace.changed once as the panel subscribes: open() stands in for that.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Snap } from './scan'

const SNAP: Snap = {
  workspace: 'toys',
  workspaceId: 'w1',
  cwd: '/Users/me/Desktop/toys',
  home: '/Users/me',
  sid: '0f10eec9-ff6c-4528-9527-67f2ab6686f2',
  branch: 'feat/WEB-9',
  worktree: '',
  prs: [
    {
      number: 12,
      title: 'Port pinboard',
      state: 'OPEN',
      review: 'APPROVED',
      checks: '◐',
      comments: 2,
      url: 'https://github.com/acme/web/pull/12'
    }
  ],
  jira: [{ key: 'WEB-9', url: 'https://acme.atlassian.net/browse/WEB-9' }],
  links: ['https://acme.atlassian.net/wiki/x'],
  tree: [{ key: 'i0', label: '포팅', children: [{ key: 'i1', label: '패널', icon: 'next' }] }],
  current: 'i1',
  prompts: ['첫 프롬프트', '둘째 프롬프트'],
  docs: [{ path: '/Users/me/Desktop/toys/docs/plan.md', kind: 'new', tag: 'repo' }],
  bg: [{ id: 'b1', label: 'dev server', command: 'pnpm dev', status: 'running', out: '/tmp/b1', port: 5180 }],
  writtenAt: Date.now() - 3 * 86_400_000,
  at: Date.now()
}
const CONTEXT = { workspaceId: 'ctx-1', branch: 'feat/WEB-9', displayName: 'toys', terminals: [] }
const AGENT = { workspaceId: 'ctx-1', paneKey: 'p', state: 'done' as const, receivedAt: 1 }

type Requests = NonNullable<Parameters<typeof mockHost>[0]>['requests']
async function open(requests: Requests, emit = true) {
  const host = mockHost({ requests })
  const view = await mount(panel, { host })
  if (emit) await view.emit('workspace.changed', { context: CONTEXT })
  return { host, view }
}

test('draws the session as cards', async () => {
  const { view } = await open({ 'snap.get': () => ({ snap: SNAP }) })
  assert.ok(view.find({ text: '⎇ feat/WEB-9' }))
  assert.ok(view.find({ text: '~/Desktop/toys' })) // home as ~, never cut
  assert.ok(view.find({ text: '[open]' }))
  assert.ok(view.find({ text: '승인' }))
  assert.ok(view.find({ text: 'localhost:5180' }))
  assert.ok(view.find({ text: 'WEB-9' }))
  assert.ok(view.find({ text: 'acme.atlassian.net/wiki/x' })) // a link, its scheme left off
  // when the transcript was written: an old session reads old, not "now"
  assert.equal(view.find({ type: 'RelativeTime' })?.props.at, SNAP.writtenAt)
  assert.deepEqual(view.expandedOf({ label: '작업 트리' }), ['i0', 'i1'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('opening the panel asks the worker once', async () => {
  const { host, view } = await open({ 'snap.get': () => ({ snap: SNAP }) })
  assert.equal(host.callsOf('plugin.request').length, 1)
  await view.unmount()
})

test('before any answer the spinner has a refresh button', async () => {
  const { view } = await open({ 'snap.get': () => ({ snap: SNAP }) }, false) // no subscribe-time event
  assert.ok(view.find({ type: 'Spinner' }))
  await view.press({ label: '새로고침' })
  assert.ok(view.find({ text: '⎇ feat/WEB-9' }))
  await view.unmount()
})

test('says why when there is no session, and retries on the button', async () => {
  let snap: Snap | null = null
  const { view } = await open({
    'snap.get': () => (snap ? { snap } : { snap: null, note: '포커스된 워크스페이스가 없습니다.' })
  })
  assert.equal(view.find({ type: 'EmptyState' })?.props.description, '포커스된 워크스페이스가 없습니다.')
  snap = SNAP
  await view.press({ label: '새로고침' })
  assert.ok(view.find({ text: '⎇ feat/WEB-9' }))
  await view.unmount()
})

test('a failed refresh keeps the cards and says why, at the top and on the session card', async () => {
  let fail: 'throw' | 'answer' | 'empty' | null = null
  const { view } = await open({
    'snap.get': () => {
      if (fail === 'throw') throw hostError('timeout', 'the worker took too long')
      if (fail === 'answer') return { snap: null, error: 'EACCES: permission denied' }
      if (fail === 'empty') return { snap: null, error: '' }
      return { snap: SNAP }
    }
  })
  fail = 'throw'
  await view.press({ label: '새로고침' })
  assert.ok(view.find({ text: '⎇ feat/WEB-9' })) // the last answer stays
  assert.ok(view.find({ text: '새로고침 실패: the worker took too long' })) // its message, not only its code
  assert.ok(view.find({ text: /갱신 실패/ })) // beside the ⟳ time too: the cards are stale
  fail = 'answer'
  await view.press({ label: '새로고침' })
  assert.ok(view.find({ text: '⎇ feat/WEB-9' }))
  assert.ok(view.find({ text: '새로고침 실패: EACCES: permission denied' }))
  fail = 'empty' // an error with no words is still an error
  await view.press({ label: '새로고침' })
  assert.ok(view.find({ text: '⎇ feat/WEB-9' }))
  assert.ok(view.find({ text: /새로고침 실패/ }))
  fail = null
  await view.press({ label: '새로고침' })
  assert.equal(view.find({ text: /새로고침 실패|갱신 실패/ }), null)
  await view.unmount()
})

test('a first load that fails says why instead of spinning', async () => {
  const { view } = await open({
    'snap.get': () => {
      throw Object.assign(new Error('boom'), { code: 'action_failed' })
    }
  })
  const empty = view.find({ type: 'EmptyState' })
  assert.equal(empty?.label, '불러오지 못했습니다')
  assert.equal(empty?.props.description, 'boom')
  await view.unmount()
})

test("a refresh that fails right after a workspace switch shows nothing of the old workspace's", async () => {
  let calls = 0
  let fail = false
  const { view } = await open({
    'snap.get': () => {
      calls++
      if (fail) throw hostError('unavailable', 'the worker is restarting')
      return { snap: SNAP }
    }
  })
  fail = true
  await view.emit('workspace.changed', { context: { ...CONTEXT, workspaceId: 'ctx-2', displayName: 'web' } })
  assert.equal(view.find({ text: '⎇ feat/WEB-9' }), null)
  assert.equal(view.find({ label: '한줄메모' }), null) // no memo under the old workspace's name
  assert.equal(view.find({ type: 'EmptyState' })?.label, '불러오지 못했습니다')
  const before = calls
  await view.emit('agent.status.changed', { ...AGENT, workspaceListId: 'w-web' }) // the focused one's agent
  assert.equal(calls, before + 1)
  await view.unmount()
})

test('an answer for the old workspace that lands after a switch is dropped', async () => {
  let calls = 0
  const { view } = await open({
    'snap.get': () => {
      calls++
      if (calls === 2) {
        // the focus moves while this request for the old workspace runs
        panel.onWorkspaceChanged({ workspaceId: 'ctx-3' })
        return { snap: SNAP }
      }
      if (calls === 3) throw hostError('unavailable', 'the worker is restarting')
      return { snap: SNAP }
    }
  })
  await view.press({ label: '새로고침' })
  await view.settled()
  assert.equal(calls, 3)
  assert.equal(view.find({ text: '⎇ feat/WEB-9' }), null) // not the old workspace's cards
  await view.unmount()
})

test('agent events refresh only for the workspace shown; a workspace switch always does', async () => {
  let calls = 0
  let branch = 'main'
  const { view } = await open({ 'snap.get': () => (calls++, { snap: { ...SNAP, branch } }) })
  assert.equal(calls, 1)
  await view.emit('agent.status.changed', { ...AGENT, workspaceListId: 'other' })
  assert.equal(calls, 1) // an agent elsewhere changes nothing here
  branch = 'next'
  await view.emit('agent.status.changed', { ...AGENT, workspaceListId: 'w1' })
  assert.equal(calls, 2)
  assert.ok(view.find({ text: '⎇ next' }))
  await view.emit('agent.status.changed', AGENT) // no list id to tell: refresh
  assert.equal(calls, 3)
  await view.emit('workspace.changed', { context: { ...CONTEXT, displayName: 'web' } })
  assert.equal(calls, 4)
  await view.unmount()
})

test('requests asked for while one runs fold into one more', async () => {
  let calls = 0
  const { view } = await open({
    'snap.get': () => {
      calls++
      if (calls === 2) {
        void panel.refresh()
        void panel.refresh()
      }
      return { snap: { ...SNAP, branch: `b${calls}` } }
    }
  })
  await view.press({ label: '새로고침' })
  await view.settled()
  assert.equal(calls, 3) // the two asked for during the second ran once, after it
  assert.ok(view.find({ text: '⎇ b3' }))
  await view.unmount()
})

test('the memo persists per workspace', async () => {
  const { view } = await open({ 'snap.get': () => ({ snap: SNAP }) })
  await view.type({ label: '한줄메모' }, '배포 전 확인')
  assert.equal(view.persisted.workspace.memo, '배포 전 확인')
  await view.unmount()
})

test('a PR gh could not read says so; a task that ended or vanished draws dim', async () => {
  const { port: _, ...quiet } = SNAP.bg[0]! // no port key: undefined is no JSON value
  const { view } = await open({
    'snap.get': () => ({
      snap: {
        ...SNAP,
        prs: [{ ...SNAP.prs[0]!, state: 'UNKNOWN', checks: '', review: '', comments: 0, error: 'gh auth login' }],
        bg: [
          { ...quiet, id: 'b2', status: 'killed', label: 'stopped one' },
          { ...quiet, id: 'b3', status: 'lost', label: 'vanished one' },
          { ...quiet, id: 'b4', status: 'failed', label: 'failed one' }
        ]
      }
    })
  })
  assert.ok(view.find({ text: '[?]' }))
  assert.ok(view.find({ text: 'gh 실패: gh auth login' }))
  const marks = (t: string) => view.findAll({ type: 'Text', text: t }).map((e) => [e.props.tone, e.props.muted])
  assert.deepEqual(marks('✗'), [
    [undefined, true], // killed: a dim ✗, not a failure
    ['danger', false] // failed: a red ✗
  ])
  assert.deepEqual(marks('?'), [[undefined, true]]) // lost
  assert.equal(view.find({ text: 'localhost:5180' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('an intent file that could not be read is said on the work card', async () => {
  const { view } = await open({ 'snap.get': () => ({ snap: { ...SNAP, tree: [], current: '', intentError: 'Unexpected token' } }) })
  assert.ok(view.find({ text: '읽지 못함' }))
  await view.unmount()
})

test('copies the session id and opens a doc through the worker', async () => {
  const asked: unknown[] = []
  let how: 'opened' | 'revealed' = 'opened'
  const { view } = await open({
    'snap.get': () => ({ snap: SNAP }),
    'clip.copy': (input) => (asked.push(['copy', input]), { ok: true }),
    'doc.open': (input) => (asked.push(['open', input]), { ok: true, how })
  })
  await view.press({ label: '세션 id 복사' })
  assert.ok(view.find({ text: '세션 id 복사됨' }))
  await view.press({ label: 'docs/plan.md' }) // a ListItem's title is its label
  assert.ok(view.find({ text: '열림: docs/plan.md' }))
  how = 'revealed'
  await view.press({ label: 'docs/plan.md' })
  assert.ok(view.find({ text: 'Finder에서 표시: docs/plan.md' }))
  assert.deepEqual(asked.slice(0, 2), [
    ['copy', { text: SNAP.sid }], // the whole id, never cut
    ['open', { path: SNAP.docs[0]!.path }] // the real path, not the shortened label
  ])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('a copy or an open that fails says why, its message first', async () => {
  const { view } = await open({
    'snap.get': () => ({ snap: SNAP }),
    'clip.copy': () => {
      throw hostError('timeout', 'the worker took too long')
    },
    'doc.open': () => ({ ok: false, error: '파일이 없습니다' })
  })
  await view.press({ label: '세션 id 복사' })
  assert.ok(view.find({ text: '복사 실패: the worker took too long' }))
  await view.press({ label: 'docs/plan.md' })
  assert.ok(view.find({ text: '열기 실패: 파일이 없습니다 (docs/plan.md)' }))
  await view.unmount()
})
