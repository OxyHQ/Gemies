/**
 * A channel message as the turn carries it (`lib/channel-messages.ts`): media kept as the person's
 * Oxy file like an app attachment, a voice note transcribed and its transcript carried with its
 * file, everything else said in words, and nothing dropped when a step fails.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => ({
  calls: [] as Array<{ oxyUserId: string; taskId: string; mime: string; name: string }>,
  fail: false,
}));
const heard = vi.hoisted(() => ({
  text: 'hola, ¿quedamos mañana?',
  calls: [] as string[],
  fail: false,
}));

vi.mock('../files/oxy-files.js', () => ({
  storeChannelMedia: vi.fn(
    async (input: { oxyUserId: string; taskId: string; mime: string; name: string }) => {
      if (stored.fail) throw new Error('Oxy is down');
      stored.calls.push({
        oxyUserId: input.oxyUserId,
        taskId: input.taskId,
        mime: input.mime,
        name: input.name,
      });
      return `file-${stored.calls.length}`;
    },
  ),
}));
vi.mock('../kaana/transport.js', () => ({ getKaanaClient: () => ({ dispose() {} }) }));
vi.mock('../voice/transcribe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../voice/transcribe.js')>();
  return {
    ...actual,
    transcribeDictation: vi.fn(async (_kaana: unknown, accountId: string) => {
      heard.calls.push(accountId);
      if (heard.fail) throw new actual.TranscriptionError('TRANSCRIPTION_UNAVAILABLE');
      return { text: heard.text, model: 'stt' };
    }),
  };
});
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { channels: child, v1: child, files: child } };
});

import { channelMessageSchema, prepareChannelTurn } from '../channel-messages.js';

const b64 = (text: string) => Buffer.from(text).toString('base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');
const turn = (message: Parameters<typeof prepareChannelTurn>[0]['message'], extra = {}) =>
  prepareChannelTurn({
    message,
    owner: { oxyUserId: 'owner-1', taskId: 'task-1' },
    payerAccountId: 'gemie-1',
    ...extra,
  });

beforeEach(() => {
  stored.calls.length = 0;
  stored.fail = false;
  heard.calls.length = 0;
  heard.fail = false;
});

describe('a channel message, as the turn carries it', () => {
  it('keeps a sticker as the person’s file, under their task, and shows the gemie its image, emoji and set', async () => {
    const result = await turn({
      text: '',
      media: [
        {
          kind: 'sticker',
          emoji: '😂',
          setName: 'HappyCats',
          file: { mime: 'image/webp', data: b64('webp') },
        },
      ],
    });
    expect(result.content).toEqual([
      { type: 'text', text: '[Sticker 😂 from the set "HappyCats"]' },
      { type: 'file', file: { file_id: 'file-1', filename: 'sticker.webp', mime: 'image/webp' } },
    ]);
    expect(stored.calls).toEqual([
      { oxyUserId: 'owner-1', taskId: 'task-1', mime: 'image/webp', name: 'sticker.webp' },
    ]);
    expect(result.modelParts).toEqual([
      { type: 'text', text: '[Sticker 😂 from the set "HappyCats"]' },
      { type: 'image', image: expect.any(Uint8Array), mediaType: 'image/webp' },
    ]);
  });

  it('transcribes a voice note on the payer’s account, the transcript carried with its file', async () => {
    const result = await turn({
      text: '',
      media: [{ kind: 'voice', durationSeconds: 4, file: { mime: 'audio/ogg', data: b64('ogg') } }],
    });
    expect(heard.calls).toEqual(['gemie-1']);
    expect(result.content).toEqual([
      { type: 'text', text: '[Voice note, 0:04]' },
      {
        type: 'file',
        file: {
          file_id: 'file-1',
          filename: 'voice.ogg',
          mime: 'audio/ogg',
          transcript: 'hola, ¿quedamos mañana?',
        },
      },
    ]);
    expect(result.modelParts).toEqual([
      { type: 'text', text: '[Voice note, 0:04]' },
      { type: 'text', text: '[The voice note says: hola, ¿quedamos mañana?]' },
    ]);
  });

  it('says a voice note it could not transcribe, and keeps it', async () => {
    heard.fail = true;
    const result = await turn({
      text: '',
      media: [{ kind: 'voice', durationSeconds: 4, file: { mime: 'audio/ogg', data: b64('ogg') } }],
    });
    expect(result.content[0]).toEqual({
      type: 'text',
      text: '[Voice note, 0:04; it could not be transcribed]',
    });
    expect(result.content[1]).toMatchObject({ type: 'file', file: { file_id: 'file-1' } });
  });

  it('shows a video by its first frame, with its caption', async () => {
    const result = await turn({
      text: 'mira',
      media: [{ kind: 'video', durationSeconds: 75, still: { mime: 'image/jpeg', data: JPEG } }],
    });
    expect(result.content).toEqual([
      { type: 'text', text: '[Video, 1:15; only its first frame is shown]\nmira' },
      {
        type: 'file',
        file: { file_id: 'file-1', filename: 'video-still.jpeg', mime: 'image/jpeg' },
      },
    ]);
  });

  it('reads a text document as an attachment is read, and names one it cannot read', async () => {
    const result = await turn({
      text: '',
      media: [
        {
          kind: 'document',
          filename: 'notes.txt',
          file: { mime: 'text/plain', data: b64('Rent is 900') },
        },
        {
          kind: 'document',
          filename: 'game.zip',
          file: { mime: 'application/zip', data: b64('PK') },
        },
      ],
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: '[File: notes.txt]\n[File: game.zip; its type (application/zip) cannot be read here]',
      },
      { type: 'file', file: { file_id: 'file-1', filename: 'notes.txt', mime: 'text/plain' } },
    ]);
    expect(result.modelParts[1]).toEqual({
      type: 'text',
      text: '[Attached document: notes.txt]\n\nRent is 900',
    });
  });

  it('says a location, a contact, a poll, a die, a reply, a forward and what it cannot read', async () => {
    const result = await turn(
      {
        text: '¿vamos?',
        location: { latitude: 40.4, longitude: -3.7, title: 'Café', address: 'Calle 1' },
        contact: { name: 'Luis', phone: '+34600' },
        poll: { question: 'Lunch?', options: ['Yes', 'No'] },
        dice: { emoji: '🎲', value: 5 },
        replyTo: { sender: 'you', text: 'Lunch?' },
        forwardedFrom: 'Marta',
        unsupported: 'A game',
      },
      { speaker: 'Ana (@ana)' },
    );
    expect(result.content).toEqual([
      {
        type: 'text',
        text: [
          'Ana (@ana): [Forwarded from Marta]',
          '[Replying to you: "Lunch?"]',
          '[Location: Café, Calle 1 (40.4, -3.7) https://maps.google.com/?q=40.4,-3.7]',
          '[Contact: Luis, +34600]',
          '[Poll: "Lunch?" — Yes / No]',
          '[Rolled 🎲: 5]',
          '[A game, which cannot be read here]',
          '¿vamos?',
        ].join('\n'),
      },
    ]);
  });

  it('still shows the gemie a photo Oxy did not keep, and says so', async () => {
    stored.fail = true;
    const result = await turn({
      text: '',
      media: [{ kind: 'photo', file: { mime: 'image/jpeg', data: JPEG } }],
    });
    expect(result.content).toEqual([{ type: 'text', text: '[Photo; it could not be kept]' }]);
    expect(result.modelParts[1]).toMatchObject({ type: 'image', mediaType: 'image/jpeg' });
  });

  it('says what the platform could not hand over', async () => {
    const result = await turn({
      text: '',
      media: [{ kind: 'document', filename: 'film.mkv', missing: 'too large to fetch' }],
    });
    expect(result.content).toEqual([
      { type: 'text', text: '[File: film.mkv (too large to fetch)]' },
    ]);
  });

  it('keeps nothing without the person’s task (a third party), yet shows and transcribes it', async () => {
    const result = await turn(
      {
        text: '',
        media: [
          { kind: 'photo', file: { mime: 'image/jpeg', data: JPEG } },
          { kind: 'voice', durationSeconds: 4, file: { mime: 'audio/ogg', data: b64('ogg') } },
        ],
      },
      { owner: null },
    );
    expect(stored.calls).toEqual([]);
    expect(heard.calls).toEqual(['gemie-1']);
    expect(result.content).toEqual([
      { type: 'text', text: '[Photo]\n[Voice note, 0:04] It says: hola, ¿quedamos mañana?' },
    ]);
    expect(result.modelParts).toEqual([
      { type: 'text', text: '[Photo]\n[Voice note, 0:04] It says: hola, ¿quedamos mañana?' },
      { type: 'image', image: expect.any(Uint8Array), mediaType: 'image/jpeg' },
    ]);
  });

  it('keeps and transcribes nothing for an edit', async () => {
    const result = await turn(
      {
        text: 'edited',
        media: [{ kind: 'photo', file: { mime: 'image/jpeg', data: JPEG } }],
      },
      { keep: false },
    );
    expect(result.content).toEqual([{ type: 'text', text: '[Photo]\nedited' }]);
    expect(stored.calls).toEqual([]);
  });

  it('takes only what the integrations process may send', () => {
    expect(channelMessageSchema.safeParse({ text: 'hi', media: [{ kind: 'photo' }] }).success).toBe(
      true,
    );
    expect(channelMessageSchema.safeParse({ text: 'hi', extra: 1 }).success).toBe(false);
    expect(
      channelMessageSchema.safeParse({
        text: '',
        media: [{ kind: 'photo', file: { mime: 'image/jpeg', data: 'x'.repeat(8 * 1024 * 1024) } }],
      }).success,
    ).toBe(false);
  });
});
