# 35. A connected account belongs to one gemie; Gmail and Signal are retired

*Una cuenta conectada es de un gemie; Gmail y Signal se retiran.*

**Status:** Accepted

**Date:** 2026-11-13

## Context

The owner's decision of 2026-11-13: "lo de connected accounts va por Gemie, así que hay que quitarlo del
settings y ponerlo en el settings de cada gemie, y quitar gmail y signal".

Until now a connected account (WhatsApp, Telegram, Signal, Gmail) was the PERSON's: a row of
`connected_accounts` with an `auto_reply_agent_id` nothing ever read. Every message that arrived on
one was answered by Alia, and the WhatsApp tools of every gemie's turn reached the person's
WhatsApp. Gmail never ran in production (no Google OAuth client was configured for it) and no Signal
account was ever linked.

## Decision

1. **An account belongs to exactly one gemie.** `connected_accounts.agent_id` (NOT NULL, foreign key
   to `agents`, cascading). The person who linked it stays on the row (`oxy_user_id`): the gemie
   answers for them, and every reader is scoped to both.
2. **That gemie answers it.** The channel context of a turn that arrives on the account names the
   gemie (`middleware/channel-auth.ts`); a request cannot name another. With no person present, it
   is authorised by the unattended rule automations already use (`unattendedReach`): the person's
   own gemie or a public active one, in no app.
3. **Only that gemie uses it.** The WhatsApp tools are offered to a turn only when its gemie has a
   connected WhatsApp of its person, and they reach only that one.
4. **Managed under the gemie** (`/agents/:id/accounts…`) by whoever may act as it — the check of
   `PATCH /agents/:id` (`loadAgentForActor`) — except Alia, the person's own assistant (`reach =
   'person'`), to whom every person links their own accounts, since Oxy's lane for her is the
   person's own. The account's Oxy task names the gemie's actor (`oxyActorFor`). The user-level
   `/accounts` routes are gone; the Gemies app moves the section from Settings to each gemie's
   editor, and the Alia app links them to Alia's gemie.
5. **Deleting a gemie** ends its accounts' sessions and revokes their tasks, then the rows cascade.
6. **Gmail and Signal are retired:** adapters, signal-cli and its Java runtime in the integrations
   image, the Signal channel plugin, the `signal_*` tables, the `signal` conversation source, the
   Gmail OAuth columns and routes. The per-account settings no turn ever honoured go too
   (`auto_reply*`, `custom_context`, `allowed_tools`, `blocked_tools`, `allowed_skill_ids`), and so
   do the notification channels that reached a person through their connected account
   (`whatsapp`, `discord`, `slack`), which no notification ever named.

## Migration

`0141` (pre) adds `agent_id` nullable with the foreign key NOT VALID. `0142` (post) deletes Gmail and
Signal rows, backfills `agent_id` (the `auto_reply_agent_id` gemie when it exists and the person
could run it unattended, else Alia), validates the key, sets NOT NULL and drops the columns. `0143`
and `0144` (post) narrow `conversations.source` (NOT VALID, then VALIDATE). The integrations
database's `0001` (post) drops the `signal_*` tables. Production held 0 connected accounts, 0 Signal
sessions and 0 `signal` conversations when they were written.

## Consequences

- An old Gemies or Alia build that still calls `/accounts` gets 404 for it; nothing outside the two
  apps used it but the Astro browser's Gmail tile, which could never connect.
- A private gemie shared by membership cannot answer an account (no bearer to ask Oxy with), the same
  as for automations.

## Amendment (2026-11-13): it has to work, and the person says who it answers

The owner asked for it to work end to end and to be improved where it clearly helps, looking at
Manus (QR onboarding into its own agent, one disconnect) and at assistants that answer on a
person's own WhatsApp (pairing or allowlists for direct chats, groups answered only when
mentioned). What production showed:

- the old Settings screen never drew the QR code the gateway returned, so a WhatsApp link could
  never be scanned (the two attempts in the logs were removed seconds later);
- the API stored only the statuses it shared with the gateway, so an account unlinked from the
  phone stayed `connected`;
- every message on an account was answered, in groups too;
- Telegram is not configured in production (`TELEGRAM_API_ID`/`TELEGRAM_API_HASH`), yet it was
  offered.

Decided:

1. **One API ↔ gateway contract** (`@gemies/server/internal`), one gateway router for every
   platform, and the session status vocabulary stored as the gateway reports it (0145/0146).
2. **Who it answers** is the account's: `replies` = everyone (default) | chosen chats | nobody, and
   `group_replies` = mentions (default) | never. Enforced in the API (`shouldAnswer`), asked by the
   gateway before a turn; a message not to answer gets no reply.
3. **Only what can be linked is offered** (`GET /accounts/platforms`).
4. **Live status and last activity** on each account; removing one logs the provider session out
   and deletes what the gateway synced.
5. **One set of tools** for every platform (`listAccountChats`, `readAccountMessages`,
   `sendAccountMessage`), replacing the WhatsApp-only ones.

Not adopted now: an approval step before the gemie sends (the tool is already `R2` and is used
only when the person asks; an approval inbox is its own feature), and pairing codes instead of a
QR (both platforms' QR flows are what their apps offer for a linked device).
