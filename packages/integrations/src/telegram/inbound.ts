/**
 * A Telegram message as the shared channel-message model says it (`GemieChannelMessage`,
 * `@gemies/server`): the one reading both bots use, a gemie's own and the Telegram Business one.
 *
 * Its media is downloaded here (a bot may fetch up to 20 MB; each piece and the whole message are
 * capped lower, by what the API takes in one request): a photo at its largest size, a sticker's
 * image (an animated or video sticker's still), a voice note or audio file, a document, and the
 * first frame of a video, a round video or a GIF. What cannot be fetched is said, never dropped.
 */

import {
  CHANNEL_MEDIA_MAX_BYTES,
  CHANNEL_MESSAGE_MAX_BYTES,
  type GemieChannelMedia,
  type GemieChannelMessage,
} from '@gemies/server/internal';
import { createLogger } from '../shared/logger';
import type { BotApi } from './bot-api';
import type {
  TelegramFileRef,
  TelegramMessage,
  TelegramMessageOrigin,
  TelegramUser,
} from './types';

const logger = createLogger('telegram/inbound');

/** The type of an image Telegram did not name, from its first bytes. */
export function sniffImage(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function nameOfUser(user: Pick<TelegramUser, 'first_name' | 'last_name' | 'username'>): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return name || (user.username ? `@${user.username}` : 'someone');
}

function originName(origin: TelegramMessageOrigin): string {
  switch (origin.type) {
    case 'user':
      return nameOfUser(origin.sender_user);
    case 'hidden_user':
      return origin.sender_user_name;
    case 'chat':
      return origin.sender_chat.title ?? 'a group';
    case 'channel':
      return origin.chat.title ?? 'a channel';
  }
}

/** A few words for what a message is, for a reply that quotes one with no text. */
export function telegramMessageLabel(message: TelegramMessage): string {
  const text = message.text ?? message.caption;
  if (text) return text;
  if (message.photo) return 'a photo';
  if (message.sticker) return `a sticker ${message.sticker.emoji ?? ''}`.trim();
  if (message.voice) return 'a voice note';
  if (message.audio) return 'an audio file';
  if (message.video) return 'a video';
  if (message.video_note) return 'a round video';
  if (message.animation) return 'a GIF';
  if (message.document)
    return `a file${message.document.file_name ? ` (${message.document.file_name})` : ''}`;
  if (message.location || message.venue) return 'a location';
  if (message.contact) return 'a contact';
  if (message.poll) return `a poll: ${message.poll.question}`;
  return 'a message';
}

/** What a message that is none of the readable kinds is, or `undefined`. */
function unsupportedKind(message: TelegramMessage): string | undefined {
  if (message.game) return 'A game';
  if (message.story) return 'A story';
  if (message.invoice) return 'An invoice';
  if (message.paid_media) return 'Paid media';
  return undefined;
}

/** Downloads within one message's budget. */
class Fetcher {
  private spent = 0;
  constructor(
    private readonly api: BotApi,
    readonly enabled: boolean,
  ) {}

  /** The bytes, or why there are none. */
  async fetch(ref: TelegramFileRef): Promise<{ bytes: Buffer } | { missing: string } | null> {
    if (!this.enabled) return null;
    const left = Math.min(CHANNEL_MEDIA_MAX_BYTES, CHANNEL_MESSAGE_MAX_BYTES - this.spent);
    if ((ref.file_size ?? 0) > left) return { missing: 'too large to fetch' };
    try {
      const bytes = await this.api.downloadFile(ref.file_id, left);
      if (!bytes) return { missing: 'too large to fetch' };
      this.spent += bytes.length;
      return { bytes };
    } catch (error: unknown) {
      logger.warn('A Telegram file could not be downloaded:', error);
      return { missing: 'it could not be downloaded' };
    }
  }
}

async function fileMedia(
  fetcher: Fetcher,
  ref: TelegramFileRef,
  media: Omit<GemieChannelMedia, 'file' | 'missing'>,
  mime: string | ((bytes: Buffer) => string),
): Promise<GemieChannelMedia> {
  const got = await fetcher.fetch(ref);
  if (!got) return media;
  if ('missing' in got) return { ...media, missing: got.missing };
  const type = typeof mime === 'string' ? mime : mime(got.bytes);
  return { ...media, file: { mime: type, data: got.bytes.toString('base64') } };
}

