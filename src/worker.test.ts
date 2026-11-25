// Runs src/worker.ts's activate(orca) over a mock host. snap.get reads a fixture home:
// HOME points at a temp folder for each test (homedir() follows it), so no test reads the
// real ~/.claude. gh is stood in for through `deps.run`; the success paths of clip.copy
// and doc.open are left out: they would write the clipboard or open an app here.
// node:test runs a file's top-level tests one after another, which the HOME swap relies on.
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { slug } from './scan'
import * as main from './worker'
import { deps, planFor, reason, safePath } from './worker'

const line = (o: object) => JSON.stringify(o)
const said = (text: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
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
const MiB4 = 'x'.repeat(4 * 1024 * 1024)

// a temp home for the body; HOME is put back, and the folder removed, whatever happens
async function withHome<T>(body: (home: string) => Promise<T>): Promise<T> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'orca-pinboard-')))
  const saved = process.env.HOME
  process.env.HOME = home
  try {
    return await body(home)
  } finally {
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

// the workspace's transcripts under `home`; `lines` go into the newest one
async function fixture(home: string, lines: string[] = []) {
  const ws = join(home, 'ws')
  const dir = join(home, '.claude', 'projects', slug(ws))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'old.jsonl'), line({ type: 'user', message: { role: 'user', content: 'old prompt' } }))
  await writeFile(
    join(dir, 'new.jsonl'),
    [line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'new prompt' }] } }), ...lines].join(
      '\n'
    )
  )
  await utimes(join(dir, 'old.jsonl'), 1_000_000, 1_000_000) // seconds: the old one is older
  await utimes(join(dir, 'new.jsonl'), 2_000_000, 2_000_000)
  await symlink('/nonexistent/orca-pinboard.jsonl', join(dir, 'dangling.jsonl')) // a link to nothing
  return { ws, dir }
}

const hostFor = (ws: string, more: object[] = []) =>
  mockHost({
    results: {
      'workspace.readContext': CTX,
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'worktree', name: 'ws', path: ws, branch: 'feat/WEB-9', hostId: 'local' }, ...more],
        truncated: false
      }
    },
    settings: { jiraBase: 'https://x.atlassian.net/', jiraProjects: 'WEB' }
  })

test('snap.get reads the newest transcript of the focused workspace', async () => {
  await withHome(async (home) => {
    await writeFile(join(home, 'done.output'), 'ok\n[exited with code 0]\n')
    await writeFile(join(home, 'big.output'), `ready\n${MiB4}\n[exited with code 0]\n`)
    await writeFile(join(home, 'big-live.output'), `Local: http://localhost:7777/\n${MiB4}\n`)
    const { ws } = await fixture(home, [
      ...bgUse('b1', join(home, 'done.output'), 'pnpm build'),
      ...bgUse('b2', join(home, 'gone.output'), 'pnpm dev --port 5180'),
      ...bgUse('b3', join(home, 'big.output'), 'pnpm build --watch'),
      ...bgUse('b4', join(home, 'big-live.output'), 'pnpm dev --port 5182')
    ])
    const worker = await mountWorker(main, { host: hostFor(ws) })
    const r = await worker.request('snap.get')
    assert.ok(r.snap)
    const snap = r.snap
    assert.equal(snap.sid, 'new') // the newest by mtime; the dangling link is passed over
    assert.equal(snap.writtenAt, 2_000_000_000)
    assert.equal(snap.workspaceId, 'w1')
    assert.deepEqual(snap.prompts, ['new prompt'])
    assert.deepEqual(
      snap.bg.map((b) => [b.id, b.status, b.port]),
      [
        ['b1', 'completed', undefined], // its log ends with the exit line
        ['b2', 'lost', undefined], // its log is gone: no live port is claimed
        ['b3', 'completed', undefined], // over 4 MiB: its end is read, the exit line there
        ['b4', 'running', 7777] // over 4 MiB: its start is read, the port there
      ]
    )
    assert.deepEqual(snap.jira, [{ key: 'WEB-9', url: 'https://x.atlassian.net/browse/WEB-9' }])
    assert.deepEqual(snap.tree, []) // no intent file
    assert.equal(snap.intentError, undefined)
    await worker.deactivate()
  })
})

