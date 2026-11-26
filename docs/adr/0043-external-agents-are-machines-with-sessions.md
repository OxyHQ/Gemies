# 43. A computer is paired once; a coding CLI's gemie holds its sessions

Status: Accepted (2026-11-26, the owner's decision: Claude Code and Codex are used from the terminal
because pairing an agent per project is a chore; the app should open a session in any folder without a
new terminal and a new pasted message). Builds on [ADR 0030](./0030-external-agents.md),
[0032](./0032-external-agents-resume-sessions-and-leave-with-their-link.md),
[0036](./0036-external-agents-have-no-oxy-account.md),
[0038](./0038-external-agents-connect-with-their-own-credential.md) and
[0039](./0039-external-agents-reach-their-tools-over-mcp.md). Built in six steps (see "What was built"),
where the first design was simplified in three places, each named there.
Date: 2026-11-26.

## Context

An external agent is one pairing, one CLI, one computer and one folder, the one `connect` ran in
(ADR 0030, 0038). A conversation already continues the CLI's own session (ADR 0032), but the map
`<agentId>:<threadKey> → session id` lives only in the daemon, so the server does not know where a
conversation works, the app cannot choose, and every new project means a terminal, a code, a pasted
prompt and a new gemie in the sidebar.

## Decision

1. **Three things, no longer one.**
   - A **machine**: what one pairing made. `external_agent_links.machine_id` groups the links of one
     code; there is no table of machines and no `hello` frame (see "What was built").
   - A **gemie** per machine and CLI ("Claude Code · laptop"), a `local` gemie as in ADR 0036. One code
     pairs every CLI the computer has: `POST /agents/external/redeem` takes `clis: [...]` and returns a
     gemie and its own credential for each.
   - A **session**: a conversation of that gemie plus the folder it works in and, if it continues one,
     the CLI's session id, stored by the server (`external_agent_sessions`), not only by the daemon.
2. **The app opens sessions.** "New session" on a connected agent picks a folder (recent ones, or a
   path) and starts a new conversation with the agent: a new stretch of its thread (`POST
   /conversations/new`), whose folder is registered before the first message
   (`POST /agents/external/:agentId/sessions`). The turn frame carries `cwd` (and `resumeId`).
   Sessions of different folders run together on one daemon; one folder runs one turn at a time.
3. **The person's machine decides which folders.** The daemon accepts a `cwd` only inside the folder
   the agent was paired in or a root its owner allowed locally (`gemies allow <folder>`), after
   resolving symlinks, and refuses any other, saying how to allow it, so a compromised server cannot
   ask for `~/.ssh`. The app offers recent folders; it cannot widen the roots.
4. **Sessions begun in a terminal can be continued.** The daemon reads the CLIs' own session files
   (Claude Code, Codex; OpenCode keeps none it can read) when the server asks (`list-sessions` /
   `sessions`, `GET /agents/external/:agentId/terminal-sessions`), offers only those in allowed
   folders, and a conversation opened on one carries its `resumeId`, used once when the computer has
   kept no session for the conversation. Two places writing to one session at once is not prevented.
5. **The CLI's work is shown, and its permissions asked, in the conversation.**
   - The daemon reports each tool the CLI uses as `activity` frames, started and finished, with a short
     target (path, command, pattern) and never contents or output. The 1:1 turn writes them as tool
     calls and results, the frames every tool uses, and stores them beside the answer.
   - **Claude Code's permission questions are answered in the conversation.** The daemon runs an MCP
     server on the loopback, one path and one token per run, and names it `--permission-prompt-tool`.
     A question goes to Gemies as `approval-request` over the daemon's WebSocket (not an HTTP request
     held open behind a load balancer), shows as a card (`alia.cli_permission_request`), and the person's
     answer (`POST /agents/external/:agentId/approvals/:requestId`) goes back as `approval`.
     Unanswered (5 minutes), dropped or malformed is **deny**; the daemon honours only request ids it
     issued; a read-only agent never asks; the capability is negotiated (`auth-ok.features`), so an
     older Gemies or daemon simply never asks. The events carry their own names, `alia.cli_permission_*`,
     not the retired `alia.approval_*` of ADR 0020 §3, which stays in force: no agent of Gemies asks
     the person for approval, and `__tests__/noApprovals.test.ts` keeps that so. This is the third-party CLI's own question to its own
     user about their own computer: not an Oxy grant, consent or "reauthorise".
   - **Codex has no such hook** in `codex exec`; it keeps `sandbox_mode` (ADR 0031). `codex app-server`
     would be the way in.
6. **The daemon is Gemies'.** It is `@gemies/cli`, binary `gemies` (`connect`, `status`, `disconnect`,
   `allow`), in `packages/cli`, published by `release-packages.yml`. It keeps the on-disk names the
   Codea CLI used (`codea` data directory, `codea.service`, the `alia-codea-cli` settings), so a
   machine paired with `codea connect` carries over without pairing again. The pasted text names the
   new command.
7. **Wire changes are additive.** A daemon of `@alia-codea/cli` 4.x still authenticates, answers `turn`
   and gets the one-folder behaviour it has now; the single-`cli` redeem request and its response are
   unchanged.

## Consequences

- Pairing happens once per computer and the sidebar stops growing by project.
- The server now stores a folder path per conversation. It is the person's own path, shown only to
  them, and never reaches another gemie's prompt.
- Claude Code's terms (ADR 0030) stay the grey area; the app keeps telling the person.
- Permission questions are Claude Code's only; a Codex agent still works in its sandbox.
- A turn that asks for permission holds the CLI until the person answers or five minutes pass.

## What was built, and where it differs from the first design

Phases, in order: the daemon moved here (#158), one code pairs a computer (#159, migration 0183),
folders and the roots (migration 0184), sessions begun in a terminal (migration 0185), activity, and
the permission cards (SDK and app). Three simplifications of the first text:

- **No `hello` frame and no machines table.** A `machine_id` on each link groups a pairing's gemies,
  and the CLIs are named by the pairing request itself; a CLI installed later is paired by running
  `gemies connect` with a new code. The daemon's capabilities that did need announcing are
  `auth-ok.features`, from the server.
- **Existing links were not migrated into machines.** They keep working as they are (`machine_id`
  null); only a new pairing groups.
- **A session is a stretch of the agent's thread**, not a separate surface: the app opens the agent's
  own thread, whose newest conversation is the one just made.
