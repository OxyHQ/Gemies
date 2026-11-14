# 41. Gemies talk to each other in conversations, not through a tool

*Los gemies hablan entre ellos en conversaciones de verdad, no con una herramienta.*

**Status:** Accepted

**Date:** 2026-11-13

**Supersedes:** ADR 0020 §5 (`consultAgent`) and the consultation half of §7 (a consulted agent
joining the header); ADR 0028 §6's `askAlia`.

## Context

The owner, 2026-11-13: *«cuando hablen gemies entre ellos deberían conversar real, más que un simple
mcp tool; además yo luego cuando toco para ver la conversación read only que tuvieron debería poder
verla toda»*, and then: *«herramientas como lo de consult gemie y cosas así no deben existir, ya que
como hablamos deben chatear de forma real entre ellos»*.

Until now a gemie reached another with `consultAgent { agentId, task }` (ADR 0020 §5): one nested,
blocking turn of the other gemie inside the caller's tool call, whose single answer came back as the
tool's result. What was kept of it was the call's `task` and `response` on the caller's reply, plus
the answer copied into the person's chat as `<reply>-agent-<n>`. "View the conversation" rebuilt a
two-line exchange from those traces. There was no conversation: no second turn, no record of its own,
nothing to open from anywhere but that one chat. `askAlia` (ADR 0028 §6) was the same thing in the
other direction, for a space's members.

Group rooms (ADR 0025) and spaces (ADR 0028) already are real conversations between gemies: stored
messages under each gemie's identity, turns run in workers past any request, live through the room
bus and the person's socket, bounded per chain.

## Decision

### 1. A conversation between two gemies is a conversation

The person's two gemies have ONE conversation for that person, reopened every time either writes
to the other, as a person's chat with a friend is:

