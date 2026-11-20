// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Snap } from './scan'

const SNAP: Snap = {
  workspace: 'toys',
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
  links: [],
  tree: [{ key: 'i0', label: '포팅', children: [{ key: 'i1', label: '패널', icon: 'next' }] }],
  current: 'i1',
  prompts: ['첫 프롬프트', '둘째 프롬프트'],
  docs: [{ path: '/Users/me/Desktop/toys/docs/plan.md', kind: 'new', tag: 'repo' }],
  bg: [
    { id: 'b1', label: 'dev server', command: 'pnpm dev', status: 'running', out: '/tmp/b1', port: 5180 }
  ],
  at: Date.now()
}

test('draws the session as cards', async () => {
  const view = await mount(panel, { host: mockHost({ requests: { 'snap.get': () => ({ snap: SNAP }) } }) })
  assert.ok(view.find({ text: '⎇ feat/WEB-9' }))
  assert.ok(view.find({ text: '~/Desktop/toys' })) // home as ~, never cut
  assert.ok(view.find({ text: '[open]' }))
  assert.equal(view.findAll({ text: '◐' }).length, 2) // the PR's CI and the running task
  assert.ok(view.find({ text: '승인' }))
  assert.ok(view.find({ text: 'localhost:5180' }))
  assert.ok(view.find({ text: 'WEB-9' }))
  assert.deepEqual(view.expandedOf({ label: '작업 트리' }), ['i0', 'i1'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('says why when there is no session, and retries on the button', async () => {
  let snap: Snap | null = null
  const view = await mount(panel, {
    host: mockHost({ requests: { 'snap.get': () => ({ snap, note: '포커스된 워크스페이스가 없습니다.' }) } })
  })
  // the note is the EmptyState's description, a prop rather than a text node
  assert.match(JSON.stringify(view.tree()), /포커스된 워크스페이스가 없습니다\./)
  snap = SNAP
  await view.press({ label: '새로고침' })
  assert.ok(view.find({ text: '⎇ feat/WEB-9' }))
  await view.unmount()
})

test('an agent event refreshes; the memo persists per workspace', async () => {
  let branch = 'main'
  const view = await mount(panel, {
    host: mockHost({ requests: { 'snap.get': () => ({ snap: { ...SNAP, branch } }) } })
  })
  branch = 'next'
  await view.emit('agent.status.changed', { workspaceId: 'w', paneKey: 'p', state: 'done', receivedAt: 1 })
  assert.ok(view.find({ text: '⎇ next' }))
  await view.type({ label: '한줄메모' }, '배포 전 확인')
  assert.equal(view.persisted.workspace.memo, '배포 전 확인')
  await view.unmount()
})

test('copies the session id and opens a doc through the worker', async () => {
  const asked: unknown[] = []
  const view = await mount(panel, {
    host: mockHost({
      requests: {
        'snap.get': () => ({ snap: SNAP }),
        'clip.copy': (input) => (asked.push(['copy', input]), { ok: true }),
        'doc.open': (input) => (asked.push(['open', input]), { ok: false, error: '파일이 없습니다' })
      }
    })
  })
  await view.press({ label: '세션 id 복사' })
  assert.ok(view.find({ text: '세션 id 복사됨' }))
  await view.press({ type: 'ListItem' }) // the one doc; a ListItem's title is a prop, not a text node
  assert.ok(view.find({ text: '열기 실패: 파일이 없습니다 (docs/plan.md)' }))
  assert.deepEqual(asked, [
    ['copy', { text: SNAP.sid }], // the whole id, never cut
    ['open', { path: SNAP.docs[0]!.path }] // the real path, not the shortened label
  ])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('a failed request reads as a note, not a crash', async () => {
  const view = await mount(panel, {
    host: mockHost({
      requests: {
        'snap.get': () => {
          throw Object.assign(new Error('boom'), { code: 'action_failed' })
        }
      }
    })
  })
  assert.match(JSON.stringify(view.tree()), /불러오지 못했습니다: action_failed/)
  await view.unmount()
})
