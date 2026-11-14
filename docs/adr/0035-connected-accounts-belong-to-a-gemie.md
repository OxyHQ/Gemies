# 35. A connected account belongs to one gemie; Gmail and Signal are retired

*Una cuenta conectada es de un gemie; Gmail y Signal se retiran.*

**Status:** Accepted; its per-gemie scoping (decisions 1–4 and the Alia editor amendment) superseded
by the amendment of 2026-11-13 below: an account is its person's, granted to their gemies

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

## Amendment (2026-11-13, later): Alia's editor, and failures a person can see

- **Alia's gemie has an editor in the Gemies app**, opened from her sidebar row and her chat's
  header. Her identity is shown, never editable: nobody but Oxy changes it (the API refuses any
  `PATCH` of her row, since nobody acts as her account). What the person manages there is their own
  connected accounts on her: an account is the (gemie, person) pair's, so on a gemie everybody
  shares, each person sees and manages only theirs. The card says what the caller may do
  (`viewer`), so the app never draws a control that would save nothing.
- **A gateway failure is a `503` with a code**, shown in the panel with a Retry, because a `502`
  reached the browser as a CORS error the panel could not read.
- **The web app ships after the API**, and the API offers a platform only once the gateway answers
  `GET /accounts/platforms` (the contract handshake), so no release order leaves the app calling a
  route that is not deployed.

## Amendment (2026-11-13, ADR 0037): Telegram is Telegram Business

A person's Telegram is no longer an MTProto session logged in with a QR code: it is a Telegram
Business connection to the shared Gemies bot, on Telegram's official Bot API, and it never expires
on Gemies' side. The status vocabulary gains `paused` (turned off in Telegram, resumed by itself)
and the account stores whether Telegram lets the gemie reply (`can_reply`). See
[ADR 0037](./0037-telegram-on-the-bot-api.md).

## Amendment (2026-11-13, latest): an account is the person's, granted to their gemies

The owner's correction: "lo que es el conectar la cuenta de whatsapp/telegram etc eso pienso
deberia estar en settings y poder activar segun gemies y que puedan reusar no tener que hacerlo por
agente, lo que si va por agente es lo de poder vincular gemie a un bot de telegram". It supersedes
decisions 1–4, 5's session teardown and the Alia editor amendment; the reply policy, the one
contract, the live status, the tools and Gmail and Signal's retirement stand.

1. **An account is its person's.** It is connected once, in Settings › Connected accounts
   (`/me/accounts`), several per platform if they like, and names no gemie
   (`connected_accounts.agent_id` is gone).
2. **The person grants it to their gemies** (`connected_account_grants`, written only through
   `PUT|DELETE /me/accounts/:id/gemies/:gemieId`): any gemie they may act as, and Alia, with the
   same switch. A grant is the account owner's decision, so it is not a capability grant on the
   gemie's row: a gemie's owner cannot grant another person's account, and Alia's one shared row
   could not hold every person's choice. The `messaging` family is retired with it (migration 0157):
   the account tools (`listAccountChats`, `readAccountMessages`, `sendAccountMessage`,
   `sendTelegramMessage`) are offered to a turn only over the accounts its person granted its gemie
   (`ACCOUNT_GRANTED_TOOLS`).
3. **At most ONE granted gemie answers it** (`answers`, unique per account), chosen in Settings
   (`PATCH /me/accounts/:id { answeringGemieId }`), or none. It replies on its own to what arrives,
   as the account's replies say, under the unattended rule; its Oxy task names that gemie's actor
   and moves with the choice. With none, nothing is answered. Every other granted gemie reads and
   sends through the account only when the person asks it or its tasks need it, and the tools tell
   each gemie which accounts it answers.
4. **A gemie's editor** lists the person's accounts with a switch each ("Accounts it can use"), the
   same row its connectors use (`GrantSwitchRow`), and links to Settings to connect more; Alia's
   locked editor has the same list. `viewer.mayManageAccounts` becomes `mayGrantAccounts`.
5. **Deleting a gemie** revokes the task of every account it answered; its grants cascade, and the
   accounts stay their people's, answered by nobody until they choose.
6. **What stays per gemie** is its own Telegram bot (ADR 0037), not a connected account.

Migration: `0156` (pre) creates the grants table, drops `agent_id`'s NOT NULL and grants every
account to the gemie it belonged to, which answers it; `0157` (post) does the same for accounts the
replaced image linked while it drained, never overriding a choice made since, drops `agent_id` and
removes `messaging` from every gemie's grants. Production held 0 connected accounts and 4 gemies with
`messaging` when they were written.

## Amendment (2026-11-14, ADR 0037): an account's task is renewed before it lapses

An account's Oxy task keeps the expiry Oxy gave it and is renewed with the person's present session
before it lapses, like every channel's; when renewal needs them, they are told once, with a one-tap
reauthorisation. The decision is ADR 0037's amendment of 2026-11-14.
