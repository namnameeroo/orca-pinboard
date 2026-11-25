// The pinboard pane (pinboard in github.com/namnameeroo/claude-mods) as an Orca sidebar
// panel: read-only cards over the focused workspace's newest Claude session, plus a memo
// kept per workspace. Orca draws it in its own UI font, which has no Nerd Font glyphs:
// Orca's icons and plain Unicode marks.
import {
  atom,
  Card,
  Collapsible,
  EmptyState,
  IconButton,
  Link,
  List,
  ListItem,
  on,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  Textarea,
  Tree,
  type OrcaNode,
  type PanelContext,
  type PluginRequestOutput,
  type Tone
} from 'orca'
import './protocol'
import { CI, LOST, tilde, type Bg, type Pr, type TreeNode } from './scan'

type Answer = PluginRequestOutput<'snap.get'>
type Shown = Exclude<Answer, { error: string }>

// the last answer that read the focused workspace (a session, or a note why there is none)
const answer = atom<Shown | null>(null)
// why the last refresh failed; the answer before it stays shown (it is the same workspace's)
const failure = atom<string | null>(null)
const memo = atom('memo', '', { persist: 'workspace' })
// what the last copy or open came to, shown in its card until the next refresh
const flash = atom<{ at: 'sid' | 'doc'; text: string; isError: boolean } | null>(null)

const why = (e: { code?: string; message?: string }) => e.message || e.code || String(e)

// Events come in bursts (an agent goes working → waiting → done): one request at a time,
// and one more after it if anything asked meanwhile. Exported for the tests.
let running = false
let again = false
// the focused workspace (readContext's id) and a count of its changes: an answer asked for
// before the focus moved is the old workspace's, and is dropped
let focused: string | null | undefined
let focusGen = 0

export async function refresh(): Promise<void> {
  if (running) {
    again = true
    return
  }
  running = true
  try {
    do {
      again = false
      const gen = focusGen
      const r: Answer = await Promise.resolve()
        .then(() => plugin.request('snap.get', undefined, { timeoutMs: 60_000 }))
        .catch((e: { code?: string; message?: string }) => ({ snap: null, error: why(e) }))
      if (gen !== focusGen) continue // the focus moved while it ran: the switch asked again
      if ('error' in r) {
        // a failed refresh says why and keeps what was shown, rather than emptying the pane
        const text = r.error || '이유를 알 수 없음'
        console.warn(`pinboard: snap.get: ${text}`) // orca plugin logs shows a panel's warnings
        set(failure, text)
      } else {
        set(answer, r)
        set(failure, null)
      }
      set(flash, null)
    } while (again)
  } finally {
    running = false
  }
}

// workspace.changed fires once as the panel subscribes (the first load), then on each
// switch and terminal change. A switch drops what was shown: it was another workspace's.
export function onWorkspaceChanged(context: { workspaceId?: string } | null): void {
  const id = context?.workspaceId ?? null
  if (id !== focused) {
    if (focused !== undefined) {
      focusGen++
      set(answer, null)
      set(failure, null)
    }
    focused = id
  }
  void refresh()
}

// Agent events naming another workspace than the one shown are passed over; one with no
// workspaceListId, or while no session is shown, still refreshes.
// ponytail: no timer, so CI turning green while every agent idles shows on the next event
// or the refresh button (upgrade: a worker interval posting to the panel; a worker stays
// up only with a status bar item), and the shown workspace's agents refresh it even while
// the panel is hidden (upgrade: skip while !read(ctx.visible), refresh once it shows)
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    on('workspace.changed', (e) => onWorkspaceChanged(e.context)),
    on('agent.status.changed', (e) => {
      const shown = read(answer)?.snap?.workspaceId
      if (e.workspaceListId && shown && e.workspaceListId !== shown) return
      void refresh()
    })
  )
}

const refused = (e: { code?: string; message?: string }) => ({ ok: false as const, error: why(e) })

// the worker does both: a panel has no clipboard and cannot start an app
async function copySid(sid: string): Promise<void> {
  const r = await plugin.request('clip.copy', { text: sid }).catch(refused)
  set(flash, { at: 'sid', text: r.ok ? '세션 id 복사됨' : `복사 실패: ${r.error}`, isError: !r.ok })
}

async function openDoc(path: string, label: string): Promise<void> {
  const r = await plugin.request('doc.open', { path }).catch(refused)
  set(flash, {
    at: 'doc',
    text: !r.ok ? `열기 실패: ${r.error} (${label})` : r.how === 'revealed' ? `Finder에서 표시: ${label}` : `열림: ${label}`,
    isError: !r.ok
  })
}

