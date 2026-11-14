import { describe, expect, it, vi } from 'vitest';
import { createGemieForOxyService, createGemieTransportForOxyService } from '../src/oxy.js';
import { GEMIES_SERVICE_AUDIENCE } from '../src/identity.js';

describe('Oxy product transport', () => {
  it('owns the canonical recipient and names the account it acts for', () => {
    const transport = { fetch: vi.fn() as unknown as typeof fetch, dispose: vi.fn() };
    const oxy = { createServiceClient: vi.fn(() => transport) };
    const actingFor = { accountId: 'account' };
    const client = createGemieForOxyService(oxy, { actingFor });
    expect(oxy.createServiceClient).toHaveBeenCalledWith({
      baseURL: 'https://api.gemies.ai',
      audience: GEMIES_SERVICE_AUDIENCE,
      actingFor,
    });
    client.dispose();
    expect(transport.dispose).toHaveBeenCalledOnce();
  });
  it('names the person when they operate the account', () => {
    const transport = { fetch: vi.fn() as unknown as typeof fetch, dispose: vi.fn() };
    const oxy = { createServiceClient: vi.fn(() => transport) };
    createGemieForOxyService(oxy, {
      actingFor: { accountId: 'bot', requesterAccountId: 'person' },
    });
    expect(oxy.createServiceClient).toHaveBeenCalledWith(
      expect.objectContaining({ actingFor: { accountId: 'bot', requesterAccountId: 'person' } }),
    );
  });
  it('exposes the same core fetch for product-specific REST endpoints', () => {
    const transport = { fetch: vi.fn() as unknown as typeof fetch, dispose: vi.fn() };
    const oxy = { createServiceClient: vi.fn(() => transport) };
    expect(createGemieTransportForOxyService(oxy, { baseURL: 'http://localhost:4150' })).toBe(
      transport,
    );
    expect(oxy.createServiceClient).toHaveBeenCalledWith({
      baseURL: 'http://localhost:4150',
      audience: GEMIES_SERVICE_AUDIENCE,
    });
  });
});
