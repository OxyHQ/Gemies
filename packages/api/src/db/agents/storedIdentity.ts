/**
 * Where a gemie's identity is stored (ADR 0036), read back as the `StoredAgentIdentity` union.
 *
 * Its own module rather than the agent repository's, because every repository that projects an
 * agent (a session's, a search's) reads the same four columns the same way.
 */

import { agents } from '../schema/agents';
import type { StoredAgentIdentity } from '../../domain/agent';

/** The columns a gemie's identity is stored in, for a read that projects rather than selects the row. */
export const agentIdentityColumns = {
  identitySource: agents.identity,
  oxyAccountId: agents.oxyAccountId,
  localName: agents.localName,
  localColor: agents.localColor,
};

export interface AgentIdentityColumns {
  identitySource: string;
  oxyAccountId: string | null;
  localName: string | null;
  localColor: string | null;
}

/**
 * The identity those columns store. `agents_identity_check` guarantees the columns of each source
 * are set, so a row that breaks it is a fault, refused loudly rather than read as somebody else.
 */
export function readStoredIdentity(columns: AgentIdentityColumns): StoredAgentIdentity {
  if (columns.identitySource === 'local') {
    if (columns.localName === null || columns.localColor === null) {
      throw new Error('a local gemie row has no name or colour');
    }
    return { source: 'local', name: columns.localName, color: columns.localColor };
  }
  if (columns.oxyAccountId === null) throw new Error('an Oxy gemie row names no account');
  return { source: 'oxy', oxyAccountId: columns.oxyAccountId };
}
