import { Kaana } from '@kaana.ai/sdk';
import { describe, expect, it } from 'vitest';
import catalogue from './fixtures/cache-write-catalogue.json';

// Exact public Go serializer output from Kaana b95d983e (LoadPublicCatalogue +
// inventory.Load + nativePricedDeclaration.render), including legitimate cache
// write prices. No production catalogue lookup or inference occurs in this test.
function client(body: unknown) {
  return new Kaana({
    credential: 'oxy_sk_synthetic_catalogue_fixture',
    maxRetries: 0,
    fetch: async () =>
      Response.json(body, { headers: { 'Kaana-Request-Id': 'catalogue-fixture' } }),
  });
}

describe('published Kaana catalogue contract', () => {
  it('decodes the real producer shape without removing cache-write tariffs', async () => {
    const result = await client(catalogue).models.list();
    expect(result).toHaveLength(catalogue.data.length);
    for (const [index, model] of result.entries()) {
      expect(model.pricing).toEqual(catalogue.data[index].pricing);
      expect(
        model.pricing?.unitPrices.some((price) => price.unit === 'cache_write_input_tokens'),
      ).toBe(true);
    }
  });

  it('still rejects unrecognized pricing units as a protocol error', async () => {
    const invalid = structuredClone(catalogue);
    invalid.data[0].pricing.unitPrices[0].unit = 'unrecognized_usage_unit';
    await expect(client(invalid).models.list()).rejects.toMatchObject({
      name: 'KaanaProtocolError',
    });
  });
});
