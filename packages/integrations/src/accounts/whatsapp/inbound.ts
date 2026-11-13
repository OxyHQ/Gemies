/**
 * A WhatsApp message as the shared channel-message model says it (`GemieChannelMessage`,
 * `@gemies/server`), the same reading Telegram's has (`telegram/inbound.ts`): text and captions, a
 * photo, a sticker, a voice note or audio, a document, a video's or GIF's thumbnail, a location, a
 * contact, a poll, a reply's quote and a forward. Media is downloaded through Baileys within the
 * same caps; what cannot be fetched is said, never dropped.
 */

import {
  CHANNEL_MEDIA_MAX_BYTES,
  CHANNEL_MESSAGE_MAX_BYTES,
  type GemieChannelMedia,
  type GemieChannelMessage,
} from '@gemies/server/internal';
import { normalizeMessageContent, type proto, type WAMessage } from '@whiskeysockets/baileys';
import { createLogger } from '../../shared/logger';

const logger = createLogger('whatsapp/inbound');

type Content = proto.IMessage;

/** Media WhatsApp carries in a message, and the content key Baileys downloads it from. */
const MEDIA_KEYS = [
  'imageMessage',
  'stickerMessage',
  'audioMessage',
  'videoMessage',
  'ptvMessage',
  'documentMessage',
] as const;

/** The message itself, out of its ephemeral, view-once or captioned-document wrappers. */
export function whatsAppContent(message: WAMessage): Content | undefined {
  const content = normalizeMessageContent(message.message);
  return content?.documentWithCaptionMessage?.message ?? content ?? undefined;
}

/** Its words: the text, or the caption of its media. */
export function whatsAppText(content: Content | undefined): string {
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.documentMessage?.caption ||
    ''
  );
}

/** A few words for what a message is, for one with no text (stored, or quoted by a reply). */
export function whatsAppLabel(content: Content | undefined): string {
  const text = whatsAppText(content);
  if (text) return text;
  if (content?.imageMessage) return 'a photo';
  if (content?.stickerMessage) return 'a sticker';
  if (content?.audioMessage) return content.audioMessage.ptt ? 'a voice note' : 'an audio file';
  if (content?.videoMessage) return content.videoMessage.gifPlayback ? 'a GIF' : 'a video';
  if (content?.ptvMessage) return 'a round video';
  if (content?.documentMessage) {
    const name = content.documentMessage.fileName;
    return `a file${name ? ` (${name})` : ''}`;
  }
  if (content?.locationMessage || content?.liveLocationMessage) return 'a location';
  if (content?.contactMessage || content?.contactsArrayMessage) return 'a contact';
  const poll = pollOf(content);
  if (poll) return `a poll: ${poll.name ?? ''}`.trim();
  return 'a message';
}

function pollOf(content: Content | undefined): proto.Message.IPollCreationMessage | undefined {
  return (
    content?.pollCreationMessage ??
    content?.pollCreationMessageV2 ??
    content?.pollCreationMessageV3 ??
    undefined
  );
}

/** Whether a message carries anything a person wrote or sent (not a receipt or a reaction). */
export function whatsAppHasContent(content: Content | undefined): boolean {
  return whatsAppLabel(content) !== 'a message' || unsupportedKind(content) !== undefined;
}

/** The reply, mention and forward context of whatever the message carries. */
export function contextOf(content: Content | undefined): proto.IContextInfo | undefined {
  if (!content) return undefined;
  for (const value of Object.values(content)) {
    if (value && typeof value === 'object' && 'contextInfo' in value && value.contextInfo) {
      return value.contextInfo as proto.IContextInfo;
    }
  }
  return undefined;
}

function phoneOf(vcard: string | null | undefined): string | undefined {
  return vcard ? /TEL[^:]*:([+\d][\d\s()+-]*)/i.exec(vcard)?.[1]?.trim() : undefined;
}

/** What a message that is none of the readable kinds is, or `undefined`. */
function unsupportedKind(content: Content | undefined): string | undefined {
  if (content?.eventMessage) return 'An event';
  if (content?.productMessage) return 'A product';
  if (content?.orderMessage) return 'An order';
  return undefined;
}

function size(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return 0;
}

/**
 * Read a message. `download` fetches its media (Baileys' `downloadMediaMessage`, decrypted);
 * a piece over the caps arrives as `missing`.
 */
