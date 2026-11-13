/** Workload identity configuration. No inference payload is sent to this origin. */
export const OXY_API_URL_ENV = 'OXY_API_URL';

/** The only Oxy origin a deployed Alia task may request workload identity from. */
export const OXY_IDENTITY_ALLOWED_ORIGINS: readonly string[] = ['https://api.oxy.so'];

/**
 * Every variable needed to build the SDK client on a machine that cannot attest.
 *
 * A list of NAMES, which is all a `.env.example` or a runbook can be. What a
 * given environment is actually missing is {@link unsetOxyIdentityVariables},
 * because a deployed task needs none of the credential half (oxy ADR 0026).
 */
export const OXY_IDENTITY_REQUIRED_ENV: readonly string[] = [OXY_API_URL_ENV];

export type OxyDeploymentEnvironment = 'development' | 'staging' | 'production';

export function resolveOxyDeploymentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): OxyDeploymentEnvironment {
  if (env.NODE_ENV === 'production') return 'production';
  if (env.NODE_ENV === 'staging') return 'staging';
  return 'development';
}

/**
 * Variables absent from an otherwise required SDK configuration.
 *
 * Delegated rather than filtered over {@link OXY_IDENTITY_REQUIRED_ENV}: the
 * answer is not a per-name presence test any more, because a task that attests
 * its ECS role needs no credential pair at all. Two implementations of that one
 * rule is how the boot guard and the client come to disagree about whether this
 * process can reach Oxy — and this is the side that calls `process.exit(1)`.
 */
export function unsetOxyIdentityVariables(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return (env[OXY_API_URL_ENV] ?? '').trim() ? [] : [OXY_API_URL_ENV];
}

/** Why an Oxy base URL is unsafe, or `null` when it is approved. */
export function oxyIdentityEndpointRefusal(
  value: string,
  deployment: OxyDeploymentEnvironment,
): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${OXY_API_URL_ENV} is not an absolute URL`;
  }

  if (url.username !== '' || url.password !== '') {
    return `${OXY_API_URL_ENV} carries credentials in the URL`;
  }
  if (url.search !== '' || url.hash !== '') {
    return `${OXY_API_URL_ENV} carries a query string or fragment`;
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return `${OXY_API_URL_ENV} must name the Oxy API origin, not a path`;
  }
  if (OXY_IDENTITY_ALLOWED_ORIGINS.includes(url.origin)) return null;

  const loopback =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (deployment === 'development' && loopback) return null;

  return (
    `${OXY_API_URL_ENV} points at ${url.origin}, which is not an approved Oxy identity origin ` +
    `(${OXY_IDENTITY_ALLOWED_ORIGINS.join(', ')})`
  );
}
