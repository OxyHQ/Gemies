/** Protocol between the Gemies API and its integrations process, not end-user authentication. */
import { GEMIES_APPLICATION_ID } from './identity.js';
export { GEMIES_APPLICATION_ID, GEMIES_SERVICE_AUDIENCE } from './identity.js';

/** Registry handles of the deployment's exact AWS task roles. Never API keys. */
export const GEMIES_API_WORKLOAD_ID = 'wl_d50a0056191d0448024900b4';
export const GEMIES_INTEGRATIONS_WORKLOAD_ID = 'wl_9aa00c7726a03a40d670b0cb';
export const GEMIES_ACCOUNT_CONTEXT_HEADER = 'x-alia-account-context';
export const GEMIES_CHANNEL_HEADER = 'x-alia-channel';
export const GEMIES_PLATFORM_USER_HEADER = 'x-alia-platform-user';

export function isGemiesWorkload(
  principal: { authority?: string; applicationId: string; credentialId: string } | undefined,
  expectedWorkloadId: string,
): boolean {
  return (
    principal?.authority === 'first_party' &&
    principal.applicationId === GEMIES_APPLICATION_ID &&
    principal.credentialId === expectedWorkloadId
  );
}
export const GEMIES_CHANNEL_SESSION_HEADER = 'x-alia-channel-session';

export type GemieChannelIdentity =
  | { kind: 'bot'; platformUserId: string }
  | { kind: 'account'; sessionId: string };

export * from './accounts.js';
