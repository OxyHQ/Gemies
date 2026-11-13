/** Fail closed before Alia listens unless its Kaana workload identity lane is complete. */

import { OXY_API_URL_ENV } from './workload-identity-config.js';
import {
  oxyIdentityEndpointRefusal,
  resolveOxyDeploymentEnvironment,
  unsetOxyIdentityVariables,
} from './workload-identity-config.js';

/** Why this task cannot use Kaana workload identity, or `null` when it can. */
export function kaanaBootConfigurationFailure(env: NodeJS.ProcessEnv = process.env): string | null {
  const unset = [...unsetOxyIdentityVariables(env)];
  const uniqueUnset = [...new Set(unset)].sort();
  if (uniqueUnset.length > 0) {
    return `the Kaana workload identity client is required but these variables are not set: ${uniqueUnset.join(', ')}`;
  }

  return oxyIdentityEndpointRefusal(
    (env[OXY_API_URL_ENV] ?? '').trim(),
    resolveOxyDeploymentEnvironment(env),
  );
}
