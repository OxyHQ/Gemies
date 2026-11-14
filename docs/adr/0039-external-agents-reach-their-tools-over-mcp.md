# 39. An external agent reaches its gemie's tools as an MCP server

Status: Accepted (2026-11-13, the owner's decision: an external agent can be given tools like any
gemie — "a agentes externos también deberíamos poder darles tools y todo eso"). Builds on
[ADR 0038](./0038-external-agents-connect-with-their-own-credential.md); amends
[ADR 0036](./0036-external-agents-have-no-oxy-account.md) §6 and §7.
Date: 2026-11-13.

## Context

An external agent's turns run in its CLI on the person's computer (ADR 0030). Its gemie row has
grants like any gemie's, but nothing read them: the turn went to the daemon before the tool
assembler, and the relay carries text, not tools. Its owner could not give it a connected Notion,
the web, or anything else Gemies gives a gemie, and the editor hid every such control (ADR 0036
§7).

The CLIs it runs all speak MCP as clients, over Streamable HTTP, with a bearer header. Since ADR 0038
the agent has a credential of its own that names it and nothing else.

## Decision

1. **Gemies serves each external agent's tools as a remote MCP server** at
   `POST /mcp/agents/:agentId` (Streamable HTTP, stateless, JSON responses;
   `routes/external-agent-tools.ts`, `lib/external-agents/tool-server.ts`). Its bearer is the agent's
   credential (ADR 0038). Any other credential, an unknown or revoked agent, or a link from before
   credentials gets the same 401. The link is read on every request, so revoking the agent closes
   its tools at once.
2. **The tools are the one assembler's** (`ToolPipeline.forUser`), with the gemie's grants and for
   its owner. The lane states what it is and takes no decision of its own:
   - It acts for the owner (`actsForPerson`), who paired it and granted what it reaches: the
     connected accounts (`mcp:<id>`), the web, artifacts, and whatever families its owner grants.
   - It holds no Oxy session (`isDirectSession: false`, no bearer, no task). Nothing that needs the
     person's own Oxy authority is built: their Oxy apps (`oxy_*`), automations, agent creation.
     Oxy authorises those per call against an actor account and the requester's token or task, and
     an external agent has neither. That is not worked around.
   - It reserved no credits (`isLocalRuntime: true`; an external turn costs nothing, ADR 0030 §3).
     Nothing that runs hosted inference behind a tool call is built: deep research, consulting
     another gemie. Talking to other gemies reaches it when the messaging layer makes that a
     conversation rather than a hosted turn inside a tool.
   - The gemie has no Oxy account, so no memory of Gemies' (its journal names the gemie's account).
     The assembler builds none for such a gemie instead of throwing; the CLI keeps its own memory.
3. **Every call runs in Gemies, under the governance a gemie's actions get.**
   - `classifyActionRisk` and the threat detector run on every call: R3 and a blocking threat never
     run, and R2 and a flagged threat are logged. Nothing asks for approval (ADR 0020 §3).
   - Each call is recorded in `external_agent_tool_calls`: tool, risk, outcome, duration, and never
     its arguments or result. The table is swept after 90 days.
   - Requests are limited to 120 a minute per agent, and 600 a minute per address before anything
     is read. The lane is exempt from Oxy's global limiter, whose resolver cannot read this bearer.
   - The CLI only calls tools: nothing is pushed to the person's machine.
4. **The daemon hands the server to every run of the CLI**, through that CLI's own MCP configuration
   for the run: Claude Code's `--mcp-config` with `--allowedTools mcp__gemies`, Codex's
   `-c mcp_servers.gemies.*`, and OpenCode's `OPENCODE_CONFIG_CONTENT`. The credential travels in the
   child's environment (`GEMIES_AGENT_CREDENTIAL`), and the configuration only names it, so it is
   never on a command line. The person's own config files are not written: the tools are the gemie's
   turns', not every session the person opens, and revoking leaves nothing to clean up.
5. **The editor shows a gemie with no account the controls it can use**: the connected accounts
   section (`AgentConnectorsSection`, the same component). The cards of Gemies' runtime stay hidden:
   work, its own accounts and bot, hears, inbox, memory.

## Pending: what reaches it when the lanes it needs exist

The owner wants an external agent to message other gemies and to use the person's WhatsApp and
Telegram accounts the person grants it. Both go through this lane once the lane behind them admits
it. These are the steps, owned here:

1. **Messaging other gemies** ([ADR 0041](./0041-gemies-talk-in-conversations.md)). `sendMessage`
   writes into the conversation between the two gemies and the answer comes back to the person's
   chat the turn belongs to, so `forUser` builds it only with a `conversationId`. Writing spends
   nothing of the writer's turn (each turn of the chain reserves its own credits), so it is not
   withheld on this unreserved lane.
   - **Done on the server:** the tool server reads the run's conversation from the
     `X-Gemies-Conversation` header (`EXTERNAL_AGENT_CONVERSATION_HEADER`), checks that it is the
     owner's chat with this gemie and not a conversation between gemies, and hands it to `forUser`.
     Anything else is no conversation, and the run simply has no `sendMessage`.
   - **Pending on the daemon:** pass the conversation of each turn (the relay's `threadKey`) as
     that header in the run's MCP config.
2. **The person's connected accounts.** `loadGrantableGemie` (ADR 0035 as amended, #81) refuses
   every grant to a gemie with no Oxy account, because an answering gemie needs an actor. Using an
   account is different: the account tools (`buildAccountTools`) send as the person's own account
   and need no actor.
   - The change is to let a `local` gemie be granted an account to use, but never to answer it.
   - Its editor then shows `AgentAccountsSection`, and the tools reach it here with no change to
     this lane.
3. **Live presence and activity** (the realtime socket, `feat/realtime-sockets`) already names
   external agents (`presence` from the relay, `activity` for their turns), and needs nothing from
   this lane.

## Consequences

- An owner grants an external agent a connected account in its editor, and its next turn can use it
  as `mcp__gemies__mcp_<server>__<tool>`.
- A leaked credential reaches the agent's granted tools as well as its turns. The answer is the same
  as ADR 0038's: remove or reconnect the agent.
- What an external agent may do grows with the grant model, with no work on this lane. When
  per-person connections with per-gemie grants or gemie-to-gemie messaging land in the assembler,
  they reach it too.
