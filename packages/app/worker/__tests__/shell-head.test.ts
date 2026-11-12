import { describe, expect, it } from 'vitest';
import worker from '../index.js';

/** The app shell as the asset server answers it: Expo's default single-page `index.html`. */
const SHELL = '<!doctype html><html><head><title>Gemies</title></head><body></body></html>';
const env = (contentType = 'text/html; charset=utf-8', body = SHELL) => ({
  ASSETS: {
    fetch: async () =>
      new Response(body, { status: 200, headers: { 'content-type': contentType } }),
  },
});

describe("the shell's metadata, written by the Worker", () => {
  it('gives every route the share card with the Gemies image and its own URL', async () => {
    const html = await (await worker.fetch(new Request('https://gemies.ai/c/abc'), env())).text();
    expect(html).toContain('<meta property="og:image" content="https://gemies.ai/og-image.jpg" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('<meta property="og:url" content="https://gemies.ai/c/abc" />');
    expect(html).toContain('<meta name="description" content="Create your Gemies.');
    // Written inside the head, once.
    expect(html.indexOf('og:image')).toBeLessThan(html.indexOf('</head>'));
    expect(html.match(/og:image"/g)).toHaveLength(1);
  });

  it('leaves everything that is not the shell alone', async () => {
    const script = 'console.log(1)';
    const response = await worker.fetch(
      new Request('https://gemies.ai/sdk/voice-worklets/0123456789abcdef.js'),
      env('text/javascript', script),
    );
    expect(await response.text()).toBe(script);
  });
});
