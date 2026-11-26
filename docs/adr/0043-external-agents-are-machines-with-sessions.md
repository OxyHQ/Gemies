# 43. A computer is paired once; a coding CLI's gemie holds its sessions

Status: Accepted (2026-11-26, the owner's decision: Claude Code and Codex are used from the terminal
because pairing an agent per project is a chore; the app should open a session in any folder without a
new terminal and a new pasted message). Builds on [ADR 0030](./0030-external-agents.md),
[0032](./0032-external-agents-resume-sessions-and-leave-with-their-link.md),
[0036](./0036-external-agents-have-no-oxy-account.md),
[0038](./0038-external-agents-connect-with-their-own-credential.md) and
[0039](./0039-external-agents-reach-their-tools-over-mcp.md). Nothing here is built yet: see
"Not built" for the order.
Date: 2026-11-26.

## Context

An external agent is one pairing, one CLI, one computer and one folder, the one `connect` ran in
(ADR 0030, 0038). A conversation already continues the CLI's own session (ADR 0032), but the map
`<agentId>:<threadKey> → session id` lives only in the daemon, so the server does not know where a
conversation works, the app cannot choose, and every new project means a terminal, a code, a pasted
prompt and a new gemie in the sidebar.

## Decision

1. **Three things, no longer one.**
   - A **machine**: a daemon paired once. It tells the server which CLIs it has (`hello`: machine id,
     name, CLIs with version and whether they resume).
   - A **gemie** per machine and CLI ("Claude Code · laptop"), a `local` gemie as in ADR 0036. Pairing
     creates the ones the daemon reports; a CLI installed later appears on the next `hello`.
   - A **session**: a conversation of the gemie plus the folder it works in and the CLI's own session
     id, stored by the server (`external_agent_sessions`), not only by the daemon.
2. **The app opens sessions.** "New session" picks the CLI and a folder; the turn frame carries
   `session: { cwd, resumeId?, mode }`. Several sessions of one daemon run at once.
3. **The person's machine decides which folders.** The daemon accepts a `cwd` only inside the roots
   its owner set locally (`gemies allow <folder>`), and refuses any other, so a compromised server
   cannot ask for `~/.ssh`. The app offers recent folders and the allowed roots; it cannot widen
   them.
4. **Sessions begun in a terminal can be continued.** The daemon lists the CLIs' own sessions on disk
   when the server asks (`list-sessions` / `sessions`) and a chosen one becomes a conversation with
   that `resumeId`. Two places writing to one session at once is not prevented; the app says so.
5. **The CLI's work is shown, and its permissions asked, in the conversation.** The daemon reports
   tool use as `activity` frames (tool, path, diff summary, command, exit code). Claude Code's
   permission prompts go to a tool of the agent's MCP server (ADR 0039) that waits for the person's
   answer in the app; until that exists, the mode of ADR 0031 holds. This is the third-party CLI's
   own permission, asked by it of its own user: not an Oxy grant and not a "reauthorise".
6. **The daemon is Gemies'.** It is `@gemies/cli`, binary `gemies` (`connect`, `status`,
   `disconnect`, `allow`), published from this repo (`release-packages.yml`). `@alia-codea/cli` keeps a
   `codea connect` shim that points here for a while. The pasted text names the new command.
7. **Wire changes are additive.** A daemon of `@alia-codea/cli` 4.x still authenticates, answers
   `turn` and gets the one-folder behaviour it has now; its link is read as a machine with one CLI.

## Consequences

- Pairing happens once per computer and the sidebar stops growing by project.
- The server now stores a folder path per conversation. It is the person's own path, shown only to
  them, and never reaches another gemie's prompt.
- Existing links migrate as machines with one CLI and their current folder as an allowed root.
- Claude Code's terms (ADR 0030) stay the grey area; the app keeps telling the person.
- Codex's approvals may not be available in a stable form; if not, §5 covers Claude Code only.

## Not built

Everything above. Order: the `@gemies/cli` move and rename (§6), machines and `hello` (§1), sessions
and the folder roots (§2, §3), listing terminal sessions (§4), `activity` frames, then permission
prompts (§5).
