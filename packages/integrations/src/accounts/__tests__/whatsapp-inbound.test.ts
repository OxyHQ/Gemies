/**
 * A WhatsApp message read into the same channel-message model as Telegram's: its media through
 * Baileys, everything else in words, and nothing a person can send dropped.
 */

import type { WAMessage } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import {
  readWhatsAppMessage,
  whatsAppContent,
  whatsAppHasContent,
  whatsAppLabel,
} from '../whatsapp/inbound';

const OGG = Buffer.from('OggS voice');
const download = async () => OGG;
const wa = (message: WAMessage['message']): WAMessage => ({
  key: { remoteJid: '34600@s.whatsapp.net', id: 'm1', fromMe: false },
  message,
});

describe('a WhatsApp message, read', () => {
  it('downloads a voice note, a photo, a sticker and a document', async () => {
    expect(
      await readWhatsAppMessage(
        wa({ audioMessage: { ptt: true, seconds: 3, mimetype: 'audio/ogg; codecs=opus' } }),
        download,
      ),
    ).toEqual({
      text: '',
      media: [
        {
          kind: 'voice',
          durationSeconds: 3,
          file: { mime: 'audio/ogg', data: OGG.toString('base64') },
        },
      ],
    });
    const photo = await readWhatsAppMessage(
      wa({ imageMessage: { caption: 'look', mimetype: 'image/jpeg' } }),
      download,
    );
    expect(photo).toMatchObject({ text: 'look', media: [{ kind: 'photo' }] });
    const sticker = await readWhatsAppMessage(
      wa({ stickerMessage: { mimetype: 'image/webp' } }),
      download,
    );
    expect(sticker.media?.[0]).toMatchObject({ kind: 'sticker', file: { mime: 'image/webp' } });
    const document = await readWhatsAppMessage(
      wa({
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              fileName: 'plan.pdf',
              caption: 'the plan',
              mimetype: 'application/pdf',
            },
          },
        },
      }),
      download,
    );
    expect(document).toMatchObject({
      text: 'the plan',
      media: [{ kind: 'document', filename: 'plan.pdf', file: { mime: 'application/pdf' } }],
    });
  });

  it('shows a video or a GIF by its thumbnail, without downloading it', async () => {
    let fetched = false;
    const video = await readWhatsAppMessage(
      wa({
        videoMessage: {
          seconds: 9,
          gifPlayback: true,
          jpegThumbnail: new Uint8Array([0xff, 0xd8]),
        },
      }),
      async () => {
        fetched = true;
        return OGG;
      },
    );
    expect(video.media).toEqual([
      { kind: 'animation', durationSeconds: 9, still: { mime: 'image/jpeg', data: '/9g=' } },
    ]);
    expect(fetched).toBe(false);
  });

  it('says a location, a contact, a poll, a reply and a forward', async () => {
    expect(
      await readWhatsAppMessage(
        wa({
          locationMessage: { degreesLatitude: 40.4, degreesLongitude: -3.7, name: 'Sol' },
        }),
        download,
      ),
    ).toEqual({ text: '', location: { latitude: 40.4, longitude: -3.7, title: 'Sol' } });
    expect(
      (
        await readWhatsAppMessage(
          wa({
            contactMessage: {
              displayName: 'Luis',
              vcard: 'BEGIN:VCARD\nTEL;type=CELL:+34 600 111\nEND:VCARD',
            },
          }),
          download,
        )
      ).contact,
    ).toEqual({ name: 'Luis', phone: '+34 600 111' });
    expect(
      (
        await readWhatsAppMessage(
          wa({ pollCreationMessageV3: { name: 'Lunch?', options: [{ optionName: 'Yes' }] } }),
          download,
        )
      ).poll,
    ).toEqual({ question: 'Lunch?', options: ['Yes'] });
    expect(
      await readWhatsAppMessage(
        wa({
          extendedTextMessage: {
            text: 'yes',
            contextInfo: { quotedMessage: { conversation: 'Lunch?' }, isForwarded: true },
          },
        }),
        download,
      ),
    ).toEqual({
      text: 'yes',
      replyTo: { sender: null, text: 'Lunch?' },
      forwardedFrom: 'someone else',
    });
  });

  it('names what could not be downloaded, and what it cannot read', async () => {
    expect(
      await readWhatsAppMessage(wa({ imageMessage: { mimetype: 'image/jpeg' } }), () =>
        Promise.reject(new Error('expired')),
      ),
    ).toEqual({ text: '', media: [{ kind: 'photo', missing: 'it could not be downloaded' }] });
    expect(await readWhatsAppMessage(wa({ eventMessage: { name: 'Party' } }), download)).toEqual({
      text: '',
      unsupported: 'An event',
    });
  });

  it('tells a person’s message from a receipt or a reaction, and labels one with no text', () => {
    expect(whatsAppHasContent(whatsAppContent(wa({ reactionMessage: { text: '👍' } })))).toBe(
      false,
    );
    expect(whatsAppHasContent(whatsAppContent(wa({ protocolMessage: {} })))).toBe(false);
    const voice = whatsAppContent(
      wa({ ephemeralMessage: { message: { audioMessage: { ptt: true } } } }),
    );
    expect(whatsAppHasContent(voice)).toBe(true);
    expect(whatsAppLabel(voice)).toBe('a voice note');
  });
});
