# Pinboard for Orca

The [pinboard](https://github.com/namnameeroo/claude-mods#pinboard) pane as an Orca sidebar
panel. Orca's chat runs Claude Code without a terminal surface, so a Claude Code mod's panes
never draw there; this plugin reads the same facts from disk instead and shows them beside any
Orca workspace. The UI labels are in Korean.

## Install

```sh
orca plugin install namnameeroo/orca-pinboard
```

Orca lists what it asks for and waits for your approval: a Node worker that reads your
`~/.claude` transcripts and intent files and runs `gh`, `pbcopy` and `open`; your workspaces and
agent status; its own storage and settings. Then open **Pinboard** in the right sidebar.
Update with `orca plugin update namnameeroo.orca-pinboard`.

Needs macOS, Orca 1.4.247 or newer, and the `gh` CLI signed in for PR states.

It follows the **focused workspace** and its **newest Claude transcript**
(`~/.claude/projects/<cwd slug>/*.jsonl`), so an Orca chat and a `claude` in an Orca
terminal both show up:

| Card | From |
| --- | --- |
| 세션 | Orca's workspace (branch, worktree, path) and the transcript's session id (copy button) |
| 백그라운드 | `run_in_background` Bash calls in the transcript, their output files for exit and port |
| 작업 | `~/.claude/intent/<sid>.json` (written by pinboard's `record_intent`) |
| PR · 링크 | PR URLs in the conversation, live from `gh pr view`; Jira keys; Claude artifact, Atlassian, Figma and Notion links |
| 문서 | `.md` files the session wrote or read; press one to open it in its app |
| 프롬프트 히스토리 | the last prompts typed |
| 한줄메모 | yours, kept per workspace by Orca |

An Orca panel has no clipboard and cannot start an app, so the worker does both on macOS
(`pbcopy`, `open`); a path that does not resolve to a `.md` is only shown in Finder.

Left out on purpose: pinned questions and next steps (pinboard's tools register only in an
interactive terminal session) and the prompt toolbar (an Orca panel cannot type into a chat).

## Settings

Orca → Settings → Plugins → Pinboard: **Jira site** (`https://your-team.atlassian.net`) and
**Jira project keys** (`WEB,APP`). Both empty: no Jira links.

## Limits

- Refreshes on an agent status change, a workspace switch, or the refresh button; there is no
  timer, so a CI run that finishes while every agent idles shows on the next one.
- Two Claude sessions in one workspace: the one that wrote last wins.
- Local workspaces and `~/.claude` only (no SSH hosts, no `CLAUDE_CONFIG_DIR` profiles).
- `gh` is looked up on `PATH` plus `/opt/homebrew/bin` and `/usr/local/bin`.

## Develop

```sh
orca plugin dev load . --json        # asks for approval once: Node worker + workspace:read,
                                     # agent:read, storage:own, settings:own
orca plugin dev request . snap.get   # what the worker answers for the focused workspace
orca plugin test .                   # src/*.test.ts(x)
npx -p typescript@5.6.3 tsc -p .     # Node APIs the worker uses are typed in src/node.d.ts
orca plugin shot local.orca-pinboard --panel orca-pinboard
```

`src/scan.ts` ports `scan`, `rollup` and `jiraMatcher` from pinboard's
[`hooks/register.tsx`](https://github.com/namnameeroo/claude-mods/blob/main/pinboard/hooks/register.tsx);
keep the two in step.
