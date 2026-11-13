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
