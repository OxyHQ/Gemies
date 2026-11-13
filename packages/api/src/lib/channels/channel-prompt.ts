/**
 * How to answer on a messaging channel. It names nobody: callers prepend
 * `buildIdentityGuard`, which is the one owner of who the assistant is, and a
 * second name claim here would contradict the guard on a gemie's bot instead of
 * merely repeating it. The system bot (`inbound-handlers.ts`) and a gemie's own Telegram bot
 * (`lib/gemie-telegram-bot.ts`) both use it.
 */
export const DEFAULT_CHANNEL_PROMPT = `Be concise and direct — this is a messaging channel.

CRITICAL: Respond in the same language the user writes to you.

- Skip preambles ("Sure!", "Of course!"). Get to the point.
- Keep responses short. A few sentences is usually enough.
- Be honest about uncertainty.
- When the request is unclear, make a reasonable assumption and state it briefly.`;
