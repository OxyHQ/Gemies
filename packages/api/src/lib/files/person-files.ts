import { oxy } from '../oxy.js';
import { readLinkedFile } from './oxy-files.js';
/**
 * The documents a person attaches to a turn, read from Oxy Files with verified
 * requester proof (`{ type: 'file', file: { file_id, filename, mime } }`,
 * `docs/agent-embedding.md` §5).
 *
 * ## Read as the person, never as Alia
 *
 * The client uploads the file to the person's own Oxy account through the SDK
 * and sends only its id. Alia opens it with the person's verified bearer, on a
 * workload client's requester facade, so Oxy answers exactly what that person
 * may read and nothing more: another account's private file is a 404 here as it
 * is everywhere. The workload alone cannot read it, and nothing of it
 * is stored — the conversation keeps the reference the client sent.
 *
 * ## What the model receives
 *
 * - An image file: an image part.
 * - A text file (`text/*`, JSON, XML): its text.
 * - A Word, PowerPoint or Excel file (Office Open XML, `office-documents.ts`):
 *   its text, whatever the model, since no model reads them as files.
 * - A PDF: the file itself when the turn's model takes files
 *   (`inputModalities` includes `file`), otherwise its text, extracted here.
 *   A power level never knows its model in advance, so it gets the text. A PDF
 *   with no text (a scan) gives instead its first pages as images, with a line
 *   saying which pages they are, and the model reads them (`pdf-documents.ts`).
 * - An audio file whose part carries its `transcript` (a voice note that
 *   arrived on a channel, `lib/channel-messages.ts`): its transcript.
 * - Anything else: the file itself when the model takes files; otherwise the
 *   turn is refused (`file_type_unsupported`) rather than answered about a
 *   document the model never saw.
 *
 * What is read is cached for ten minutes per person and file, because the
 * client resends the whole history every turn and a document does not change.
 */

import { OxyApiError, type OxyServices } from '@oxy.so/core';
import type { FilePart, ImagePart, TextPart } from 'ai';
import type { ChatMessage, FilePartRef } from '../message-converter.js';
import { log } from '../logger.js';
import { TTLCache } from '../ttl-cache.js';
import { officeKindOf, officeText, OfficeDocumentError } from './office-documents.js';
import { readPdf, type PdfReading } from './pdf-documents.js';

export type ResolvedFilePart = FilePart | ImagePart | TextPart;

/** Each attached file's model parts, by Oxy Files id: one, or a scan's line and its pages. */
export type ResolvedFiles = ReadonlyMap<string, readonly ResolvedFilePart[]>;

/** At most this many distinct files in one request, history included. */
export const MAX_FILES_PER_REQUEST = 10;
/** The largest file read, in bytes. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** The most text one document contributes to the model's context. */
const MAX_DOCUMENT_CHARS = 100_000;
/** The longest transcript a file part may carry. */
const MAX_TRANSCRIPT_CHARS = 50_000;

export type FilePartErrorCode =
  | 'invalid_file_part'
  | 'too_many_files'
  | 'file_unavailable'
  | 'file_too_large'
  | 'file_type_unsupported'
  | 'file_session_required';

/** Why a turn's files could not be read. The turn is refused before anything is reserved. */
export class FilePartError extends Error {
  constructor(
    readonly code: FilePartErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FilePartError';
  }
}

/** What was read from a document; a scan's pages are bounded by `MAX_SCANNED_PDF_IMAGE_BYTES`. */
const readCache = new TTLCache<PdfReading>({ ttlMs: 10 * 60_000, maxSize: 50 });

const TEXT_MIME = /^(text\/[a-z0-9.+-]+|application\/(json|xml|[a-z0-9.+-]+\+(json|xml)))$/i;

