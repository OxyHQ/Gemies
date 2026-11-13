/**
 * A gemie bot's profile (ADR 0037): set part by part, only what changed (Telegram rate-limits
 * profile updates), with the photo drawn on the server, and a rate limit said back with Telegram's
 * own `retry_after`.
 */

import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const drawn = vi.hoisted(() => ({ calls: [] as Array<[unknown, string | null]> }));
vi.mock('../bot-photo', () => ({
  renderBotPhoto: vi.fn(async (character: unknown, color: string | null) => {
    drawn.calls.push([character, color]);
    return Buffer.from([0xff, 0xd8, 0xff]);
  }),
}));
vi.mock('../../shared/api-client', () => ({ APIClient: class {} }));

import { gemieBotsRouter } from '../gemie-bots';

const TOKEN = `8000000002:${'B'.repeat(35)}`;
/** What Telegram holds for the bot, and every method called. */
const telegram = vi.hoisted(() => ({
  held: { name: 'Viajes', description: 'A travel gemie.', short_description: 'Plans your trips' },
  calls: [] as string[],
  limited: null as string | null,
}));

let server: Server;
let base = '';
beforeAll(async () => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (!String(url).startsWith('https://api.telegram.org/')) return realFetch(url, init);
    const method = String(url).split('/').pop() ?? '';
    telegram.calls.push(method);
    if (telegram.limited === method) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 42',
          parameters: { retry_after: 42 },
        }),
        { status: 429 },
      );
    }
    const result =
      method === 'getMe'
        ? { id: 8000000002, is_bot: true, first_name: 'Viajes', username: 'viajes_bot' }
        : method === 'getMyName'
          ? { name: telegram.held.name }
          : method === 'getMyDescription'
            ? { description: telegram.held.description }
            : method === 'getMyShortDescription'
              ? { short_description: telegram.held.short_description }
              : true;
    return new Response(JSON.stringify({ ok: true, result }));
  });
  const app = express();
  app.use(express.json());
  app.use('/telegram/bots', gemieBotsRouter());
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
});
beforeEach(() => {
  telegram.calls = [];
  telegram.limited = null;
  drawn.calls = [];
});

async function profile(body: Record<string, unknown>) {
  const response = await fetch(`${base}/telegram/bots/profile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, profile: body }),
  });
  return (await response.json()) as Record<string, unknown>;
}

const SAME = {
  name: 'Viajes',
  description: 'A travel gemie.',
  shortDescription: 'Plans your trips',
  photo: null,
};

describe('a gemie bot’s profile', () => {
  it('sets nothing Telegram already shows', async () => {
    expect(await profile(SAME)).toEqual({
      profile: { name: true, description: true, photo: false },
    });
    expect(telegram.calls.filter((method) => method.startsWith('set'))).toEqual([]);
  });

  it('sets only what changed, and draws the photo on the server', async () => {
    const character = { shape: 'circle', eyes: 'oval', eyewear: 'none', accessory: 'none' };
    expect(
      await profile({ ...SAME, name: 'Viajes Pro', photo: { character, color: '#ff8b67' } }),
    ).toEqual({ profile: { name: true, description: true, photo: true } });
    expect(telegram.calls.filter((method) => method.startsWith('set'))).toEqual([
      'setMyName',
      'setMyProfilePhoto',
    ]);
    expect(drawn.calls).toEqual([[character, '#ff8b67']]);
  });

  it('stops at a rate limit and says when to come back', async () => {
    telegram.limited = 'setMyName';
    expect(await profile({ ...SAME, name: 'Viajes Pro', description: 'New.' })).toEqual({
      profile: { name: false, description: false, photo: false },
      retryAfter: 42,
      error: 'Too Many Requests: retry after 42',
    });
    expect(telegram.calls).not.toContain('setMyDescription');
  });
});
