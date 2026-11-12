/**
 * Alia, the official global gemie (ADR 0034 §2).
 *
 * One `agents` row that everybody uses, seeded by migration 0135 and matched by this id, never by
 * name or handle. What made Alia different is configuration of that row (`memory_store = 'nilo'`,
 * `reach = 'person'`, `mailbox = false`, `task_authority = 'standing'`, no `computer` grant), so
 * this id decides nothing about how a turn runs. It is read for three things:
 *
 *  - the default gemie (ADR 0034 §4): a turn, a conversation, a call or a task that names no gemie
 *    is Alia's (`lib/alia-gemie.ts`), and so are the lanes that exist only for her (her outreach
 *    conversation, the system channel bots);
 *  - rooms: a group or a space room belongs to her gemie, the one that is everybody's
 *    ({@link ROOM_GEMIE_ID}); its speakers are its members;
 *  - the public wire, which still spells Alia as no `agentId` until the routes and events take the
 *    Gemies vocabulary (ADR 0034 §6), so a chat with Alia looks exactly as it did
 *    ({@link publicAgentId}).
 *
 * A leaf: imports nothing.
 */

export const ALIA_GEMIE_ID = '01a1cf00-cecf-7a24-868b-42b452105a6f';

/**
 * The gemie a group or a space room belongs to (ADR 0034 §1: every conversation belongs to one). A
 * room has no lead — its speakers are its `conversation_members` — so it belongs to the gemie that is
 * everybody's rather than to one of its members, and nothing reads this column to find who speaks.
 */
export const ROOM_GEMIE_ID = ALIA_GEMIE_ID;

/**
 * What `agents.oxy_account_id` holds for Alia until Oxy gives her gemie its account (ADR 0034
 * phase 2, Oxy's contract). Not an Oxy id (Oxy's are ObjectIds), so Oxy resolves it to nobody:
 * `POST /users/by-ids` drops it, availability answers "anywhere", and nobody holds `act_as` over
 * it, so nobody can edit the row through the API. Nothing sends it to Oxy as authority: Alia's
 * Oxy calls go through the person lane (`lib/gemie-oxy-actor.ts`) and she has no mailbox.
 */
export const ALIA_PENDING_OXY_ACCOUNT_ID = 'pending-oxy-account:alia';

/**
 * The `agentId` the public wire carries for a stored gemie: Alia is `null`, as she always was.
 *
 * Applied where a response, a stream frame or a socket event names the gemie of a conversation, a
 * call or a session. The inbound side needs nothing: a request that names no gemie is Alia's, and
 * one that names her id resolves to the same row.
 */
export function publicAgentId(agentId: string | null): string | null {
  return agentId === ALIA_GEMIE_ID ? null : agentId;
}
