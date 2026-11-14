/**
 * A message that arrived on a channel — a gemie's own Telegram bot, a Telegram Business account, a
 * WhatsApp account — turned into the turn's user message, the same way for every platform
 * (`GemieChannelMessage`, `@gemies/server`).
 *
 * - Its media is kept as the person's private Oxy file (`storeChannelMedia`), and the conversation
 *   keeps a `file` part for it, like an attachment made in the app: the app shows it, and a later
 *   turn reads what it was in words (`turnContentText`). It is kept only on the person's own turn,
 *   under the task they granted the gemie on that channel: a third party's media is never stored
 *   as theirs, and the gemie still sees it on the turn it arrived.
 * - A voice note or an audio file is transcribed through the same speech path as dictation; its
 *   transcript travels with its `file` part, so no turn hears it twice.
 * - A sticker is its image with its emoji and set; a video, a round video or a GIF is its first
 *   frame; a document is read as an attachment is (`readFileForModel`).
 * - A location, a contact, a poll, a die, a reply and a forward are said in words.
 *
 * Nothing is dropped: what could not be fetched, kept, transcribed or read is said in the message,
 * so the gemie answers knowing it, rather than as if the person had sent nothing.
 */

import type { FilePart, ImagePart, TextPart } from 'ai';
import { z } from 'zod';
import {
  CHANNEL_MEDIA_MAX_BYTES,
  type GemieChannelMedia,
  type GemieChannelMessage,
  type GemieTurnContentPart,
} from '@gemies/server/internal';
import { FilePartError, readableByEveryModel, readFileForModel } from './files/person-files.js';
import { storeChannelMedia } from './files/oxy-files.js';
import { getKaanaClient } from './kaana/transport.js';
import { log } from './logger.js';
import {
  dictationMediaType,
  MAX_DICTATION_MS,
  TranscriptionError,
  transcribeDictation,
} from './voice/transcribe.js';

/** Base64 of at most {@link CHANNEL_MEDIA_MAX_BYTES} bytes. */
const MAX_BASE64 = Math.ceil(CHANNEL_MEDIA_MAX_BYTES / 3) * 4 + 4;

const bytesSchema = z.object({
  mime: z.string().min(1).max(255),
  data: z.string().max(MAX_BASE64),
});

const mediaSchema = z
  .object({
    kind: z.enum([
      'photo',
      'sticker',
      'voice',
      'audio',
      'video',
      'video_note',
      'animation',
      'document',
    ]),
    file: bytesSchema.optional(),
    still: bytesSchema.optional(),
    durationSeconds: z.number().int().min(0).max(86_400).optional(),
    emoji: z.string().max(32).optional(),
    setName: z.string().max(128).optional(),
    filename: z.string().max(255).optional(),
    missing: z.string().max(200).optional(),
  })
  .strict();

/** What a channel message may be, as the integrations process sends it. */
export const channelMessageSchema = z
  .object({
    text: z.string().max(16_384),
    media: z.array(mediaSchema).max(10).optional(),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        title: z.string().max(256).optional(),
        address: z.string().max(512).optional(),
      })
      .strict()
      .optional(),
    contact: z
      .object({ name: z.string().max(256), phone: z.string().max(64).optional() })
      .strict()
      .optional(),
    poll: z
      .object({ question: z.string().max(512), options: z.array(z.string().max(256)).max(20) })
      .strict()
      .optional(),
    dice: z
      .object({ emoji: z.string().max(16), value: z.number().int() })
      .strict()
      .optional(),
    replyTo: z
      .object({ sender: z.string().max(256).nullable(), text: z.string().max(4096) })
      .strict()
      .optional(),
    forwardedFrom: z.string().max(256).optional(),
    unsupported: z.string().max(200).optional(),
  })
  .strict();

/** What the model reads of the message on the turn it arrived. */
export type ChannelModelPart = TextPart | ImagePart | FilePart;

export interface ChannelTurn {
  /** The user message as the conversation keeps it: its words, then a part per kept file. */
  readonly content: GemieTurnContentPart[];
  /** What the model reads now: the words, and each piece of media itself. */
  readonly modelParts: ChannelModelPart[];
}

