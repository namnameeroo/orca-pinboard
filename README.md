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
agent status, and the plugin's own settings. The worker reads your `~/.claude` transcripts,
intent files and background-task logs and runs `gh`, `pbcopy` and `open`; Orca does not check or
limit what it does. Then open **Pinboard** in the right sidebar.
Update with `orca plugin update namnameeroo.claude-pinboard` (the plugin's id is
`claude-pinboard`: Orca keeps ids starting `orca-` for its official plugins).

Needs macOS, Orca 1.4.247 or newer, and the `gh` CLI signed in: a PR gh cannot read shows `[?]`
and `gh 실패` with gh's reason.

## What it shows

It follows the **focused workspace** and the newest Claude transcript in its folder
(`~/.claude/projects/<workspace path slug>/*.jsonl`, newest by modification time), so an Orca
chat and a `claude` in an Orca terminal both show up:

| Card | From |
| --- | --- |
| 세션 | Orca's workspace (branch, worktree, path), the transcript's session id (copy button) and when it was last written |
| 백그라운드 | the last 6 `run_in_background` Bash calls, their output files for exit and port. A dim ✗ was stopped or killed; `?` lost its output file (a reboot, `/tmp` cleaned) |
| 작업 | `~/.claude/intent/<session id>.json`, which pinboard's `record_intent` writes in a terminal `claude`. Orca chat never writes it (pinboard's tools do not register there) and a forked session has a new id, so there the card reads 없음 |
| PR · 링크 | the last 5 github.com PR URLs in the conversation's messages (not tool output), states from `gh pr view` (merged and closed ones are not asked again); the last 3 Jira keys; the last 5 Claude artifact, Atlassian, Figma and Notion links |
| 문서 | the last 6 `.md` files the session wrote or read; press one to open it in its app |
| 프롬프트 히스토리 | the last 10 prompts typed |
| 한줄메모 | yours, kept per workspace by Orca |

A doc opens only when its real path is a `.md` or `.markdown` file; anything else, a link to an
app included, is only shown in Finder. An Orca panel has no clipboard and cannot start an app, so
the worker does both (`/usr/bin/pbcopy`, `/usr/bin/open`).

Left out on purpose: pinned questions and next steps (pinboard keeps them in its own store, per
session, and its tools do not register in Orca chat) and the prompt toolbar (an Orca panel cannot
type into a chat).

## Settings

Orca → Settings → Plugins → Pinboard: **Jira site** (`https://your-team.atlassian.net`) and
**Jira project keys** (`WEB,APP`). Jira links need both; with either empty there are none.

## Limits

- Refreshes when the panel opens, when the focused workspace or its terminals change, on an agent
  status change in the workspace shown, and on the refresh button. There is no timer: a CI run
  that finishes while every agent idles shows on the next refresh. Orca's docs describe agent
  events for terminal panes; whether Orca chat sends them is not verified.
- A refresh that fails keeps what was shown and says why above the cards;
  `orca plugin logs namnameeroo.claude-pinboard` has the details.
- Two Claude sessions in one workspace: the one that wrote last wins. A `claude` started in a
  subfolder of the workspace has its own project folder and does not show.
- Local workspaces and `~/.claude` only (no SSH hosts, no `CLAUDE_CONFIG_DIR` profiles).
- A background-task log over 4 MiB is not read: the task reads running, its port from its command.

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

`src/scan.ts` ports `scan`, `rollup`, `jiraMatcher` and more from pinboard's
[`hooks/register.tsx`](https://github.com/namnameeroo/claude-mods/blob/main/pinboard/hooks/register.tsx);
keep the two in step.