- an ordinary `conversations` row owned by the person (the room gemie's, like a group), with both
  gemies in `conversation_members`;
- one `gemie_conversations` row naming the pair (`first_agent_id < second_agent_id`, unique per
  person) and marking it as theirs.

Every message is stored under the gemie that wrote it (`messages.agent_info_*`), as a room member's
reply is. The person reads it and never writes in it: `POST /v1/chat/completions`, the client save
(`POST /conversations`) and reactions answer `403 conversation_between_gemies` there. The listing
keeps it out of the person's own conversations (`GET /conversations`) and returns it on
`?kind=gemies`, each with `kind: 'gemies'` and both gemies' identities in `members`.

### 2. Writing to a gemie is a message, not a request

`sendMessage { to, text }` is the messaging primitive: it stores the message in that conversation
(opening it the first time) and returns at once — `{ status: 'sent', conversationId, chainId, from,
to }`. It never waits for an answer and never returns one. Then, on the room queue's workers
(`lib/chat/gemies`, a queue of its own, `gemie-conversations`):

1. **The other gemie answers** in its own turn (`runAgentTurn`), reading the conversation from its
   own perspective — its own messages are its own, the writer's are a peer's, delimited and
   attributed, never the person's instructions — and its answer is stored there.
2. **The answer wakes the gemie that wrote**, as a turn of its own *in the person's chat with it*,
   where it was working when it wrote. It reads the exchange and continues: it writes again
   (`sendMessage`, now bound to the same gemie), and/or tells the person what it found. What it
   says there is its ordinary reply in that chat — stored without a guest's identity, streamed live
   with `lead: true` on its room events.
3. A continuation that does not write again ends the chain.

The tool exists only where the writer can continue: a turn in the person's own chat with that gemie
(`conversationId`, handed to the assembler only by a caller that knows it is that chat). Two callers
do: the person's own session (`POST /v1/chat/completions`) and an external agent's tool lane (ADR
0039), whose run names its chat in the `X-Gemies-Conversation` header and which checks that it is the
owner's chat with that gemie and not a conversation between gemies. A channel, a voice call and an
unattended run do not have it. Writing spends nothing of the writer's turn — every turn of the chain
reserves its own credits from the person — so a local-model turn and an external agent may write.

**External agents are participants like any gemie.** Written to, an external agent answers through
its daemon (the relay, ADR 0030), as it answers in a room. Writing, it uses `sendMessage` from its
tool lane. When the answer comes back to an external agent, its continuation runs through its daemon
too and tells the person; it holds no `sendMessage` bound to the chain (the relay carries text, not
tools), so a follow-up is its next message from the chat, a new chain.

### 3. The safety properties belong to the messaging layer

- **Bounds per chain.** Every message of a chain (both ways) and every token of every turn of it
  count: `GEMIE_CHAIN_MAX_MESSAGES` (default 8: a first message and three follow-ups, each answered)
  and `GEMIE_CHAIN_MAX_TOKENS` (default 120 000). Once another exchange would not fit, the gemie that
  wrote is given no `sendMessage` and is told to tell the person what it has. A value that is not a
  positive integer is ignored, never read as unbounded.
- **No ping-pong, no fan-out.** The gemie written to answers with `nested: true`: it can write to
  nobody. The gemie that wrote continues with a `sendMessage` bound to the one it talks to, once per
  turn. A chain therefore has exactly two speakers and ends. A newer message in the same conversation
  supersedes an older chain's pending answer. A room's reply rate per window (60 per 10 minutes)
  applies to the conversation as to any room.
- **Reach.** Who a gemie may write to is who the person could open (`canReachAgent`, with the app
  they are in), narrowed by the writer's `agent` grant, and for a space member exactly its peers and
  Alia (ADR 0028 §6's cut, unchanged). The recipient's feature gates are checked and spent against
  the turn's attachments before anything is sent (ADR 0020 §6).
- **Authority and billing.** Each gemie's unattended turns act under an Oxy task minted when the
  chain starts, while the person's bearer is present (as a room member's, ADR 0025 §7); every exit
  revokes them. The person pays for every turn, as for every room turn.
- **Alia's memory.** When Alia is either side, her turns hold her reading tools only — never her
  memory (Nilo), never anything that sends, writes or acts — and her Oxy apps at `read_only`. Her
  memory never reaches another gemie (ADR 0034). This is stricter than `askAlia`, which let her read
  her memory to answer a member.

### 4. One implementation with rooms and spaces

A conversation between gemies runs on the room's machinery: the conversation step queue
(`lib/chat/room/step-queue.ts`, shared by both), the room lock per conversation, the room bus, the
room's reply store and transcript perspective, and the agent turn. A space member writing to a peer
or to Alia uses the same `sendMessage` and the same conversation; the space's room stays the place
the members talk when the person speaks (ADR 0028). What they say and who is writing reach the
person on the one realtime socket (ADR 0040): `room` frames, as a room's, and `conversation` rows,
which carry `kind` so a client files a conversation between gemies in its own list and never among
the person's.

### 5. What the person sees

- **In the chat:** the `sendMessage` call draws a card, "Pepe is talking to Lumen…" with who is
  writing and the last thing said, live over the conversation's room events, then "Pepe talked to
  Lumen". The gemie's own reply with the result follows it in the chat when it has one.
- **The conversation:** pressing the card opens it read-only (`GemieBetweenGemies`, in
  `@gemies/sdk`, so Alia draws it too): every turn under its gemie's name and avatar, tool steps and
  thought panels, timestamps, streaming while they still talk, no composer.
- **Later:** the sidebar's **Between gemies** section lists every pair that talked, both avatars and
  the last line; a row opens the same read-only view at `/c/:id`. The sidebar, not a gemie's page,
  because a conversation belongs to both gemies equally and Alia has no page of her own there.

### 6. Retired

Deleted, not deprecated: `consultAgent` and `askAlia` and their tests; the consulted answer copied
into the person's chat (`agentMessages`, `<reply>-agent-<n>`); the SDK's agent exchange, its
"Chatted with" line and the consulted agent joining the header (`useParticipants`). Migration 0171
moves every stored consultation into the conversation its two gemies now have — the question and the
answer at the time they happened — removes the copied answers from the person's chat and turns each
call into a `sendMessage` call whose card opens it.

## Consequences

- A gemie can hold a real back-and-forth with another, and the person can read all of it, live or
  later, in the same thread they read their own conversations in.
- The gemie that wrote answers the person later, not in the same turn: its live turn says whom it
  wrote to, and its result arrives as a new reply in that chat (a continuation waits for the chat to
  be quiet, so it lands after the reply that wrote).
- Each exchange costs two turns (the answer, then the continuation) instead of one; the chain bounds
  are what keep that finite and affordable.
- Old clients: an Alia build with `@gemies/sdk` before 7.0.0 draws `sendMessage` as an ordinary tool
  step and lists nothing under Between gemies; it never shows a conversation between gemies as the
  person's own, because the listing does not return them by default.

## Enforcement

- `lib/chat/gemies/__tests__/engine.test.ts`: several turns back and forth, the answering gemie with
  no way to write, both bounds stopping a gemie that would never stop, once-per-turn writing, a
  failure told to the writer, retries replaying instead of answering twice, supersession, and the
  chain's end revoking both tasks and idling both conversations.
- `db/__tests__/gemieConversations.pgdb.test.ts`: one conversation per person and pair under a race,
  apart from the person's own; a chain of several turns on Postgres stored complete and readable as
  the view reads it; migration 0171 replayed over stored consultations, idempotently.
- `lib/tools/__tests__/send-message.test.ts`, `lib/__tests__/capability-grants.test.ts`,
  `app-confined-agents.test.ts`, `alia-gemie-guarantees.test.ts`: reach, grants, the space cut, the
  recipient's gates, no `sendMessage` in a nested turn, a channel or a local one.
- `lib/tools/__tests__/agent-turn-alia-and-space.test.ts`: Alia's turns hold no memory tool.
- `lib/external-agents/__tests__/tool-lane.test.ts` and `tool-server-conversation.test.ts`: an
  external agent writes only from its owner's chat with it, never from a conversation it was not
  given, another gemie's chat or one between gemies.
- SDK: `tests/runtime/gemie-conversations.test.ts` and `room-events.test.ts` (the card's live state,
  the lead's reply), `GemieThread.agent-chat.test.tsx` (the card instead of a step).