test('a broken intent file empties the work card, says it could not be read, and logs why', async () => {
  await withHome(async (home) => {
    const { ws } = await fixture(home)
    await mkdir(join(home, '.claude', 'intent'), { recursive: true })
    await writeFile(join(home, '.claude', 'intent', 'new.json'), '{broken')
    const worker = await mountWorker(main, { host: hostFor(ws) })
    const { snap } = await worker.request('snap.get')
    assert.deepEqual(snap?.tree, [])
    assert.ok(snap?.intentError)
    assert.ok(worker.logs.some((l) => /intent/.test(l)), worker.logs.join('\n'))
    await worker.deactivate()
  })
})

test('no transcript: the note names the folder it looked in', async () => {
  await withHome(async (home) => {
    const worker = await mountWorker(main, { host: hostFor(join(home, 'ws')) })
    const r = await worker.request('snap.get')
    assert.equal(r.snap, null)
    assert.match('note' in r ? r.note : '', new RegExp(`~/\\.claude/projects/${slug(join(home, 'ws'))}`))
    await worker.deactivate()
  })
})

test('a transcript folder that cannot be read is an error, not "no session"', async () => {
  await withHome(async (home) => {
    const ws = join(home, 'ws')
    await mkdir(join(home, '.claude', 'projects'), { recursive: true })
    await writeFile(join(home, '.claude', 'projects', slug(ws)), 'a file where the folder should be')
    const worker = await mountWorker(main, { host: hostFor(ws) })
    const r = await worker.request('snap.get')
    assert.equal(r.snap, null)
    assert.match('error' in r ? r.error : '', /ENOTDIR/)
    await worker.deactivate()
  })
})

test('a failure answers why, logs it with its stack, and never answers an empty why', async () => {
  await withHome(async () => {
    for (const [message, expected] of [
      ['the runtime is starting', /the runtime is starting/],
      ['', /\S/]
    ] as const) {
      const host = mockHost({
        results: {
          'workspace.readContext': CTX,
          'workspace.list': () => {
            throw hostError('unavailable', message)
          }
        }
      })
      const worker = await mountWorker(main, { host })
      const r = await worker.request('snap.get')
      assert.equal(r.snap, null)
      assert.match('error' in r ? r.error : '', expected)
      assert.ok(worker.logs.some((l) => /snap\.get/.test(l) && /\n\s+at /.test(l)), worker.logs.join('\n'))
      await worker.deactivate()
    }
  })
})

test('gh: a row per PR; a failure keeps the row with why; merged is not asked again, closed is', async () => {
  const saved = deps.run
  const asked: string[][] = []
  let second: 'fail' | 'open' | 'timeout' | 'garbage' | 'closed' = 'fail'
  deps.run = async (file, args) => {
    asked.push([file, ...args])
    const n = args[2]
    if (n === '1')
      return JSON.stringify({ number: 1, title: 'one', state: 'MERGED', url: 'https://github.com/gh-t/web/pull/1', comments: 2 })
    if (second === 'fail') throw new Error('Command failed: gh pr view 2 --repo gh-t/web\nHTTP 401: Bad credentials')
    if (second === 'timeout') throw Object.assign(new Error('Command failed: gh pr view 2\n'), { killed: true })
    if (second === 'garbage') return 'not json'
    return JSON.stringify({ number: 2, title: 'two', state: second === 'open' ? 'OPEN' : 'CLOSED', url: 'https://github.com/gh-t/web/pull/2' })
  }
  try {
    await withHome(async (home) => {
      const { ws } = await fixture(home, [said('https://github.com/gh-t/web/pull/1 and https://github.com/gh-t/web/pull/2')])
      const worker = await mountWorker(main, { host: hostFor(ws) })
      const rows = async () => ((await worker.request('snap.get')).snap?.prs ?? []).map((p) => [p.number, p.state, p.error])

      assert.deepEqual(await rows(), [
        [1, 'MERGED', undefined],
        [2, 'UNKNOWN', 'HTTP 401: Bad credentials'] // never answered: the link alone, and why
      ])
      assert.deepEqual(asked[0], [
        'gh',
        'pr',
        'view',
        '1',
        '--repo',
        'gh-t/web',
        '--json',
        'number,title,state,isDraft,reviewDecision,statusCheckRollup,url,comments',
        '--jq',
        '.comments |= length'
      ])
      second = 'open'
      assert.deepEqual(await rows(), [
        [1, 'MERGED', undefined],
        [2, 'OPEN', undefined]
      ])
      second = 'timeout'
      assert.deepEqual(await rows(), [
        [1, 'MERGED', undefined],
        [2, 'OPEN', '15초 안에 끝나지 않음'] // the last answer stays, marked
      ])
      second = 'garbage'
      assert.match(String((await rows())[1]![2]), /^gh 출력 해석 실패/)
      second = 'closed'
      await rows()
      second = 'open' // reopened: a closed PR is asked again
      assert.deepEqual((await rows())[1], [2, 'OPEN', undefined])
      assert.equal(asked.filter((a) => a[3] === '1').length, 1) // merged: asked once
      await worker.deactivate()
    })
  } finally {
    deps.run = saved
  }
})

