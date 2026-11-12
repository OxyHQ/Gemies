import { describe, expect, it } from 'vitest';
import worker from '../index.js';

/** The app shell, as the asset server answers any route of the single-page export. */
const env = {
  ASSETS: {
    fetch: async () =>
      new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  },
};

describe('the app has one origin', () => {
  it('sends www.gemies.ai to the apex, keeping the path and query', async () => {
    const response = await worker.fetch(new Request('https://www.gemies.ai/@pepe?thread=1'), env);
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://gemies.ai/@pepe?thread=1');
  });

  it('serves the apex itself', async () => {
    const response = await worker.fetch(new Request('https://gemies.ai/'), env);
    expect(response.status).toBe(200);
  });
});
