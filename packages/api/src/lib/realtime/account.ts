/**
 * Account-level changes on the realtime socket (`docs/realtime.mdx`): the person's gemies, credits
 * and connections. Each is a hint with the id it concerns; a client patches what it can from it and
 * re-reads the one list it names, once — never on a timer.
 */

import { publicAgentId } from '../../domain/alia-gemie.js';
import { publishAccountEvent } from './publish.js';

export type GemieChange = 'created' | 'updated' | 'deleted';

/** One of the person's gemies was made, edited (name, look, colour, status) or deleted. */
export async function publishGemieChanged(
  oxyUserId: string,
  agentId: string,
  change: GemieChange,
): Promise<void> {
  await publishAccountEvent(oxyUserId, 'gemies', { agentId: publicAgentId(agentId), change });
}

/** The account's credit balance moved: `credits` is the new balance when the writer knows it. */
export async function publishCreditsChanged(
  oxyUserId: string,
  credits?: number | null,
): Promise<void> {
  await publishAccountEvent(
    oxyUserId,
    'credits',
    credits === undefined || credits === null ? {} : { credits },
  );
}

/**
 * The person's connected accounts or connectors changed: one was connected, granted to a gemie,
 * removed, or its state moved (a WhatsApp code scanned, a connector that needs signing in again).
 */
export async function publishConnectionsChanged(oxyUserId: string): Promise<void> {
  await publishAccountEvent(oxyUserId, 'connections', {});
}
