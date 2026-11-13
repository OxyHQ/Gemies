import { describe, expect, it } from 'vitest';
import {
  oxyIdentityEndpointRefusal,
  resolveOxyDeploymentEnvironment,
  unsetOxyIdentityVariables,
} from '../workload-identity-config.js';

describe('workload identity origin, separate from direct Kaana inference', () => {
  it('requires a configured identity origin and permits only Oxy in production', () => {
    expect(unsetOxyIdentityVariables({})).toEqual(['OXY_API_URL']);
    expect(unsetOxyIdentityVariables({ OXY_API_URL: 'https://api.oxy.so' })).toEqual([]);
    expect(oxyIdentityEndpointRefusal('https://api.oxy.so', 'production')).toBeNull();
    for (const value of [
      'https://attacker.test',
      'https://api.oxy.so/v1',
      'https://user:secret@api.oxy.so',
      'https://api.oxy.so?token=x',
      'http://localhost:3000',
    ])
      expect(oxyIdentityEndpointRefusal(value, 'production')).not.toBeNull();
  });
  it('permits loopback only for development identity services', () => {
    expect(resolveOxyDeploymentEnvironment({ NODE_ENV: 'production' })).toBe('production');
    expect(oxyIdentityEndpointRefusal('http://127.0.0.1:3000', 'development')).toBeNull();
    expect(oxyIdentityEndpointRefusal('http://127.0.0.1:3000', 'production')).not.toBeNull();
  });
});
