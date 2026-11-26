import Conf from 'conf';

/** The Gemies API (Gemies ADR 0034). */
export const DEFAULT_API_BASE_URL = 'https://api.gemies.ai';

/**
 * The backend's previous host. A stored value equal to it is an old default, not a choice, and is
 * rewritten once to the current host.
 */
export const RETIRED_API_BASE_URL = 'https://api.alia.onl';

interface ConfigSchema {
  apiBaseUrl: string;
}

/**
 * The daemon's settings. `projectName` is the one the Codea CLI used (Gemies ADR 0043 §6): a machine
 * paired with `codea connect` carries over to `gemies connect` without pairing again, and the keys
 * Codea keeps beside these (its chat sessions) are left alone.
 */
export const config = new Conf<ConfigSchema>({
  projectName: 'alia-codea-cli',
  defaults: { apiBaseUrl: DEFAULT_API_BASE_URL },
});

if (config.get('apiBaseUrl') === RETIRED_API_BASE_URL) {
  config.set('apiBaseUrl', DEFAULT_API_BASE_URL);
}
