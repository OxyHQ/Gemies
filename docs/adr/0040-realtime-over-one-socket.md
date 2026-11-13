# 40. Realtime over one socket: an account log, typed frames, the turn on SSE

*Tiempo real por un solo socket: un registro por cuenta, eventos tipados y el turno por SSE.*

**Status:** Accepted

**Date:** 2026-11-13

## Context

The owner: "todo debemos usar sockets para que todo vaya en tiempo real como una app rollo whatsapp,
porque las conversaciones deben ser todo instantáneo, y en el sidebar igual debe actualizarse como
en whatsapp, y en la conversación debe verse cuando un agente está escribiendo".

What existed was the opposite of one layer. A signed-in tab opened up to four Socket.IO connections
(notifications, the "Ask Alia" activity, each agent run's panel, the local model runtime), each
with its own subscribe message; the sidebar, credits, notifications, external agents and local
runtimes were polled (755 requests in 12 minutes from one tab on 2026-11-13, until 429s); an open
conversation learned of a gemie's message through one event, a reaction through another and a room
through a third, each wired by the host; a client that reconnected missed whatever happened while
it was away until the next refetch; and nothing said that a gemie was writing.

## Decision

1. **One authenticated connection per client and account**, held by `@gemies/sdk`
   (`GemieRuntimeProvider` → `GemieRealtimeProvider`), shared by every screen. The server joins it
   to the account's room on connect; topics (`agent:<id>`, `agent-session:<id>`) are subscribed with
   their own gates and re-subscribed after a reconnect.
2. **One event, `rt`, with typed frames.** Durable frames are changes a client must not miss:
   conversations (row, new messages, rewrite), deletions, reactions, the person's gemies, credits,
   notifications, connections. Signals are true only while they happen: activity ("typing…"),
   room frames, presence, runtimes, show progress, an agent run's detail.
3. **A per-account event log in Postgres** (`account_events`, numbered by a head row updated in the
   same statement), appended after the change commits, kept three days. A client catches up from its
   cursor with `rt:sync`; one too far behind reloads once. HTTP reads carry the cursor they reflect.
4. **The turn's tokens stay on SSE** on the request that sent it: it is the public OpenAI-compatible
   contract, and its abort, Stop, budget and typed failure belong to the request. Other devices see
   "typing…" and then the stored message, merged by the id the sender drew it under.
5. **Unread is a column** (`conversations.unread_count`) raised by the writers whose messages nobody
   watched arrive, and zeroed by `POST /v1/conversations/:id/read`.
6. **No polling where an event exists**; the app's guard (`no-background-polling.test.ts`) lists the
   few timers that remain and why.

## Consequences

- `GemieRuntimeHost` loses `subscribeConversationMessages`, `subscribeConversationReactions` and
  `subscribeRoomEvents`: the SDK owns the connection (`@gemies/sdk` 5.0.0, a major version).
- `alia:activity` is still emitted for the "Ask Alia" buttons of Oxy apps on an older SDK, until
  they are on 5.0.
- Every new writer of a conversation calls `publishConversation` after its commit; a writer that
  forgets it is stale until the next read, which review and `docs/realtime.mdx` guard.
- The local model runtime rides the same connection (`send`/`listen`), so a device offering its
  models holds one socket, not two.
- No new WebSocket route and no infrastructure change: Socket.IO keeps `/socket.io/`, the Redis
  adapter carries the fan-out, and its 25 s ping sits inside the ALB's 60 s idle timeout.

Details: [Realtime](../realtime.mdx).
