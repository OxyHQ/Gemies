import type { PairedAgent } from './state.js';
import type { ExternalCli } from './types.js';

/** An agent this machine can connect: it holds the agent's credential. */
export type ConnectableAgent = PairedAgent & { readonly credential: string };

export const NEW_CODE_HINT =
  'Create a code in Gemies (Settings → Connect external Gemie) and paste the text it gives you into your agent.';

/**
 * Trades the code for the agent's credential. Unauthenticated by design: the code is the
 * authorisation, and this machine has, and needs, no Gemies or Oxy session.
 */
export async function redeemCode(input: {
  apiBaseUrl: string;
  code: string;
  cli: ExternalCli;
  hostName: string;
}): Promise<ConnectableAgent | string> {
  const { apiBaseUrl, code, cli, hostName } = input;
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/agents/external/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, cli, hostName }),
    });
  } catch (err: unknown) {
    return `Could not reach Gemies at ${apiBaseUrl}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (response.status === 400) {
    return `That code is invalid, expired or already used. ${NEW_CODE_HINT}`;
  }
  if (response.status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (!response.ok) return `Gemies could not pair this machine (HTTP ${response.status}).`;
  const body = (await response.json()) as { agentId: string; name: string; credential: string };
  return { agentId: body.agentId, name: body.name, cli, apiBaseUrl, credential: body.credential };
}
