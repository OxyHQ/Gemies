/**
 * Columns that must never leave the process in a response.
 *
 * There is no projection default — `db.select().from(t)` returns EVERY
 * column, so a naive query is the first time
 * a Baileys credential or a pending link code can be serialized into an
 * HTTP response nobody audited.
 *
 * Read through `publicColumns(table, PROTECTED_COLUMNS)` from `@oxy.so/db/assert`.
 * The exclusion is at the TYPE level: the row type has no such property, so a
 * serializer touching one fails `tsc` rather than shipping it — **provided this
 * stays `as const` and is never re-annotated with the registry type**, which
 * would widen the literals away and silently delete the compile-time half.
 *
 * Opting in is explicit and greppable: a path that legitimately needs one names
 * it. There is deliberately no helper for that — it must read differently from
 * an ordinary select.
 */
export const PROTECTED_COLUMNS = {
  /**
   * Baileys credentials and key material. Possession is the WhatsApp account.
   * `lastQr` is short-lived but is a live pairing credential while valid.
   */
  whatsapp_sessions: ['authState', 'authKeys', 'lastQr'],
  /**
   * `linkCode` is the one-time code the panel's Telegram link carries: whoever
   * sends it to the shared bot links their Telegram account to the session.
   */
  telegram_business_sessions: ['linkCode'],
  /**
   * Ciphertext, not plaintext — but ciphertext is a token to anyone who also has
   * `TOKEN_ENCRYPTION_KEY`, and the two travel together in an incident.
   */
  mcp_connector_auths: ['clientInformation', 'tokens', 'codeVerifier'],
} as const;
