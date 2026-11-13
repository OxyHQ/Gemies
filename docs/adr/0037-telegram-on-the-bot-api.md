# 37. Telegram runs on its official Bot API: a person's account through Telegram Business, and a gemie's own bot

*Telegram usa solo su Bot API oficial: la cuenta de una persona por Telegram Business y el bot propio
de cada gemie.*

**Status:** Accepted

**Date:** 2026-11-13

## Context

Telegram reached Gemies three ways, none of them working in production:

- a person's Telegram account was an MTProto session (GramJS) logged in with a QR code, which
  needed an app `api_id`/`api_hash` that was never configured: production offered Telegram and
  could not link it (ADR 0035, amendment);
- Alia had a system bot (Telegraf, long polling), never given a token in production;
- a person could register a bot for an agent (`POST /bots/telegram`, a webhook on the API), with a
  per-bot secret stored in the clear to route its updates. One existed, with no messages.

Three Telegram clients, three ways to send, and an account login Telegram does not want bots to
use. The owner asked for two things on the official Bot API only: a person's account through
Telegram Business, and a bot of each gemie's own; and that Gemies be fully autonomous: "la sesión
no debe cerrarse, si no el agente no podría ser 100 % autónomo y los usuarios tendrían que estar
entrando cada vez".

## Decision

1. **One Bot API layer**, in the integrations process (`packages/integrations/src/telegram/`): one
   client (`bot-api.ts`), one webhook and inbox, one sender. The MTProto gateway, GramJS, Telegraf,
   the Alia system bot and the API's Telegram channel plugin are removed, with
   `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`, `TELEGRAM_BOT_SECRET` and the tables they used.
2. **The public API is the only ingress.** Every bot's webhook is
   `${API_BASE_URL}/webhooks/telegram/<botId>`; the API relays the delivery, untouched, to the
   private integrations process as the API workload (oxy-infra keeps that process off the
   internet: it also runs terminals and browsers). The proof of origin is Telegram's
   `secret_token`, derived per bot from its id and `TOKEN_ENCRYPTION_KEY`, so it is never stored.
3. **Nothing is lost across deploys.** An update is written to `telegram_updates` before it is
   acknowledged, handled after, and swept at startup and every minute until it succeeds or uses
   its attempts. Webhooks heal themselves: every bot's is registered at startup and checked with
   `getWebhookInfo` every ten minutes.
4. **A person's Telegram is a connected account of a gemie** (ADR 0035), through Telegram Business
   and ONE shared Gemies bot (`TELEGRAM_BOT_TOKEN`). The panel's link opens the bot with a
   one-time code (`/start <code>`), which tells it the person's Telegram account; the person adds
   the bot in Telegram › Settings › Telegram Business › Chatbots. Either order works.
   - **It never expires here.** The connection is kept as Telegram last reported it. Turned off in
     Telegram it is `paused`, and it resumes by itself when turned on again; linking the same
     Telegram to another gemie moves it (`logged-out` for the one it left). There is no "sign in
     again" state.
   - **Every change reaches the API at once** (`POST /channel-accounts/session`), so a gemie's
     tools follow Telegram with nobody opening Gemies.
   - **Truthful tools.** The Bot API has no chat list and no history, and covers private chats
     only: `listAccountChats` and `readAccountMessages` answer what arrived since it was connected,
     and say so; `sendAccountMessage` writes only where the contact wrote in the last 24 hours and
     Telegram granted "Reply to messages", and says why when it cannot.
   - **Who it answers** is the account's (`replies`), as for WhatsApp; there are no groups.
   - `sendTelegramMessage` and the `telegram` notification channel write to the person themselves,
     in their own chat with the shared bot, through the Telegram they linked.
5. **A gemie's own bot** is a card of its editor, apart from connected accounts (those are a
   person's; this is the gemie's). Whoever may act as the gemie pastes a @BotFather token; the bot
   takes the gemie's name, description, tagline and picture (`setMyName`, `setMyDescription`,
   `setMyShortDescription`, `setMyProfilePhoto`, with the avatar drawn by the editor as a JPEG).
   - The API keeps the bot (`bots`, the token `encryptedText`) and runs every turn
     (`POST /channel-bots/telegram/:botId/messages`); the integrations process lists the bots
     (`GET /channel-bots/telegram`) to speak as them.
   - People talk to the gemie in private; in a group it answers only when mentioned, named in a
     command or replied to (`group_replies`: mentions | never). Each chat is one of the gemie's
     conversations, kept for the person who connected the bot.
   - The turn is the gemie's own: no personal tools, memory or authority of anyone's. The gemie's
     balance pays first, then the person who connected the bot if they allowed it; only they can
     change that.

## Consequences

- The owner creates the shared bot in @BotFather (Business Mode on) and stores its token in
  `/oxy/alia-integrations/TELEGRAM_BOT_TOKEN`; until then the API does not offer Telegram as a
  connected account, and gemies' own bots work regardless.
- Telegram Business needs Telegram Premium; the panel says so.
- In a group, a bot in privacy mode sees only replies and commands that name it; to answer plain
  @mentions it must be a group admin or have privacy off in @BotFather. The editor says so when
  Telegram reports privacy on.
- `@BotFather`'s token is the bot's only credential: removing the bot from a gemie stops its
  webhook here, and the bot stays its owner's in @BotFather.
- Migrations: the API's `0151` (pre) adds `paused` and `can_reply` to connected accounts and
  `group_replies` to bots, `0152`/`0153` (post) drop the stored webhook secrets and the
  `agent_bot` inbound kind; the integrations database's `0003` (pre) creates the Bot API tables and
  `0004` (post) drops the MTProto ones (0 rows in production).

