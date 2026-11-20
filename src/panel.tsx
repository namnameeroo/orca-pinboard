// The pinboard pane of ../pinboard as an Orca sidebar panel: read-only cards over
// the focused workspace's newest Claude session, plus a memo kept per workspace.
// Orca draws it in its own UI font: Orca icons, not Nerd glyphs.
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
  Row,
  set,
  Spinner,
  Stack,
  Text,
  Textarea,
  Tree,
  type OrcaNode,
  type PanelContext
} from 'orca'
import './protocol'
import { CI, tilde, type Bg, type Pr, type Snap, type TreeNode } from './scan'

type Answer = { snap: Snap | null; note?: string }

const answer = atom<Answer | null>(null)
const memo = atom('memo', '', { persist: 'workspace' })
// what the last copy or open came to, shown in its card until the next refresh
const flash = atom<{ at: 'sid' | 'doc'; text: string; isError: boolean } | null>(null)

// Events come in bursts (an agent goes working → waiting → done): one request at
// a time, and one more after it if anything asked meanwhile.
let running = false
let again = false
export async function refresh(): Promise<void> {
  if (running) {
    again = true
    return
  }
  running = true
  try {
    do {
      again = false
      set(
        answer,
        await plugin
          .request('snap.get', undefined, { timeoutMs: 60_000 })
          .catch((e: { code?: string; message?: string }) => ({
            snap: null,
            note: `불러오지 못했습니다: ${e.code ?? e.message}`
          }))
      )
      set(flash, null)
    } while (again)
  } finally {
    running = false
  }
}

const refused = (e: { code?: string; message?: string }) => ({ ok: false, error: e.code ?? e.message })

// the worker does both: a panel has no clipboard and cannot start an app
async function copySid(sid: string): Promise<void> {
  const r = await plugin.request('clip.copy', { text: sid }).catch(refused)
  set(flash, { at: 'sid', text: r.ok ? '세션 id 복사됨' : `복사 실패: ${r.error}`, isError: !r.ok })
}

async function openDoc(path: string, label: string): Promise<void> {
  const r = await plugin.request('doc.open', { path }).catch(refused)
  set(flash, {
    at: 'doc',
    text: !r.ok
      ? `열기 실패: ${r.error} (${label})`
      : 'how' in r && r.how === 'revealed'
        ? `Finder에서 표시: ${label}`
        : `열림: ${label}`,
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

// ponytail: no timer (panels have none); CI turning green while every agent
// idles shows on the next event or the refresh button
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    on('workspace.changed', () => void refresh()),
    on('agent.status.changed', () => void refresh())
  )
  void refresh()
}

const STATE: Record<Pr['state'], [string, 'success' | 'accent' | 'danger' | 'neutral']> = {
  OPEN: ['[open]', 'success'],
  DRAFT: ['[draft]', 'neutral'],
  MERGED: ['[merged]', 'accent'],
  CLOSED: ['[closed]', 'danger']
}
const REVIEW: Record<string, [string, 'success' | 'danger' | 'neutral']> = {
  APPROVED: ['승인', 'success'],
  CHANGES_REQUESTED: ['변경 요청', 'danger'],
  REVIEW_REQUIRED: ['리뷰 대기', 'neutral']
}
const CI_TONE: Record<string, 'success' | 'warning' | 'danger'> = {
  [CI.ok]: 'success',
  [CI.run]: 'warning',
  [CI.fail]: 'danger'
}
const BG: Record<string, [string, 'warning' | 'danger' | 'neutral']> = {
  running: [CI.run, 'warning'],
  completed: [CI.ok, 'neutral'],
  failed: [CI.fail, 'danger']
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

// two lines: #number (the link) and the title, then the cells that say something
// (CI and review only while open). Text cells, not Badges: a toned Badge adds a dot.
function PrRow({ p }: { p: Pr }) {
  const isOpen = p.state === 'OPEN' || p.state === 'DRAFT'
  const [state, tone] = STATE[p.state]
  const review = isOpen ? REVIEW[p.review] : undefined
  return (
    <Stack gap="xs">
      <Text truncate>
        <Link href={p.url}>{`#${p.number}`}</Link> {p.title}
      </Text>
      <Row gap="sm">
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
      </Row>
    </Stack>
  )
}

function BgRow({ b }: { b: Bg }) {
  const [mark, tone] = BG[b.status] ?? [CI.fail, 'neutral'] // killed
  return (
    <Row gap="sm">
      <Text tone={tone}>{mark}</Text>
      {b.port ? <Link href={`http://localhost:${b.port}`}>{`localhost:${b.port}`}</Link> : null}
      <Text truncate muted={b.status !== 'running'}>
        {b.label}
      </Text>
    </Row>
  )
}

export default function Panel() {
  const a = read(answer)
  if (!a) return <Spinner label="불러오는 중" />
  if (!a.snap)
    return (
      <Stack gap="md">
        <EmptyState title="표시할 세션이 없습니다" description={a.note} icon="agent" />
        <IconButton icon="refresh" label="새로고침" onPress={refresh} />
      </Stack>
    )
  const s = a.snap
  const running = s.bg.filter((b) => b.status === 'running').length
  const nLinks = s.prs.length + s.jira.length + s.links.length
  const path = (p: string) => tilde(p, s.home)

  return (
    <Stack gap="md">
      <Section
        title="세션"
        meta={`⟳ ${new Date(s.at).toTimeString().slice(0, 5)}`}
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
          <Flash at="sid" />
        </Stack>
      </Section>

      {s.bg.length > 0 ? (
        <Section title="백그라운드" meta={`실행 ${running}/${s.bg.length}`}>
          <Stack gap="xs">
            {s.bg.map((b) => (
              <BgRow b={b} />
            ))}
          </Stack>
        </Section>
      ) : null}

      <Section title="작업" meta={s.tree.length ? undefined : '없음'}>
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
