import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ log: { general: { warn: vi.fn(), error: vi.fn() } } }));
vi.mock('@oxy.so/core/server', () => ({ safeFetch: vi.fn(), readResponseBody: vi.fn() }));

const { brandMarkCandidates, sniffLogoType } = await import('../connector-logos.js');

describe('a logo is what its bytes say, not what its server claims', () => {
  it('recognizes the image formats it serves', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(sniffLogoType(png)).toBe('image/png');
    expect(sniffLogoType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffLogoType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffLogoType(Buffer.from('GIF89a…'))).toBe('image/gif');
    expect(sniffLogoType(Buffer.from([0, 0, 1, 0, 1, 0]))).toBe('image/x-icon');
    expect(sniffLogoType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      'image/svg+xml',
    );
    expect(sniffLogoType(Buffer.from('<?xml version="1.0"?><svg/>'))).toBe('image/svg+xml');
  });

  it('refuses a page that answered 200 for an icon it does not have', () => {
    expect(sniffLogoType(Buffer.from('<!DOCTYPE html><html>not here</html>'))).toBeNull();
    expect(sniffLogoType(Buffer.from('{"error":"not found"}'))).toBeNull();
  });
});

describe("a provider website's brand mark", () => {
  it('prefers the touch icon, then a vector icon, then the largest raster, then the conventions', () => {
    const html = `
      <link rel="icon" href="/favicon.ico" sizes="any"/>
      <link rel="icon" href="/static/favicon-32.png" sizes="32x32" type="image/png"/>
      <link rel="icon" href="/static/favicon-96.png" sizes="96x96" type="image/png"/>
      <link rel="icon" href="/static/favicon.svg" type="image/svg+xml"/>
      <link rel="apple-touch-icon" href="/static/apple-touch-icon.png" sizes="180x180"/>`;
    expect(brandMarkCandidates(html, 'https://linear.app/')).toEqual([
      'https://linear.app/static/apple-touch-icon.png',
      'https://linear.app/static/favicon.svg',
      'https://linear.app/static/favicon-96.png',
      'https://linear.app/static/favicon-32.png',
      'https://linear.app/apple-touch-icon.png',
      'https://linear.app/favicon.ico',
    ]);
  });

  it('falls back to the conventional paths for a page that names none, and never leaves https', () => {
    expect(brandMarkCandidates('', 'https://www.atlassian.com')).toEqual([
      'https://www.atlassian.com/apple-touch-icon.png',
      'https://www.atlassian.com/favicon.ico',
    ]);
    expect(
      brandMarkCandidates(
        '<link rel="icon" href="http://cdn.example.com/i.png">',
        'https://a.test',
      ),
    ).not.toContain('http://cdn.example.com/i.png');
  });
});