function Flash({ at }: { at: 'sid' | 'doc' }) {
  const f = read(flash)
  return f?.at === at ? (
    <Text size="xs" tone={f.isError ? 'danger' : 'success'}>
      {f.text}
    </Text>
  ) : null
}

// every state a PR row can have: the compiler holds this table to Pr['state']
const STATE: Record<Pr['state'], [string, Tone]> = {
  OPEN: ['[open]', 'success'],
  DRAFT: ['[draft]', 'neutral'],
  MERGED: ['[merged]', 'accent'],
  CLOSED: ['[closed]', 'danger'],
  UNKNOWN: ['[?]', 'neutral']
}
// open-ended keys (gh's review words, a notification's status): a lookup may miss
const REVIEW: Partial<Record<string, [string, Tone]>> = {
  APPROVED: ['승인', 'success'],
  CHANGES_REQUESTED: ['변경 요청', 'danger'],
  REVIEW_REQUIRED: ['리뷰 대기', 'neutral']
}
const CI_TONE: Record<Exclude<Pr['checks'], ''>, Tone> = {
  [CI.ok]: 'success',
  [CI.run]: 'warning',
  [CI.fail]: 'danger'
}
// a background task's mark in pinboard's colors (plain marks for its Nerd glyphs): running
// ◐ warning, done ● dim, failed ✗ red, stopped/killed/unknown ✗ dim; lost ? dim
// (orca-pinboard only: its output file is gone)
const BG: Partial<Record<string, [string, Tone?]>> = {
  running: [CI.run, 'warning'],
  completed: [CI.ok],
  failed: [CI.fail, 'danger'],
  [LOST]: ['?']
}

const keys = (ns: readonly TreeNode[]): string[] => ns.flatMap((n) => [n.key, ...keys(n.children ?? [])])

// A card: title left, meta (a count, 없음, the time) right, body under it.
// Card's own title/description would stack the meta under the title.
function Section({ title, meta, extra, children }: { title: string; meta?: string; extra?: OrcaNode; children?: OrcaNode }) {
  return (
    <Card>
      <Stack gap="sm">
        <Row justify="between" align="center">
          <Text weight="semibold">{title}</Text>
          <Row gap="xs" align="center">
            {meta ? (
              <Text muted size="xs">
                {meta}
              </Text>
            ) : null}
            {extra}
          </Row>
        </Row>
        {children}
      </Stack>
    </Card>
  )
}

// #number (the link) and the title, then the cells that say something, wrapping: CI and
// review only while open, and why gh failed. Text cells, not Badges: a toned Badge adds a dot.
function PrRow({ p }: { p: Pr }) {
  const isOpen = p.state === 'OPEN' || p.state === 'DRAFT'
  const [state, tone] = STATE[p.state]
  const review = isOpen ? REVIEW[p.review] : undefined
  return (
    <Stack gap="xs">
      <Text truncate>
        <Link href={p.url}>{`#${p.number}`}</Link> {p.title}
      </Text>
      <Row gap="sm" wrap>
        <Text tone={tone} size="xs">
          {state}
        </Text>
        {isOpen && p.checks ? (
          <Text tone={CI_TONE[p.checks]} size="xs">
            {p.checks}
          </Text>
        ) : null}
        {review ? (
          <Text tone={review[1]} size="xs">
            {review[0]}
          </Text>
        ) : null}
        {p.comments ? (
          <Text muted size="xs">
            {`코멘트 ${p.comments}`}
          </Text>
        ) : null}
        {p.error ? (
          <Text tone="warning" size="xs" truncate>
            {`gh 실패: ${p.error}`}
          </Text>
        ) : null}
      </Row>
    </Stack>
  )
}

function BgRow({ b }: { b: Bg }) {
  const [mark, tone] = BG[b.status] ?? [CI.fail] // stopped, killed, or a word not known: a dim ✗
  return (
    <Row gap="sm">
      <Text tone={tone} muted={!tone}>
        {mark}
      </Text>
      {b.port ? <Link href={`http://localhost:${b.port}`}>{`localhost:${b.port}`}</Link> : null}
      <Text truncate muted={b.status !== 'running'}>
        {b.label}
      </Text>
    </Row>
  )
}

