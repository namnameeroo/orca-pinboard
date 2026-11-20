// Runs src/worker.ts's activate(orca) over a mock host. The file reading itself is
// checked against a real Orca with `orca plugin dev request . snap.get`.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('no focused workspace: a note, no files read', async () => {
  const worker = await mountWorker(main, { host: mockHost({ results: { 'workspace.readContext': null } }) })
  assert.deepEqual(await worker.request('snap.get'), { snap: null, note: '포커스된 워크스페이스가 없습니다.' })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

// only the refusals: a passing open would start an app on the machine running the test
test('doc.open refuses a relative or missing path before running anything', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  assert.deepEqual(await worker.request('doc.open', { path: 'docs/plan.md' }), {
    ok: false,
    error: '절대 경로가 아닙니다'
  })
  assert.deepEqual(await worker.request('doc.open', { path: '/nonexistent/orca-pinboard/x.md' }), {
    ok: false,
    error: '파일이 없습니다'
  })
  await worker.deactivate()
})

test('a remote workspace is named, not read', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'web', terminals: [] },
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'worktree', name: 'web', path: '/srv/web', branch: 'main', hostId: 'ssh:box' }
        ],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('snap.get'), {
    snap: null,
    note: '원격 워크스페이스는 아직 지원하지 않습니다.'
  })
  await worker.deactivate()
})