/** `m:ss`. */
function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function quoted(text: string, max = 600): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The line that says what a piece of media is. */
export function mediaLine(media: GemieChannelMedia): string {
  const length = duration(media.durationSeconds);
  const name = media.filename;
  const label = (() => {
    switch (media.kind) {
      case 'photo':
        return 'Photo';
      case 'sticker':
        return `Sticker${media.emoji ? ` ${media.emoji}` : ''}${media.setName ? ` from the set "${media.setName}"` : ''}`;
      case 'voice':
        return `Voice note${length ? `, ${length}` : ''}`;
      case 'audio':
        return `Audio${name ? `: ${name}` : ''}${length ? `, ${length}` : ''}`;
      case 'video':
        return `Video${length ? `, ${length}` : ''}`;
      case 'video_note':
        return `Round video${length ? `, ${length}` : ''}`;
      case 'animation':
        return 'GIF';
      case 'document':
        return `File${name ? `: ${name}` : ''}`;
    }
  })();
  const still =
    media.kind === 'video' || media.kind === 'video_note' || media.kind === 'animation'
      ? media.still
        ? '; only its first frame is shown'
        : ''
      : media.kind === 'sticker' && !media.file && media.still
        ? '; an animated sticker, shown still'
        : '';
  return `[${label}${still}${media.missing ? ` (${media.missing})` : ''}]`;
}

/** The lines that say what the message is, around its media. */
function describe(message: GemieChannelMessage): { before: string[]; after: string[] } {
  const before: string[] = [];
  if (message.forwardedFrom) before.push(`[Forwarded from ${message.forwardedFrom}]`);
  if (message.replyTo) {
    before.push(
      `[Replying to ${message.replyTo.sender ?? 'a message'}: "${quoted(message.replyTo.text)}"]`,
    );
  }
  const after: string[] = [];
  if (message.location) {
    const { latitude, longitude, title, address } = message.location;
    const place = [title, address].filter(Boolean).join(', ');
    after.push(
      `[Location${place ? `: ${place}` : ''} (${latitude}, ${longitude}) https://maps.google.com/?q=${latitude},${longitude}]`,
    );
  }
  if (message.contact) {
    after.push(
      `[Contact: ${message.contact.name}${message.contact.phone ? `, ${message.contact.phone}` : ''}]`,
    );
  }
  if (message.poll) {
    after.push(`[Poll: "${message.poll.question}" — ${message.poll.options.join(' / ')}]`);
  }
  if (message.dice) after.push(`[Rolled ${message.dice.emoji}: ${message.dice.value}]`);
  if (message.unsupported) after.push(`[${message.unsupported}, which cannot be read here]`);
  if (message.text.trim()) after.push(message.text.trim());
  return { before, after };
}

/** The bytes the gemie sees of a piece of media: the media itself, or its still. */
function shownBytes(media: GemieChannelMedia): { mime: string; data: Buffer; name: string } | null {
  const source = media.file ?? media.still;
  if (!source) return null;
  const data = Buffer.from(source.data, 'base64');
  if (data.length === 0 || data.length > CHANNEL_MEDIA_MAX_BYTES) return null;
  const extension = source.mime.split('/')[1]?.split(/[;+]/)[0] ?? 'bin';
  const name =
    (media.file ? media.filename : undefined) ??
    `${media.kind}${media.file ? '' : '-still'}.${extension}`;
  return { mime: source.mime.split(';')[0]!.trim().toLowerCase(), data, name };
}

async function transcribe(
  accountId: string,
  bytes: Buffer,
  mime: string,
  seconds: number | undefined,
): Promise<{ text: string } | { failed: string }> {
  const mediaType = dictationMediaType(mime);
  if (!mediaType) return { failed: 'it is in a format that cannot be transcribed' };
  if (seconds !== undefined && seconds * 1000 > MAX_DICTATION_MS) {
    return { failed: 'it is too long to transcribe' };
  }
  const kaana = getKaanaClient(accountId);
  try {
    const result = await transcribeDictation(kaana, accountId, {
      audio: new Uint8Array(bytes),
      mediaType,
      durationMs: (seconds ?? 0) * 1000,
    });
    return result.text ? { text: result.text } : { failed: 'no words could be heard in it' };
  } catch (error: unknown) {
    log.channels.warn(
      { err: error instanceof TranscriptionError ? error.code : error },
      'A channel voice note could not be transcribed',
    );
    return {
      failed:
        error instanceof TranscriptionError && error.code === 'CLIP_TOO_LONG'
          ? 'it is too long to transcribe'
          : 'it could not be transcribed',
    };
  } finally {
    kaana?.dispose?.();
  }
}