function isFilePartRef(value: unknown): value is FilePartRef {
  if (value === null || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.file_id === 'string' &&
    ref.file_id !== '' &&
    ref.file_id.length <= 128 &&
    (ref.filename === undefined ||
      (typeof ref.filename === 'string' && ref.filename.length <= 255)) &&
    (ref.mime === undefined || (typeof ref.mime === 'string' && ref.mime.length <= 255)) &&
    (ref.transcript === undefined ||
      (typeof ref.transcript === 'string' && ref.transcript.length <= MAX_TRANSCRIPT_CHARS)) &&
    (ref.description === undefined ||
      (typeof ref.description === 'string' && ref.description.length <= 500)) &&
    (ref.kind === undefined || (typeof ref.kind === 'string' && ref.kind.length <= 32)) &&
    (ref.durationSeconds === undefined ||
      (typeof ref.durationSeconds === 'number' && Number.isFinite(ref.durationSeconds)))
  );
}

/**
 * Every `file` part of the request's user messages, by id, or a
 * {@link FilePartError} for a malformed one. Distinct ids, history included —
 * or, for a channel turn (`latestTurnOnly`), the newest user message's alone:
 * a channel resends its whole stored history, and media is read on the turn it
 * arrived (earlier files are said in words, `convertToAISDKMessages`).
 */
export function filePartsOf(
  messages: readonly ChatMessage[],
  options: { latestTurnOnly?: boolean } = {},
): Map<string, FilePartRef> {
  const refs = new Map<string, FilePartRef>();
  const latest = options.latestTurnOnly
    ? [...messages].reverse().find((message) => message.role === 'user')
    : undefined;
  for (const message of options.latestTurnOnly ? (latest ? [latest] : []) : messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type !== 'file') continue;
      if (message.role !== 'user' || !isFilePartRef(part.file)) {
        throw new FilePartError(
          'invalid_file_part',
          'A file part is { "type": "file", "file": { "file_id", "filename"?, "mime"? } }, in a user message.',
        );
      }
      if (!refs.has(part.file.file_id)) refs.set(part.file.file_id, part.file);
    }
  }
  if (refs.size > MAX_FILES_PER_REQUEST) {
    throw new FilePartError(
      'too_many_files',
      `A request may carry at most ${MAX_FILES_PER_REQUEST} files.`,
    );
  }
  return refs;
}

function documentText(name: string, text: string): TextPart {
  const body = text.trim();
  if (body === '') {
    return { type: 'text', text: `[Attached document: ${name}. It has no text.]` };
  }
  const clipped = body.length > MAX_DOCUMENT_CHARS;
  return {
    type: 'text',
    text:
      `[Attached document: ${name}]\n\n${clipped ? body.slice(0, MAX_DOCUMENT_CHARS) : body}` +
      (clipped
        ? `\n\n[The document continues; only its first ${MAX_DOCUMENT_CHARS} characters are included.]`
        : ''),
  };
}

function pageList(pages: readonly number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    ranges.push(j === i ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
    i = j;
  }
  return ranges.join(', ');
}

/** The model parts of what was read: a text, or a scan's line and its page images. */
function documentParts(name: string, reading: PdfReading): ResolvedFilePart[] {
  if (reading.kind === 'text') return [documentText(name, reading.text)];
  const { pageCount, pages } = reading;
  if (pages.length === 0) {
    return [
      {
        type: 'text',
        text: `[Attached document: ${name}. It has no extractable text and no scanned page images could be read from it.]`,
      },
    ];
  }
  const numbers = pages.map((page) => page.page);
  return [
    {
      type: 'text',
      text:
        `[Attached document: ${name}. It is scanned and has no text, so its pages follow as images: ` +
        `${numbers.length === 1 ? 'page' : 'pages'} ${pageList(numbers)} of ${pageCount}. Read the text from them.]`,
    },
    ...pages.map((page): ImagePart => ({ type: 'image', image: page.png, mediaType: 'image/png' })),
  ];
}

function unavailable(fileId: string): FilePartError {
  return new FilePartError('file_unavailable', `The file ${fileId} could not be opened.`);
}

/** Whether every model reads a file of this type: an image, a PDF, an Office document or text. */
export function readableByEveryModel(mime: string): boolean {
  const type = mime.toLowerCase();
  return (
    type.startsWith('image/') ||
    type === 'application/pdf' ||
    officeKindOf(type) !== undefined ||
    TEXT_MIME.test(type)
  );
}

