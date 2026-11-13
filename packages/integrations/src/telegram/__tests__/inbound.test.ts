/**
 * Every kind of Telegram message read into the shared channel-message model: nothing a person can
 * send is dropped, and what cannot be read is named.
 */

import { describe, expect, it } from 'vitest';
import type { BotApi } from '../bot-api';
import { readTelegramMessage, sniffImage } from '../inbound';
import type { TelegramMessage } from '../types';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]);
const downloaded: string[] = [];
const api = {
  downloadFile: async (fileId: string) => {
    downloaded.push(fileId);
    return fileId === 'broken' ? Promise.reject(new Error('gone')) : JPEG;
  },
} as unknown as BotApi;

const base: TelegramMessage = {
  message_id: 1,
  date: 1,
  chat: { id: 7, type: 'private' },
  from: { id: 7, is_bot: false, first_name: 'Ana' },
};
const read = (over: Partial<TelegramMessage>, options = {}) =>
  readTelegramMessage(api, { ...base, ...over }, options);

describe('a Telegram message, read', () => {
  it('shows an animated sticker still, and a video, round video or GIF by its first frame', async () => {
    const thumb = { file_id: 't', file_unique_id: 't', width: 1, height: 1 };
    expect(
      await read({
        sticker: {
          file_id: 'anim',
          file_unique_id: 'a',
          type: 'regular',
          is_animated: true,
          is_video: false,
          emoji: '🔥',
          thumbnail: thumb,
        },
      }),
    ).toEqual({
      text: '',
      media: [
        {
          kind: 'sticker',
          emoji: '🔥',
          still: { mime: 'image/jpeg', data: JPEG.toString('base64') },
        },
      ],
    });
    for (const kind of ['video', 'video_note', 'animation'] as const) {
      const message = await read({
        caption: 'watch',
        [kind]: { file_id: 'v', file_unique_id: 'v', duration: 12, thumbnail: thumb },
        // A GIF also arrives as a document: it is one GIF.
        ...(kind === 'animation' ? { document: { file_id: 'v', file_unique_id: 'v' } } : {}),
      });
      expect(message.text).toBe('watch');
      expect(message.media).toEqual([
        { kind, durationSeconds: 12, still: { mime: 'image/jpeg', data: JPEG.toString('base64') } },
      ]);
    }
  });

  it('says a location, a venue, a contact, a poll and a die', async () => {
    expect((await read({ location: { latitude: 40.4, longitude: -3.7 } })).location).toEqual({
      latitude: 40.4,
      longitude: -3.7,
    });
    expect(
      (
        await read({
          venue: { location: { latitude: 1, longitude: 2 }, title: 'Café', address: 'Calle 1' },
          location: { latitude: 1, longitude: 2 },
        })
      ).location,
    ).toEqual({ latitude: 1, longitude: 2, title: 'Café', address: 'Calle 1' });
    expect(
      (await read({ contact: { phone_number: '+34600', first_name: 'Luis', last_name: 'P' } }))
        .contact,
    ).toEqual({ name: 'Luis P', phone: '+34600' });
    expect(
      (await read({ poll: { question: 'Lunch?', options: [{ text: 'Yes' }, { text: 'No' }] } }))
        .poll,
    ).toEqual({ question: 'Lunch?', options: ['Yes', 'No'] });
    expect((await read({ dice: { emoji: '🎲', value: 5 } })).dice).toEqual({
      emoji: '🎲',
      value: 5,
    });
  });

  it('quotes the message it replies to, and names who a forward came from', async () => {
    expect(
      await read(
        {
          text: 'yes',
          reply_to_message: {
            ...base,
            from: { id: 99, is_bot: true, first_name: 'Eusebio' },
            text: 'Lunch?',
          },
          forward_origin: { type: 'hidden_user', date: 1, sender_user_name: 'Marta' },
        },
        { selfId: '99' },
      ),
    ).toEqual({
      text: 'yes',
      replyTo: { sender: 'you', text: 'Lunch?' },
      forwardedFrom: 'Marta',
    });
    expect(
      (await read({ text: 'nice', reply_to_message: { ...base, photo: [] } })).replyTo,
    ).toEqual({ sender: 'Ana', text: 'a photo' });
  });

  it('names what it cannot read, and what it could not download', async () => {
    expect(await read({ game: {} })).toEqual({ text: '', unsupported: 'A game' });
    expect(
      await read({ document: { file_id: 'broken', file_unique_id: 'b', file_name: 'a.pdf' } }),
    ).toEqual({
      text: '',
      media: [{ kind: 'document', filename: 'a.pdf', missing: 'it could not be downloaded' }],
    });
  });

  it('fetches nothing for an edit', async () => {
    downloaded.length = 0;
    const message = await read(
      { caption: 'edited', photo: [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }] },
      { download: false },
    );
    expect(message).toEqual({ text: 'edited', media: [{ kind: 'photo' }] });
    expect(downloaded).toEqual([]);
  });

  it('knows an image by its first bytes', () => {
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(sniffImage(Buffer.from('RIFF0000WEBPVP8 '))).toBe('image/webp');
  });
});