/**
 * Whose Oxy Files keep a channel message's media, and the task that lets Gemies write there: the
 * durable authority the person granted the gemie on that channel, whose effective account is
 * theirs. A channel message carries no session, so this task is the only requester proof there is.
 */
export interface ChannelMediaOwner {
  readonly oxyUserId: string;
  readonly taskId: string;
}

/**
 * The turn's user message for a channel message: its media kept in `owner`'s Oxy Files and
 * transcribed for `payerAccountId`, the account whose turn it is. `owner: null` keeps nothing — a
 * third party's turn, or an account whose authority lapsed — and the media is still shown and
 * transcribed. `speaker` names who wrote it in a group. `keep: false` (an edit) keeps nothing and
 * transcribes nothing: only its words are new.
 */
export async function prepareChannelTurn(input: {
  message: GemieChannelMessage;
  owner: ChannelMediaOwner | null;
  payerAccountId: string;
  speaker?: string;
  modelAcceptsFiles?: boolean;
  keep?: boolean;
}): Promise<ChannelTurn> {
  const { message } = input;
  const keep = input.keep !== false;
  const { before, after } = describe(message);
  const lines = [...before];
  const files: GemieTurnContentPart[] = [];
  const shown: ChannelModelPart[] = [];

  for (const media of message.media ?? []) {
    let line = mediaLine(media);
    const bytes = keep ? shownBytes(media) : null;
    if (!bytes) {
      lines.push(line);
      continue;
    }
    const audio = media.kind === 'voice' || media.kind === 'audio';
    const heard = audio
      ? await transcribe(input.payerAccountId, bytes.data, bytes.mime, media.durationSeconds)
      : null;
    const readable = audio || readableByEveryModel(bytes.mime) || input.modelAcceptsFiles === true;
    let fileId: string | null = null;
    if (!readable) {
      line = line.replace(/]$/, `; its type (${bytes.mime}) cannot be read here]`);
    } else if (input.owner) {
      try {
        fileId = await storeChannelMedia({
          oxyUserId: input.owner.oxyUserId,
          taskId: input.owner.taskId,
          bytes: bytes.data,
          mime: bytes.mime,
          name: bytes.name,
        });
      } catch (error: unknown) {
        log.channels.warn({ err: error }, 'Media that arrived on a channel could not be kept');
        line = line.replace(/]$/, '; it could not be kept]');
      }
    }

    if (heard && 'failed' in heard) line = line.replace(/]$/, `; ${heard.failed}]`);
    const transcript = heard && 'text' in heard ? heard.text : undefined;
    // Kept: the transcript travels with its file. Not kept: the words say it.
    if (transcript && fileId === null) line = `${line} It says: ${transcript}`;
    lines.push(line);
    if (fileId !== null) {
      files.push({
        type: 'file',
        file: {
          file_id: fileId,
          filename: bytes.name,
          mime: bytes.mime,
          ...(transcript ? { transcript } : {}),
        },
      });
    }

    if (audio) {
      if (transcript && fileId !== null) {
        const what = media.kind === 'voice' ? 'voice note' : 'audio';
        shown.push({ type: 'text', text: `[The ${what} says: ${transcript}]` });
      }
    } else if (readable) {
      try {
        shown.push(
          ...(await readFileForModel(
            new Uint8Array(bytes.data),
            { mime: bytes.mime, name: bytes.name, id: fileId ?? bytes.name },
            { modelAcceptsFiles: input.modelAcceptsFiles === true },
          )),
        );
      } catch (error: unknown) {
        if (!(error instanceof FilePartError)) throw error;
        shown.push({ type: 'text', text: `[${error.message}]` });
      }
    }
  }
  lines.push(...after);

  const words = lines.join('\n');
  const text = input.speaker ? `${input.speaker}: ${words}` : words;
  return {
    content: [{ type: 'text', text }, ...files],
    modelParts: [{ type: 'text', text }, ...shown],
  };
}