/** Whether a file of this type is read as text rather than handed to the model as a file. */
function readAsText(mime: string, modelAcceptsFiles: boolean): boolean {
  return mime === 'application/pdf'
    ? !modelAcceptsFiles
    : officeKindOf(mime) !== undefined || TEXT_MIME.test(mime);
}

/**
 * What the model receives of a file's bytes: an image part, a document's text (or a scan's pages),
 * or the file itself. The one reading every attachment takes, whether a person attached it in the
 * app or it arrived on a channel. Throws {@link FilePartError} when a document cannot be read.
 */
export async function readFileForModel(
  bytes: Uint8Array,
  file: { mime: string; name: string; id: string },
  options: { modelAcceptsFiles: boolean; cacheKey?: string },
): Promise<ResolvedFilePart[]> {
  const mime = file.mime.toLowerCase();
  if (mime.startsWith('image/')) return [{ type: 'image', image: bytes, mediaType: mime }];
  if (!readAsText(mime, options.modelAcceptsFiles)) {
    return [{ type: 'file', data: bytes, mediaType: mime, filename: file.name }];
  }
  const office = officeKindOf(mime);
  let reading: PdfReading;
  try {
    reading =
      mime === 'application/pdf'
        ? await readPdf(bytes)
        : {
            kind: 'text',
            text: office
              ? officeText(office, bytes, MAX_DOCUMENT_CHARS)
              : new TextDecoder().decode(bytes),
          };
  } catch (error: unknown) {
    log.v1.warn(
      {
        err: error instanceof OfficeDocumentError ? error.message : error,
        fileId: file.id,
      },
      'Could not read the text of a file part',
    );
    throw new FilePartError('file_unavailable', `The document ${file.name} could not be read.`);
  }
  if (options.cacheKey) readCache.set(options.cacheKey, reading);
  return documentParts(file.name, reading);
}

/** Where a turn's files are read from: what a file is, and its bytes. */
interface FileSource {
  record(fileId: string): Promise<{
    readonly status: string;
    readonly mime: string;
    readonly size: number;
    readonly originalName?: string | null;
  }>;
  bytes(fileId: string): Promise<Uint8Array>;
}

/** The person's own files, read as them: their session, or the task they granted. */
function requesterSource(assets: Pick<OxyServices['assets'], 'get' | 'blob'>): FileSource {
  return {
    record: async (fileId) => (await assets.get(fileId)).file,
    bytes: async (fileId) => new Uint8Array(await (await assets.blob(fileId)).arrayBuffer()),
  };
}

/**
 * A channel turn's media, stored by this application for the channel's person
 * (`storeChannelMedia`): read through its own consented link to them
 * (`readLinkedFile`, the Oxy Files seam). Only a file this application stored,
 * or the person attached to it, answers; anything else is absent, so no id a
 * channel sends can reach another file.
 */
function linkedSource(): FileSource {
  const links = new Map<string, ReturnType<typeof readLinkedFile>>();
  const open = async (fileId: string) => {
    let found = links.get(fileId);
    if (!found) {
      found = readLinkedFile(fileId);
      links.set(fileId, found);
    }
    const file = await found;
    if (!file) throw unavailable(fileId);
    return file;
  };
  return {
    record: async (fileId) => {
      const file = await open(fileId);
      return { status: 'active', mime: file.mime, size: file.size };
    },
    bytes: async (fileId) => (await open(fileId)).bytes(),
  };
}

