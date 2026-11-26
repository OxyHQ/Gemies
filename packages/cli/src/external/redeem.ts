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

/**
 * Trades the code for every CLI this computer has in one request (Gemies ADR 0043): a gemie and a
 * credential per CLI, sharing a machine. Only for two CLIs or more; one goes through `redeemCode`,
 * which every Gemies version understands.
 */
export async function redeemMachine(input: {
  apiBaseUrl: string;
  code: string;
  clis: readonly ExternalCli[];
  hostName: string;
}): Promise<ConnectableAgent[] | string> {
  const { apiBaseUrl, code, clis, hostName } = input;
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/agents/external/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, clis, hostName }),
    });
  } catch (err: unknown) {
    return `Could not reach Gemies at ${apiBaseUrl}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (response.status === 400) {
    return `That code is invalid, expired or already used, or this Gemies cannot pair several CLIs at once (pick one with --cli). ${NEW_CODE_HINT}`;
  }
  if (response.status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (!response.ok) return `Gemies could not pair this machine (HTTP ${response.status}).`;
  const body = (await response.json()) as {
    agents: { agentId: string; name: string; cli: ExternalCli; credential: string }[];
  };
  return body.agents.map((agent) => ({
    agentId: agent.agentId,
    name: agent.name,
    cli: agent.cli,
    apiBaseUrl,
    credential: agent.credential,
  }));
}
