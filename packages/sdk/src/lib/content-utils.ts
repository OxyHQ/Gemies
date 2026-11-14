import { processMessage } from '../runtime/thread/message-processor';

/** A single part of a multi-part chat message content array. */
export interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url?: string };
  [key: string]: unknown;
}

export type MessageContent = string | ContentPart[];

/**
 * Extract text from message content, whether it's a string or multi-part array.
 */
export function getTextFromContent(content: MessageContent | null | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === 'text')
      .map((p) => p.text || '')
      .join('');
  }
  return String(content || '');
}

/**
 * A message's words as the thread draws them: its text parts, without the tags other platforms
 * use (Telegram's), which a reply written for one can still carry.
 */
export function messageText(message: { content: MessageContent | null | undefined }): string {
  return processMessage(message.content ? getTextFromContent(message.content) : '', 'app').text;
}

/**
 * Extract image URLs from multi-part message content.
 */
export function getImagesFromContent(content: MessageContent | null | undefined): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (p): p is ContentPart & { image_url: { url: string } } =>
        p.type === 'image_url' && typeof p.image_url?.url === 'string',
    )
    .map((p) => p.image_url.url);
}

/**
 * One attachment of a turn, as the thread draws it: a photo sent inline (`image_url`), or a file kept
 * in Oxy Files (`file`) — attached in the app, or media that arrived on a channel, which says what it
 * was there (`kind`: a sticker, a voice note…), how long it lasts and, for audio, what it says.
 */
export type TurnAttachment =
  | { readonly type: 'inline-image'; readonly url: string }
  | {
      readonly type: 'file';
      readonly fileId: string;
      readonly filename: string;
      readonly mime: string;
      readonly kind?: string;
      readonly description?: string;
      readonly durationSeconds?: number;
      readonly transcript?: string;
    };

/** A turn's attachments, in order. */
export function getAttachmentsFromContent(
  content: MessageContent | null | undefined,
): TurnAttachment[] {
  if (!Array.isArray(content)) return [];
  const out: TurnAttachment[] = [];
  for (const part of content) {
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
      out.push({ type: 'inline-image', url: part.image_url.url });
      continue;
    }
    const file = part.type === 'file' ? (part.file as Record<string, unknown> | undefined) : null;
    if (!file || typeof file.file_id !== 'string' || file.file_id === '') continue;
    const text = (key: string) =>
      typeof file[key] === 'string' ? (file[key] as string) : undefined;
    out.push({
      type: 'file',
      fileId: file.file_id,
      filename: text('filename') ?? file.file_id,
      mime: (text('mime') ?? 'application/octet-stream').toLowerCase(),
      ...(text('kind') ? { kind: text('kind') } : {}),
      ...(text('description') ? { description: text('description') } : {}),
      ...(typeof file.durationSeconds === 'number'
        ? { durationSeconds: file.durationSeconds }
        : {}),
      ...(text('transcript') ? { transcript: text('transcript') } : {}),
    });
  }
  return out;
}