export async function readWhatsAppMessage(
  message: WAMessage,
  download: (message: WAMessage) => Promise<Buffer>,
): Promise<GemieChannelMessage> {
  const content = whatsAppContent(message);
  const media: GemieChannelMedia[] = [];
  let spent = 0;

  for (const key of MEDIA_KEYS) {
    const item = content?.[key];
    if (!item) continue;
    // The bare type: WhatsApp adds codecs (`audio/ogg; codecs=opus`).
    const mime = (item.mimetype ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
    const seconds = 'seconds' in item && item.seconds ? item.seconds : undefined;
    const about: GemieChannelMedia =
      key === 'imageMessage'
        ? { kind: 'photo' }
        : key === 'stickerMessage'
          ? { kind: 'sticker' }
          : key === 'audioMessage'
            ? {
                kind: content.audioMessage?.ptt ? 'voice' : 'audio',
                ...(seconds ? { durationSeconds: seconds } : {}),
              }
            : key === 'documentMessage'
              ? {
                  kind: 'document',
                  ...(content.documentMessage?.fileName
                    ? { filename: content.documentMessage.fileName }
                    : {}),
                }
              : {
                  kind:
                    key === 'ptvMessage'
                      ? 'video_note'
                      : content.videoMessage?.gifPlayback
                        ? 'animation'
                        : 'video',
                  ...(seconds ? { durationSeconds: seconds } : {}),
                };

    // A video is its thumbnail, which WhatsApp sends inline; an animated sticker is shown still.
    if (key === 'videoMessage' || key === 'ptvMessage') {
      const thumbnail = (key === 'videoMessage' ? content.videoMessage : content.ptvMessage)
        ?.jpegThumbnail;
      media.push(
        thumbnail?.length
          ? {
              ...about,
              still: { mime: 'image/jpeg', data: Buffer.from(thumbnail).toString('base64') },
            }
          : about,
      );
      continue;
    }
    const left = Math.min(CHANNEL_MEDIA_MAX_BYTES, CHANNEL_MESSAGE_MAX_BYTES - spent);
    if (size(item.fileLength) > left) {
      media.push({ ...about, missing: 'too large to fetch' });
      continue;
    }
    try {
      const bytes = await download(message);
      if (bytes.length > left) {
        media.push({ ...about, missing: 'too large to fetch' });
        continue;
      }
      spent += bytes.length;
      media.push({ ...about, file: { mime, data: bytes.toString('base64') } });
    } catch (error: unknown) {
      logger.warn('A WhatsApp file could not be downloaded:', error);
      media.push({ ...about, missing: 'it could not be downloaded' });
    }
  }

  const location = content?.locationMessage ?? content?.liveLocationMessage;
  const place =
    location &&
    typeof location.degreesLatitude === 'number' &&
    typeof location.degreesLongitude === 'number'
      ? {
          latitude: location.degreesLatitude,
          longitude: location.degreesLongitude,
          ...('name' in location && location.name ? { title: location.name } : {}),
          ...('address' in location && location.address ? { address: location.address } : {}),
        }
      : undefined;
  const contactCard = content?.contactMessage ?? content?.contactsArrayMessage?.contacts?.[0];
  const poll = pollOf(content);
  const context = contextOf(content);
  const quoted = context?.quotedMessage
    ? normalizeMessageContent(context.quotedMessage)
    : undefined;
  const unsupported = unsupportedKind(content);

  return {
    text: whatsAppText(content),
    ...(media.length ? { media } : {}),
    ...(place ? { location: place } : {}),
    ...(contactCard
      ? {
          contact: {
            name: contactCard.displayName ?? 'a contact',
            ...(phoneOf(contactCard.vcard) ? { phone: phoneOf(contactCard.vcard) } : {}),
          },
        }
      : {}),
    ...(poll
      ? {
          poll: {
            question: poll.name ?? '',
            options: (poll.options ?? []).map((option) => option.optionName ?? ''),
          },
        }
      : {}),
    ...(quoted ? { replyTo: { sender: null, text: whatsAppLabel(quoted) } } : {}),
    ...(context?.isForwarded ? { forwardedFrom: 'someone else' } : {}),
    ...(unsupported ? { unsupported } : {}),
  };
}