async function resolveOne(
  source: FileSource,
  ref: FilePartRef,
  options: { personAccountId: string; modelAcceptsFiles: boolean },
): Promise<ResolvedFilePart[]> {
  let record: Awaited<ReturnType<FileSource['record']>>;
  try {
    record = await source.record(ref.file_id);
  } catch (error: unknown) {
    if (!(error instanceof OxyApiError) && !(error instanceof FilePartError)) {
      log.v1.warn({ err: error, fileId: ref.file_id }, 'Oxy Files did not answer for a file part');
    }
    throw unavailable(ref.file_id);
  }
  if (record.status !== 'active') throw unavailable(ref.file_id);
  // Oxy's record decides what the file is; the part's own `mime` is only a hint.
  const mime = record.mime.toLowerCase();
  const name = record.originalName ?? ref.filename ?? ref.file_id;
  const what = ref.description ? `[${ref.description}]` : null;
  if (mime.startsWith('audio/') && ref.transcript !== undefined) {
    return [
      {
        type: 'text',
        text: `[${ref.description ?? `Attached audio: ${name}`}. It says: ${ref.transcript}]`,
      },
    ];
  }
  if (record.size > MAX_FILE_BYTES) {
    throw new FilePartError(
      'file_too_large',
      `The file ${ref.file_id} is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MiB.`,
    );
  }
  const asText = readAsText(mime, options.modelAcceptsFiles);
  const cacheKey = `${options.personAccountId}:${ref.file_id}`;
  if (asText) {
    const cached = readCache.get(cacheKey);
    if (cached !== undefined) return withWhat(what, documentParts(name, cached));
  } else if (!mime.startsWith('image/') && !options.modelAcceptsFiles) {
    throw new FilePartError(
      'file_type_unsupported',
      `This model cannot read ${mime} files. Attach a PDF, an Office document or a text file, or pick a model that reads files.`,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await source.bytes(ref.file_id);
  } catch (error: unknown) {
    log.v1.warn({ err: error, fileId: ref.file_id }, 'Could not download a file part');
    throw unavailable(ref.file_id);
  }
  return withWhat(
    what,
    await readFileForModel(
      bytes,
      { mime, name, id: ref.file_id },
      { modelAcceptsFiles: options.modelAcceptsFiles, cacheKey },
    ),
  );
}

/** A channel's media, said in words before the file itself ("[Sticker 😂 from the set …]"). */
function withWhat(what: string | null, parts: ResolvedFilePart[]): ResolvedFilePart[] {
  return what ? [{ type: 'text', text: what }, ...parts] : parts;
}

/**
 * Read every attached file, as the person. Throws a {@link FilePartError} for
 * the first one that cannot be read: a turn about a document Alia could not
 * open is not answered.
 */
export async function resolveFileParts(
  refs: ReadonlyMap<string, FilePartRef>,
  options: {
    personAccountId: string | undefined;
    accessToken: string | undefined;
    taskId?: string;
    modelAcceptsFiles: boolean;
    /**
     * A channel turn (a connected account's, a gemie bot's person's): its files are the media this
     * application kept for the channel's person, read through its own link to them, and one that
     * cannot be read is said in words rather than refusing the turn — the person's message
     * arrived, and is answered.
     */
    channel?: boolean;
  },
): Promise<ResolvedFiles> {
  if (refs.size === 0) return new Map();
  const { personAccountId, accessToken, modelAcceptsFiles } = options;
  if (options.channel) {
    if (personAccountId === undefined) {
      throw new FilePartError('file_session_required', 'This channel turn has no account.');
    }
    const source = linkedSource();
    const resolved = await Promise.all(
      [...refs.values()].map(async (ref) => {
        try {
          return [
            ref.file_id,
            await resolveOne(source, ref, { personAccountId, modelAcceptsFiles }),
          ] as const;
        } catch (error: unknown) {
          log.v1.warn(
            { err: error, fileId: ref.file_id },
            'A channel turn could not read one of its files',
          );
          const what = ref.description ?? `A file, ${ref.filename ?? 'unnamed'}`;
          const said: ResolvedFilePart[] = [
            {
              type: 'text',
              text: ref.transcript
                ? `[${what}. It says: ${ref.transcript}]`
                : `[${what}; it could not be opened]`,
            },
          ];
          return [ref.file_id, said] as const;
        }
      }),
    );
    return new Map(resolved);
  }
  if (personAccountId === undefined || (!accessToken && !options.taskId)) {
    throw new FilePartError(
      'file_session_required',
      'Files are read with your own Oxy session; this request has none.',
    );
  }
  const source = requesterSource(
    oxy.assets.withRequester(
      options.taskId ? { taskId: options.taskId } : { requesterToken: accessToken! },
    ),
  );
  const resolved = await Promise.all(
    [...refs.values()].map(
      async (ref) =>
        [
          ref.file_id,
          await resolveOne(source, ref, { personAccountId, modelAcceptsFiles }),
        ] as const,
    ),
  );
  return new Map(resolved);
}
