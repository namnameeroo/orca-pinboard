# Pinboard for Orca

The [pinboard](https://github.com/namnameeroo/claude-mods#pinboard) pane as an Orca sidebar
panel. Orca's chat runs Claude Code without a terminal, so a Claude Code mod's panes never draw
there; this plugin reads the same facts from Orca and from disk instead and shows them beside
any local Orca workspace. The UI labels are in Korean.

## Install

```sh
orca plugin install namnameeroo/orca-pinboard
```

Orca asks you to approve a trusted (unsandboxed) Node worker, read access to your workspaces and
agent status, and the plugin's own settings. Orca's approval covers its own API calls only: the
worker reads your `~/.claude` transcripts, intent files and background-task logs and runs `gh`,
`pbcopy` and `open` through Node, which Orca does not check or limit. Then open **Pinboard** in
the right sidebar. Update with `orca plugin update namnameeroo.claude-pinboard` (the plugin's id
is `claude-pinboard`: Orca keeps ids starting `orca-` for its official plugins).

Needs macOS, Orca 1.4.247 or newer, and the `gh` CLI signed in: a PR gh cannot read shows
`gh 실패` and gh's reason (a timeout says so) beside its last known state, or `[?]` if it never
answered.

## What it shows

It follows the **focused workspace** and the newest Claude transcript in its folder
(`~/.claude/projects/<workspace path slug>/*.jsonl`, newest by modification time), so an Orca
chat and a `claude` in an Orca terminal both show up:

| Card | From |
| --- | --- |
| 세션 | Orca's workspace (branch, worktree, path), the transcript's session id (copy button) and when it was last written |
| 백그라운드 | the last 6 `run_in_background` Bash calls, their output files for exit and port. A dim ✗ was stopped or killed; `?` lost its output file (a reboot, `/tmp` cleaned: usually the task went with it) |
| 작업 | `~/.claude/intent/<session id>.json`, which pinboard's `record_intent` writes in a terminal `claude`. Orca chat never writes it (pinboard's tools do not register there) and a forked session has a new id, so there the card reads 없음; a file that is there but broken reads 읽지 못함 |
| PR · 링크 | the last 5 github.com PR URLs in the conversation's messages (not tool output), states from `gh pr view` (a merged one is not asked again until the worker restarts; a closed one is, as it can be reopened); the last 3 Jira keys; the last 5 Claude artifact (private or public), Atlassian, Figma and Notion links. A URL template in code (`…/{KEY}`, `…/${key}`) is no link |
| 문서 | the last 6 `.md` files the session created with Write or opened with Read (an Edit alone does not list one); press one to open it in its app |
| 프롬프트 히스토리 | the last 10 of up to 20 prompts typed, each its first line cut at 300 characters |
| 한줄메모 | yours, kept per workspace by Orca |

A doc opens only when its real path is a file ending in `.md` or `.markdown`; anything else, a
link to an app or a directory included, is only shown in Finder. An Orca panel has no clipboard
and cannot start an app, so the worker does both (`/usr/bin/pbcopy`, `/usr/bin/open`).

Left out on purpose: pinned questions and next steps (pinboard keeps them in its own store, not
a file this plugin reads, and its tools do not register in Orca chat) and the prompt toolbar (an
Orca panel cannot type into a chat).

## Settings

Orca → Settings → Plugins → Pinboard: **Jira site** (`https://your-team.atlassian.net`) and
**Jira project keys** (`WEB,APP`). Jira links need both; with either empty there are none.

## Limits

- Refreshes when the panel first loads, when the focused workspace or its terminals change, on
  an agent status change (one Orca ties to another workspace than the one shown is ignored), and
  on the refresh button. There is no timer: a CI run that finishes while every agent idles shows
  on the next refresh. Orca's docs describe agent events for terminal panes; whether Orca chat
  sends them is not verified.
- A refresh that fails keeps what was shown and says why, above the cards and beside the ⟳ time;
  switching workspaces drops the old cards first, so a failure there never shows another
  workspace's. `orca plugin logs namnameeroo.claude-pinboard` has the details.
- Two Claude sessions in one workspace: the one that wrote last wins. A `claude` started in a
  subfolder of the workspace has its own project folder and does not show.
- Local workspaces and `~/.claude` only (no SSH hosts, no `CLAUDE_CONFIG_DIR` profiles).
- A background-task log over 4 MiB is read at its two ends (64 KiB each): the port near the
  start, the exit line at the end.

## Develop

```sh
orca plugin types .                  # writes .orca/types (gitignored): tsc needs it after a clone
orca plugin dev load . --json        # asks for approval once: Node worker + workspace:read,
                                     # agent:read, settings:own
orca plugin dev request . snap.get   # what the worker answers for the focused workspace
orca plugin test .                   # src/*.test.ts(x); the worker tests use a temp HOME
npx -p typescript@5.6.3 tsc -p .     # Node APIs the worker uses are typed in src/node.d.ts
orca plugin shot local.claude-pinboard --panel pinboard
```

`src/scan.ts` ports `scan`, `rollup`, `jiraMatcher`, `toPr`, `pinnable` and more from pinboard's
[`hooks/register.tsx`](https://github.com/namnameeroo/claude-mods/blob/main/pinboard/hooks/register.tsx);
keep the two in step.