test('a failing gh logs once until its reason changes', async () => {
  const saved = deps.run
  deps.run = async () => {
    throw new Error('Command failed: gh pr view 3\nerror connecting to api.github.com')
  }
  try {
    await withHome(async (home) => {
      const { ws } = await fixture(home, [said('https://github.com/gh-log/web/pull/3')])
      const worker = await mountWorker(main, { host: hostFor(ws) })
      for (let i = 0; i < 3; i++) await worker.request('snap.get')
      assert.equal(worker.logs.filter((l) => /gh-log\/web#3/.test(l)).length, 1)
      await worker.deactivate()
    })
  } finally {
    deps.run = saved
  }
})

test("why a command failed: a timeout says so; gh's stderr lines, not the command", () => {
  assert.equal(reason(Object.assign(new Error('Command failed: gh pr view 1\n'), { killed: true })), '15초 안에 끝나지 않음')
  const r = reason(
    new Error(
      'Command failed: gh pr view 1 --repo a/b\nTo get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.'
    )
  )
  assert.match(r, /gh auth login/)
  assert.ok(!/Command failed/.test(r))
  assert.ok(r.length <= 160)
  assert.equal(reason(new Error('spawn gh ENOENT')), 'spawn gh ENOENT')
})

test('PATH keeps absolute entries only, Homebrew appended', () => {
  assert.equal(safePath('.:/usr/bin::bin'), '/usr/bin:/opt/homebrew/bin:/usr/local/bin')
  assert.equal(safePath(undefined), '/opt/homebrew/bin:/usr/local/bin')
})

test('a doc opens in its app only when its real path is a markdown file', async () => {
  await withHome(async (home) => {
    await writeFile(join(home, 'a.md'), '# a')
    await writeFile(join(home, 'y.command'), 'echo hi')
    await symlink(join(home, 'y.command'), join(home, 'link.md')) // a .md that is a script
    await mkdir(join(home, 'd.md'))
    assert.deepEqual(await planFor(join(home, 'a.md')), { args: [join(home, 'a.md')], how: 'opened' })
    assert.deepEqual(await planFor(join(home, 'link.md')), { args: ['-R', join(home, 'y.command')], how: 'revealed' })
    assert.deepEqual(await planFor(join(home, 'd.md')), { args: ['-R', join(home, 'd.md')], how: 'revealed' })
    assert.deepEqual(await planFor('docs/plan.md'), { error: '절대 경로가 아닙니다' })
    assert.deepEqual(await planFor(join(home, 'none.md')), { error: '파일이 없습니다' })
  })
})

test('no focused workspace: a note, before any other host call', async () => {
  await withHome(async () => {
    const host = mockHost({ results: { 'workspace.readContext': null } })
    const worker = await mountWorker(main, { host })
    assert.deepEqual(await worker.request('snap.get'), { snap: null, note: '포커스된 워크스페이스가 없습니다.' })
    assert.equal(host.callsOf('workspace.list').length, 0)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  })
})

test('the workspace is found by its id, else by name and branch only when one matches', async () => {
  await withHome(async (home) => {
    const twin = { id: 'w2', kind: 'worktree', name: 'ws', path: '/elsewhere/ws', branch: 'feat/WEB-9', hostId: 'local' }
    const worker = await mountWorker(main, { host: hostFor(join(home, 'ws'), [twin]) })
    const r = await worker.request('snap.get')
    assert.equal(r.snap, null)
    assert.match('note' in r ? r.note : '', /하나로 정하지 못했습니다/)
    await worker.deactivate()
  })
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
  await withHome(async () => {
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
})