export default function Panel() {
  const a = read(answer)
  const failed = read(failure)
  const retry = <IconButton icon="refresh" label="새로고침" onPress={refresh} />
  if (!a)
    return failed ? (
      <Stack gap="md">
        <EmptyState title="불러오지 못했습니다" description={failed} icon="warning" />
        {retry}
      </Stack>
    ) : (
      <Stack gap="md">
        <Spinner label="불러오는 중" />
        {retry}
      </Stack>
    )
  if (!a.snap)
    return (
      <Stack gap="md">
        <EmptyState title="표시할 세션이 없습니다" description={a.note} icon="agent" />
        {failed ? <Text tone="danger" size="xs">{`새로고침 실패: ${failed}`}</Text> : null}
        {retry}
      </Stack>
    )
  const s = a.snap
  const live = s.bg.filter((b) => b.status === 'running').length
  const nLinks = s.prs.length + s.jira.length + s.links.length
  const path = (p: string) => tilde(p, s.home)
  const time = `⟳ ${new Date(s.at).toTimeString().slice(0, 5)}`

  return (
    <Stack gap="md">
      {failed ? <Text tone="danger" size="xs">{`새로고침 실패: ${failed}`}</Text> : null}
      <Section
        title="세션"
        meta={failed ? `${time} · 갱신 실패` : time}
        extra={<IconButton icon="refresh" label="새로고침" size="xs" variant="ghost" onPress={refresh} />}
      >
        <Stack gap="xs">
          {s.branch ? <Text weight="medium">{`⎇ ${s.branch}`}</Text> : null}
          {s.worktree ? <Text muted>{`wt ${s.worktree}`}</Text> : null}
          <Text muted>{path(s.cwd)}</Text>
          <Row gap="xs" align="center">
            <Text muted size="xs">{`sid ${s.sid}`}</Text>
            <IconButton icon="copy" label="세션 id 복사" size="xs" variant="ghost" onPress={() => copySid(s.sid)} />
          </Row>
          <Text muted size="xs">
            마지막 기록 <RelativeTime at={s.writtenAt} />
          </Text>
          <Flash at="sid" />
        </Stack>
      </Section>

      {s.bg.length > 0 ? (
        <Section title="백그라운드" meta={`실행 ${live}/${s.bg.length}`}>
          <Stack gap="xs">
            {s.bg.map((b) => (
              <BgRow b={b} />
            ))}
          </Stack>
        </Section>
      ) : null}

      <Section title="작업" meta={s.intentError ? '읽지 못함' : s.tree.length ? undefined : '없음'}>
        {s.tree.length ? (
          <Tree label="작업 트리" items={s.tree} selected={s.current} defaultExpanded={keys(s.tree)} />
        ) : null}
      </Section>

      <Section title="PR · 링크" meta={nLinks ? String(nLinks) : '없음'}>
        {nLinks ? (
          <Stack gap="sm">
            {s.prs.map((p) => (
              <PrRow p={p} />
            ))}
            {s.jira.length ? (
              <Row gap="sm" wrap>
                {s.jira.map((j) => (
                  <Link href={j.url}>{j.key}</Link>
                ))}
              </Row>
            ) : null}
            {s.links.map((l) => (
              <Text truncate>
                <Link href={l}>{l.replace(/^https?:\/\//, '')}</Link>
              </Text>
            ))}
          </Stack>
        ) : null}
      </Section>

      <Section title="문서" meta={s.docs.length ? String(s.docs.length) : '없음'}>
        {s.docs.length ? (
          <Stack gap="xs">
            <List label="문서">
              {s.docs.map((d) => {
                const label = path(d.path).replace(/^.*\/(.+\/.+)$/, '$1')
                return (
                  <ListItem
                    icon="file-text"
                    title={label}
                    description={`${d.kind === 'new' ? '작성' : '읽음'} · ${d.tag} · 눌러서 열기`}
                    onPress={() => openDoc(d.path, label)}
                  />
                )
              })}
            </List>
            <Flash at="doc" />
          </Stack>
        ) : null}
      </Section>

      <Collapsible title={`프롬프트 히스토리 ${s.prompts.length}`}>
        <Stack gap="xs">
          {s.prompts.slice(-10).map((p, i, xs) => (
            <Text muted truncate>{`${s.prompts.length - xs.length + i + 1}. ${p}`}</Text>
          ))}
        </Stack>
      </Collapsible>

      <Section title="한줄메모" meta={s.workspace}>
        <Textarea
          label="한줄메모"
          labelHidden
          rows={3}
          placeholder="이 워크스페이스에서 기억할 것…"
          value={read(memo)}
          onChange={(v) => set(memo, v)}
        />
      </Section>
    </Stack>
  )
}