async function stillMedia(
  fetcher: Fetcher,
  thumbnail: TelegramFileRef | undefined,
  media: Omit<GemieChannelMedia, 'still'>,
): Promise<GemieChannelMedia> {
  if (!thumbnail) return media;
  const got = await fetcher.fetch(thumbnail);
  if (!got || 'missing' in got) return media;
  return { ...media, still: { mime: sniffImage(got.bytes), data: got.bytes.toString('base64') } };
}

async function mediaOf(message: TelegramMessage, fetcher: Fetcher): Promise<GemieChannelMedia[]> {
  const media: GemieChannelMedia[] = [];
  if (message.photo?.length) {
    const largest = message.photo[message.photo.length - 1]!;
    media.push(await fileMedia(fetcher, largest, { kind: 'photo' }, sniffImage));
  }
  const sticker = message.sticker;
  if (sticker) {
    const about = {
      kind: 'sticker' as const,
      ...(sticker.emoji ? { emoji: sticker.emoji } : {}),
      ...(sticker.set_name ? { setName: sticker.set_name } : {}),
    };
    media.push(
      sticker.is_animated || sticker.is_video
        ? await stillMedia(fetcher, sticker.thumbnail, about)
        : await fileMedia(fetcher, sticker, about, 'image/webp'),
    );
  }
  for (const kind of ['voice', 'audio'] as const) {
    const file = message[kind];
    if (!file) continue;
    media.push(
      await fileMedia(
        fetcher,
        file,
        {
          kind,
          ...(file.duration !== undefined ? { durationSeconds: file.duration } : {}),
          ...(file.file_name || file.title ? { filename: file.file_name ?? file.title } : {}),
        },
        file.mime_type ?? (kind === 'voice' ? 'audio/ogg' : 'audio/mpeg'),
      ),
    );
  }
  for (const kind of ['video', 'video_note', 'animation'] as const) {
    const file = message[kind];
    if (!file) continue;
    media.push(
      await stillMedia(fetcher, file.thumbnail, {
        kind,
        ...(file.duration !== undefined ? { durationSeconds: file.duration } : {}),
      }),
    );
  }
  // A GIF arrives as both `animation` and `document`: it is one GIF.
  if (message.document && !message.animation) {
    const file = message.document;
    media.push(
      await fileMedia(
        fetcher,
        file,
        { kind: 'document', ...(file.file_name ? { filename: file.file_name } : {}) },
        file.mime_type ?? 'application/octet-stream',
      ),
    );
  }
  return media;
}

/**
 * Read a message. `text` replaces its own text or caption (a gemie's bot strips its @handle);
 * `download: false` (an edit) reads everything but the media's bytes; `selfId` is who "you" is in
 * a reply (the gemie's bot, or the Business account's owner).
 */
export async function readTelegramMessage(
  api: BotApi,
  message: TelegramMessage,
  options: { text?: string; download?: boolean; selfId?: string } = {},
): Promise<GemieChannelMessage> {
  const fetcher = new Fetcher(api, options.download !== false);
  const media = await mediaOf(message, fetcher);
  const reply = message.reply_to_message;
  const place = message.venue
    ? {
        latitude: message.venue.location.latitude,
        longitude: message.venue.location.longitude,
        title: message.venue.title,
        address: message.venue.address,
      }
    : message.location
      ? { latitude: message.location.latitude, longitude: message.location.longitude }
      : undefined;
  const unsupported = unsupportedKind(message);
  return {
    text: options.text ?? message.text ?? message.caption ?? '',
    ...(media.length ? { media } : {}),
    ...(place ? { location: place } : {}),
    ...(message.contact
      ? {
          contact: {
            name: [message.contact.first_name, message.contact.last_name].filter(Boolean).join(' '),
            phone: message.contact.phone_number,
          },
        }
      : {}),
    ...(message.poll
      ? {
          poll: {
            question: message.poll.question,
            options: message.poll.options.map((option) => option.text),
          },
        }
      : {}),
    ...(message.dice ? { dice: { emoji: message.dice.emoji, value: message.dice.value } } : {}),
    ...(reply
      ? {
          replyTo: {
            sender: reply.from
              ? options.selfId && String(reply.from.id) === options.selfId
                ? 'you'
                : nameOfUser(reply.from)
              : null,
            text: message.quote?.text ?? telegramMessageLabel(reply),
          },
        }
      : {}),
    ...(message.forward_origin ? { forwardedFrom: originName(message.forward_origin) } : {}),
    ...(unsupported ? { unsupported } : {}),
  };
}