## Amendment (2026-11-13): a person's Telegram is theirs, granted to their gemies

ADR 0035's latest amendment makes a connected account the person's: decision 4's "connected account
of a gemie" is now an account the person connects once in Settings and grants to their gemies, one
of which may answer it. Linking the same Telegram again leaves the earlier account `logged-out`;
`sendTelegramMessage` reaches the person through a Telegram they granted the turn's gemie. A
gemie's own bot (decision 5) is unchanged and stays the gemie's.

## Amendment (2026-11-13): a gemie's bot recognises its person, whose turn there is theirs

**Context.** In production the person who connected Eusebio's bot asked it, from their own Telegram,
"¿qué hay en mi email?" and got "no tengo acceso a tu email"; asked for "un mensaje en 1 minuto", it
said it could not schedule. Every bot turn ran as decision 5 said, as nobody: no person
(`actsForPerson: false`, `requesterAccountId: null`), no Oxy task, no skills, no memory, no session
runtime — eight public tools where the same turn in the app assembles hundreds (Inbox, its own
mailbox, memory, accounts, browser, computer, scheduling). And nothing told the bot which Telegram
account was its person's. The owner's requirement: a person's turn has exactly the same
capabilities through any channel as in the app.

**Decision.** Decision 5 is amended:

1. **The bot recognises one person, the one who connected it** (`bots.user_id`: its chats are kept
   for them and they alone consent to pay). They link their Telegram once from the editor: *Link my
   Telegram* mints, with their session, a durable Oxy task in which they are the effective account
   and the gemie the actor (`bots.oxy_task_id`: the same kind of standing authority a connected
   account and scheduled work hold), and opens `t.me/<bot>?start=<code>`. The `/start <code>` that
   Telegram then sends binds the Telegram account that sent it (`bots.linked_telegram_user_id`); the
   code is one-time, 15 minutes, and stored only as a hash.
2. **Their private messages from that account are their turns**, run through the same chat route
   as the app (`/alia/chat`, as the verified `gemie_bot` channel identity): same tool assembly, same
   prompt, memory and skills, same session runtime, same billing (theirs). The only tools that differ
   are the ones whose precondition is the app itself: minting an agent needs a live bearer, and the
   question/plan cards need a client that draws them (`channel-turn-parity.test.ts` names them).
3. **Everybody else is a third party**, as decision 5 said: a stranger, an unlinked person, a link
   whose task is gone, and the person in a group (where everybody reads the answer). Public tools
   only; the prompt says how the person links, so the answer is never a bare "no access".
4. **Durable work started there borrows the task as it is** (follow-ups, background runs,
   scheduled tasks): ending a session never revokes a task a standing binding holds
   (`heldByStandingBinding`); unlinking or removing the bot does.
5. **The gemie writes back where it was asked.** A message it posts on its own into one of its bot's
   conversations is sent to that Telegram chat too; a task created in a conversation delivers there.

**Consequences.** Migration 0163 (pre) adds the four nullable `bots` columns. A connected account's
turn (a contact writing to the person's WhatsApp or Telegram Business) is not the person and does
not get the session runtime or task creation. The base prompt asks every gemie to say how to grant
what is missing instead of "I have no access".

## Amendment (2026-11-13): the bot follows its gemie by itself

The owner: "no tiene sentido el botón de sync profile, debería ya hacerlo instantáneamente
automáticamente en cualquier cambio". The editor's "Sync profile" button is gone, and so is the photo
the editor drew:

- **Every change that a gemie's bot shows** (its name, colour, look, tagline or description) is made
  on the server, by `applyAgentEdit`: an `oxy` gemie's name and colour are written to its Oxy account
  there, as the person editing, rather than by the editor at Oxy. That edit marks the bot behind
  (`bots.profile_dirty_at`); after a 3-second debounce the API gives the bot the new profile, and the
  run reaper's sweep takes over what an instance left behind. Durable and coalesced.
- **The photo is drawn on the server**, with one shared renderer, Bloom's
  `@oxy.so/bloom/agent-avatar/svg` (`renderAgentAvatarPicture`): the character in its colour,
  centred for Telegram's circular crop, on a much lighter tint of that colour that always keeps it
  visible. It is uploaded only when the look or the colour changed (`profile_photo_key`), and a part
  already as wanted is not set again, because Telegram rate-limits profile updates.
- **Only a failure is shown**, with a retry (`PATCH … { retryProfileSync: true }`), the one manual
  control left; failures are retried by themselves with a backoff, or after Telegram's
  `retry_after`.

## Amendment (2026-11-13): every kind of message reaches the gemie

A sticker sent to a gemie's bot never reached it: only text and captions were read. Every channel
now reads a message into one shared model (`GemieChannelMessage`, `@gemies/server`), so Telegram and
WhatsApp carry the same things the same way:

- Photos, stickers (static, or an animated one's still), documents and a video's, round video's or
  GIF's first frame are kept as the person's private Oxy files and stored as `file` parts of the
  message, like an app attachment. Voice notes and audio are transcribed through the dictation path,
  and the transcript travels with the file part.
- Locations, venues, contacts, polls, dice, replies (quoted) and forwards (their origin) are said in
  words; a kind that cannot be read, or media that could not be fetched, kept or transcribed, is
  named in the message rather than dropped.
- A gemie's bot is subscribed to `edited_message` too (the webhook heals to the new
  `allowed_updates` by itself): an edit updates the stored message and is not answered again. The
  gemie may react to a message with an emoji (`setMessageReaction`), and an image its answer shows is
  sent as a photo.

