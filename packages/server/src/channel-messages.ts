/**
 * A message that arrived on a messaging channel, whatever it carries: the one shape Telegram (a
 * gemie's own bot, Telegram Business) and WhatsApp hand to the Gemies API, so a sticker, a photo, a
 * voice note or a location reaches the gemie the same way from every platform.
 *
 * The integrations process builds it (it speaks the platforms and downloads their media); the API
 * turns it into the turn's message (`lib/channel-messages.ts` there): media stored in the
 * conversation owner's Oxy Files like an app attachment, voice transcribed, everything else said in
 * words. Nothing is dropped: what cannot be read is named in `unsupported`, so the gemie can say so.
 */

/**
 * The most media bytes one message carries to the API (base64 in a JSON body the API takes up to
 * 10 MB): a piece over the per-file cap, or past the total, arrives as `missing` and is said so.
 */
export const CHANNEL_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const CHANNEL_MESSAGE_MAX_BYTES = 7 * 1024 * 1024;

/** What a piece of media was on its platform. */
export type GemieChannelMediaKind =
  | 'photo'
  | 'sticker'
  | 'voice'
  | 'audio'
  | 'video'
  | 'video_note'
  | 'animation'
  | 'document';

/** Bytes, base64, with their media type. */
export interface GemieChannelBytes {
  readonly mime: string;
  readonly data: string;
}

export interface GemieChannelMedia {
  readonly kind: GemieChannelMediaKind;
  /** The media itself, when it could be fetched (platforms cap what a bot may download). */
  readonly file?: GemieChannelBytes;
  /** The file's own name, known even when its bytes are not. */
  readonly filename?: string;
  /** A still of it: a video's or an animation's thumbnail, an animated sticker's. */
  readonly still?: GemieChannelBytes;
  readonly durationSeconds?: number;
  /** A sticker's emoji and the name of its set. */
  readonly emoji?: string;
  readonly setName?: string;
  /** Why the media itself is missing ("too large", "could not be downloaded"), when it is. */
  readonly missing?: string;
}

export interface GemieChannelMessage {
  /** The text, or the media's caption; empty when there is none. */
  readonly text: string;
  readonly media?: readonly GemieChannelMedia[];
  readonly location?: {
    readonly latitude: number;
    readonly longitude: number;
    /** A venue's name and address. */
    readonly title?: string;
    readonly address?: string;
  };
  readonly contact?: { readonly name: string; readonly phone?: string };
  readonly poll?: { readonly question: string; readonly options: readonly string[] };
  readonly dice?: { readonly emoji: string; readonly value: number };
  /** The message it answers, quoted. */
  readonly replyTo?: { readonly sender: string | null; readonly text: string };
  /** Who it was forwarded from, as the platform names them. */
  readonly forwardedFrom?: string;
  /** A kind of message the integrations process cannot read ("a game", "a story"). */
  readonly unsupported?: string;
}

/** Whether a message carries anything at all (an empty one is not answered). */
export function channelMessageIsEmpty(message: GemieChannelMessage): boolean {
  return (
    message.text.trim() === '' &&
    !message.media?.length &&
    !message.location &&
    !message.contact &&
    !message.poll &&
    !message.dice &&
    !message.unsupported
  );
}

/**
 * A part of a turn's user message, as `/alia/chat` takes it and the conversation keeps it. A
 * `file` part names an Oxy Files file; `transcript` is what an audio file says, read instead of
 * the audio by a model that does not hear.
 */
export type GemieTurnContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'file';
      readonly file: {
        readonly file_id: string;
        readonly filename?: string;
        readonly mime?: string;
        readonly transcript?: string;
      };
    };

/**
 * A stored message's content as text, for a turn's history: its text parts, and a line for each
 * file (with its transcript). Media is read once, on the turn it arrived; later turns read what it
 * was in words, so a long chat never resends every photo.
 */
export function turnContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const lines: string[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part?.type === 'text' && typeof part.text === 'string') lines.push(part.text);
    else if (part?.type === 'file' && part.file && typeof part.file === 'object') {
      const file = part.file as Record<string, unknown>;
      const name = typeof file.filename === 'string' ? file.filename : 'a file';
      lines.push(
        typeof file.transcript === 'string' && file.transcript
          ? `[Attached audio: ${name}. It says: ${file.transcript}]`
          : `[Attached: ${name}]`,
      );
    } else if (part?.type === 'image_url') lines.push('[Attached: an image]');
  }
  return lines.join('\n');
}
