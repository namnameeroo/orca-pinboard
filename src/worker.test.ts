// Runs src/worker.ts's activate(orca) over a mock host. snap.get reads a fixture home:
// HOME points at a temp folder for the test (homedir() follows it), and the fixture names
// no PR, so gh never runs. The success paths of clip.copy and doc.open are left out: they
// would write the clipboard or open an app on the machine running the tests.
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { slug } from './scan'
import * as main from './worker'

const line = (o: object) => JSON.stringify(o)
const bgUse = (id: string, out: string, command: string) => [
  line({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command, run_in_background: true } }]
    }
  }),
  line({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `tu-${id}`,
          content: `Command running in background with ID: ${id}. Output is being written to: ${out}. You will be notified when it completes.`
        }
      ]
    }
  })
]

const CTX = { workspaceId: 'ctx-1', branch: 'feat/WEB-9', displayName: 'ws', terminals: [] }

// a home with the workspace's transcripts; `ws` is the workspace path
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'orca-pinboard-')))
  const ws = join(home, 'ws')
  const dir = join(home, '.claude', 'projects', slug(ws))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'old.jsonl'), line({ type: 'user', message: { role: 'user', content: 'old prompt' } }))
  await writeFile(join(home, 'done.output'), 'ok\n[exited with code 0]\n')
  await writeFile(join(home, 'big.output'), 'x'.repeat(4 * 1024 * 1024) + '\n[exited with code 0]\n')
  await writeFile(
    join(dir, 'new.jsonl'),
    [
      line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'new prompt' }] } }),
      ...bgUse('b1', join(home, 'done.output'), 'pnpm build'),
      ...bgUse('b2', join(home, 'gone.output'), 'pnpm dev --port 5180'),
      ...bgUse('b3', join(home, 'big.output'), 'pnpm dev --port 5181')
    ].join('\n')
  )
  await utimes(join(dir, 'old.jsonl'), 1_000_000, 1_000_000) // seconds: the old one is older
  await utimes(join(dir, 'new.jsonl'), 2_000_000, 2_000_000)
  await symlink('/nonexistent/orca-pinboard.jsonl', join(dir, 'dangling.jsonl')) // a link to nothing
  return { home, ws, dir }
}

const hostFor = (ws: string) =>
  mockHost({
    results: {
      'workspace.readContext': CTX,
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'worktree', name: 'ws', path: ws, branch: 'feat/WEB-9', hostId: 'local' }],
        truncated: false
      }
    },
    settings: { jiraBase: 'https://x.atlassian.net/', jiraProjects: 'WEB' }
  })

async function withHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env.HOME
  process.env.HOME = home
  try {
    return await body()
  } finally {
    process.env.HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

test('snap.get reads the newest transcript of the focused workspace', async () => {
  const { home, ws } = await fixture()
  await withHome(home, async () => {
    const worker = await mountWorker(main, { host: hostFor(ws) })
    const { snap } = await worker.request('snap.get')
    assert.ok(snap)
    assert.equal(snap.sid, 'new') // the newest by mtime; the dangling link is passed over
    assert.equal(snap.writtenAt, 2_000_000_000)
    assert.equal(snap.workspaceId, 'w1')
    assert.deepEqual(snap.prompts, ['new prompt'])
    assert.deepEqual(
      snap.bg.map((b) => [b.id, b.status, b.port]),
      [
        ['b1', 'completed', undefined], // its log ends with the exit line
        ['b2', 'lost', undefined], // its log is gone: no live port is claimed
        ['b3', 'running', 5181] // over 4 MiB, not read: running, the port from its command
      ]
    )
    assert.deepEqual(snap.jira, [{ key: 'WEB-9', url: 'https://x.atlassian.net/browse/WEB-9' }])
    assert.deepEqual(snap.tree, []) // no intent file
    await worker.deactivate()
  })
})

test('a broken intent file empties the work card alone, and says so in the log', async () => {
  const { home, ws } = await fixture()
  await mkdir(join(home, '.claude', 'intent'), { recursive: true })
  await writeFile(join(home, '.claude', 'intent', 'new.json'), '{broken')
  await withHome(home, async () => {
    const worker = await mountWorker(main, { host: hostFor(ws) })
    const { snap } = await worker.request('snap.get')
    assert.deepEqual(snap?.tree, [])
    assert.equal(snap?.sid, 'new')
    assert.ok(worker.logs.some((l) => /intent/.test(l)), worker.logs.join('\n'))
    await worker.deactivate()
  })
})

test('no transcript: the note names the folder it looked in', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'orca-pinboard-')))
  await withHome(home, async () => {
    const worker = await mountWorker(main, { host: hostFor(join(home, 'ws')) })
    const r = await worker.request('snap.get')
    assert.equal(r.snap, null)
    assert.match(r.note ?? '', new RegExp(`~/\\.claude/projects/${slug(join(home, 'ws'))}`))
    await worker.deactivate()
  })
})

test('a failure answers why, and logs it, instead of throwing', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': CTX,
      'workspace.list': () => {
        throw hostError('unavailable', 'the runtime is starting')
      }
    }
  })
  const worker = await mountWorker(main, { host })
  const r = await worker.request('snap.get')
  assert.equal(r.snap, null)
  assert.match(r.error ?? '', /the runtime is starting/)
  assert.ok(worker.logs.some((l) => /the runtime is starting/.test(l)))
  await worker.deactivate()
})

test('no focused workspace: a note, before any other host call', async () => {
  const host = mockHost({ results: { 'workspace.readContext': null } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('snap.get'), { snap: null, note: '포커스된 워크스페이스가 없습니다.' })
  assert.equal(host.callsOf('workspace.list').length, 0)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

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
