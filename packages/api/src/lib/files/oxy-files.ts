/**
 * Where Alia's stored bytes live: Oxy Files (oxy ADR 0043), or — for what Oxy
 * does not take, and for rows the backfill has not reached — Alia's own bucket,
 * behind this one module.
 *
 * ## Who owns what
 *
 * | What                         | Owner                       | Visibility | Reference            |
 * |------------------------------|-----------------------------|------------|----------------------|
 * | A library upload             | the PERSON (their file)     | private    | `library_file`/<id>  |
 * | A spoken clip (cache)        | ALIA (a cache Alia expires) | private    | `speech_clip`/<key>  |
 * | A catalogue skill's file     | ALIA (no person owns it)    | private    | `skill_file`/<id>    |
 * | A person's own skill's file  | the PERSON                  | private    | `skill_file`/<id>    |
 * | Media sent on a channel      | the PERSON (their chat's)   | private    | its message's part   |
 *
 * A spoken clip is Alia's and not the person's on purpose: it is a cache Alia
 * deletes after 30 days unused and with the conversation it was spoken from.
 * An account's file is never deleted behind its owner's back (ADR 0043 D5), so
 * a clip stored as the person's could never be expired — it would pile up as
 * "not in use" in their file manager forever. As Alia's, removing the reference
 * is the expiry: Oxy trashes an unreferenced application file after 24 hours.
 *
 * ## How each kind reaches Oxy (stage 4c)
 *
 * - Private content (`storePrivateContent`), always `visibility: 'private'`:
 *   media (image, video, audio) of at most 40 MiB is streamed
 *   (`uploadAppFile` / `uploadUserMedia`); anything else — a PDF, a document,
 *   a skill bundle's binary, a file over 40 MiB — is a resumable large upload
 *   (`uploadAppFileLarge` / `uploadUserMediaLarge`, up to 8 GiB). A person's
 *   file stored this way is readable by Alia under the consent grant Oxy
 *   writes when Alia stores it for them, until the person revokes it.
 * - A person's file is written WITH THAT PERSON'S OWN REQUESTER PROOF
 *   (`ContentOwner.requester`): their session on a request they made, or the
 *   task they granted for a channel. Oxy stores user media for a first-party
 *   workload only into the account that proof verifies (its
 *   `requireUserMediaOwner`); Alia naming the owner is never enough. Without a
 *   proof nothing is sent to Oxy.
 *
 * Private content always goes to Oxy first. A write Oxy does not take — a
 * refused type, a person's file not stored private, bytes other than the ones
 * sent, Oxy unreachable — is written to the legacy bucket instead, logged and
 * counted (`alia_oxy_files_fallback_writes_total`). Taken-down bytes (451) are
 * the one refusal never routed around. Nothing outside this module knows which
 * backend a byte is in.
 *
 * ## Reads are dual during the move
 *
 * A row may name an Oxy file, a legacy key, or both while it is being copied.
 * The Oxy file is read first; the legacy key only when there is none (or Oxy
 * failed to answer), and every such read is counted (`legacy_storage_reads` and
 * `alia_legacy_storage_reads_total`) — the count that gates retiring the bucket.
 * When Oxy answers that Alia may NOT read a file (the person revoked Alia's
 * access, or the file was taken down), that answer stands: the legacy copy is
 * not read around it.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { OxyServer, RequesterProof } from '@oxy.so/core/server';
import type { LegacyReadKind, LegacyStoredObjectKind } from '../../domain/oxy-files.js';
import { getDb, type ApiDatabase } from '../../db/index.js';
import {
  countLegacyRead,
  markLegacyObjectsMaybeGarbage,
} from '../../db/files/oxyFileRepository.js';
import { log } from '../logger.js';
import {
  legacyStorageReadRecorded,
  privateContentFallbackRecorded,
} from '../observability/metrics.js';
import { oxy as aliaOxy } from '../oxy.js';
import { readS3Object, uploadToS3Deterministic, type S3ObjectStream } from '../s3.js';

/** Raised when Alia has no Oxy service identity, so nothing can be stored in Oxy. */
export class OxyFilesUnavailableError extends Error {
  constructor() {
    super('Alia has no Oxy service identity, so it cannot store or read Oxy files');
    this.name = 'OxyFilesUnavailableError';
  }
}

/**
 * Raised, before anything is sent, for a person's file with no requester proof of theirs: Oxy
 * would refuse it, because a first-party workload stores user media only for the account a
 * verified session or task names.
 */
export class OxyFileRequesterMissingError extends Error {
  constructor() {
    super(
      "A person's file is stored in Oxy only with their own requester proof, and none was given",
    );
    this.name = 'OxyFileRequesterMissingError';
  }
}

/** Raised when Oxy stored bytes other than the ones Alia sent. Never expected; never ignored. */
export class OxyFileIntegrityError extends Error {
  constructor(expected: string, stored: string) {
    super(`Oxy stored sha256 ${stored} for bytes whose sha256 is ${expected}`);
    this.name = 'OxyFileIntegrityError';
  }
}

/** Injectable for tests; production uses Alia's own service identity. */
let clientOverride: (() => OxyServer | null) | null = null;

export function setOxyFilesClientForTests(factory: (() => OxyServer | null) | null): void {
  clientOverride = factory;
}

function oxy(): OxyServer {
  const client = clientOverride ? clientOverride() : aliaOxy;
  if (client === null) throw new OxyFilesUnavailableError();
  return client;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── Private content ─────────────────────────────────────────────────────────

/** The kinds of private content: library uploads, spoken clips, skill files. */
type PrivateContentKind = LegacyStoredObjectKind;

/**
 * Who owns a stored file: Alia itself, or one person — with the proof that the work is that
 * person's (their session, or a task they granted), or `null` when there is none (a backfill, a
 * delegated call), and then Oxy is not asked.
 */
export type ContentOwner =
  | { readonly kind: 'alia' }
  | {
      readonly kind: 'person';
      readonly oxyUserId: string;
      readonly requester: RequesterProof | null;
    };

/** Where one stored file is. A row stores both columns; at least one is set. */
export interface StoredContent {
  readonly objectKey: string | null;
  readonly oxyFileId: string | null;
}

/** How long a legacy upload may take to be recorded before its object counts as garbage. */
const LEGACY_UPLOAD_GRACE_SECONDS = 60 * 60;

/** The largest file Oxy's streamed service uploads take; anything bigger is a large upload. */
const STREAMED_UPLOAD_MAX_BYTES = 40 * 1024 * 1024;

/** How long one streamed upload, or one large upload's verification, may take. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export interface StoreContentInput {
  readonly kind: PrivateContentKind;
  readonly owner: ContentOwner;
  readonly bytes: Buffer;
  readonly mime: string;
  /** The file's own name, kept as Oxy's original name. */
  readonly name: string;
  /** The legacy key to write when Oxy does not hold it — unique per upload. */
  readonly legacyKey: string;
}

/** Raised when Oxy stored a private file as something other than private. Never recorded. */
class OxyFileVisibilityError extends Error {
  constructor(kind: PrivateContentKind | 'channel_media', visibility: string) {
    super(`Oxy stored a private ${kind} as ${visibility}`);
    this.name = 'OxyFileVisibilityError';
  }
}

/**
 * Store private content, and answer where it went.
 *
 * Whatever the backend, NOTHING names the stored bytes yet: the caller records
 * the row that does in its own transaction. A legacy object is therefore marked
 * as possible garbage BEFORE it is written, with an hour's grace; if the row
 * never commits, `storage-gc.ts` deletes it after that hour. An Oxy file needs
 * no such mark — an unreferenced application file is Oxy's to collect — but a
 * PERSON's is never collected (ADR 0043 D5), which is why the reference is
 * recorded in the same transaction as the row, and why a person's file that
 * lost its row stays visible to them as "not in use" rather than vanishing.
 */
export async function storePrivateContent(input: StoreContentInput): Promise<StoredContent> {
  try {
    const fileId = await storeInOxy(input);
    return { objectKey: null, oxyFileId: fileId };
  } catch (error: unknown) {
    // Taken-down bytes are refused for every owner (ADR 0043 D10); storing
    // them in the bucket instead would route around the takedown.
    if (isContentBlocked(error)) throw error;
    privateContentFallbackRecorded(input.kind, fallbackReason(error));
    log.files.warn(
      { err: error, kind: input.kind, reason: fallbackReason(error) },
      'Oxy did not take private content; storing it in the legacy bucket',
    );
  }
  await markLegacyObjectsMaybeGarbage(
    getDb(),
    [{ key: input.legacyKey, kind: input.kind }],
    LEGACY_UPLOAD_GRACE_SECONDS,
  );
  await uploadToS3Deterministic(input.bytes, input.legacyKey, input.mime);
  return { objectKey: input.legacyKey, oxyFileId: null };
}

/**
 * Copy bytes into Oxy for an existing legacy row — the migration's write. No
 * fallback: an item Oxy does not take stays on legacy storage and is reported.
 * Answers the file id only when Oxy stored exactly these bytes, privately.
 */
export async function copyIntoOxy(input: Omit<StoreContentInput, 'legacyKey'>): Promise<string> {
  return storeInOxy(input);
}

/**
 * Keep media that arrived for a person on a channel (a photo sent to their gemie's bot, a voice
 * note in their connected account) as THEIR private Oxy file, like an attachment they made in the
 * app: Oxy only, no legacy copy. Written under the channel's task — the durable authority the
 * person granted the gemie there, whose effective account is theirs — since a channel message
 * carries no session. Answers the file id; throws when Oxy does not take it, and the caller says
 * so in the conversation instead.
 */
export async function storeChannelMedia(input: {
  readonly oxyUserId: string;
  readonly taskId: string;
  readonly bytes: Buffer;
  readonly mime: string;
  readonly name: string;
}): Promise<string> {
  return storeInOxy({
    kind: 'channel_media',
    owner: { kind: 'person', oxyUserId: input.oxyUserId, requester: { taskId: input.taskId } },
    bytes: input.bytes,
    mime: input.mime,
    name: input.name,
  });
}

/** Whether a type is one Oxy's streamed service uploads take (image, video, audio). */
function isStreamedMedia(mime: string): boolean {
  const type = mime.toLowerCase();
  return type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/');
}

/** Which Oxy upload a file takes: streamed for small media, the large upload for the rest. */
export function uploadRoute(mime: string, size: number): 'streamed' | 'large' {
  return isStreamedMedia(mime) && size <= STREAMED_UPLOAD_MAX_BYTES ? 'streamed' : 'large';
}

/** What a file stored in Oxy only is, for an error that names it. */
type OxyOnlyInput = Omit<StoreContentInput, 'legacyKey' | 'kind'> & {
  readonly kind: PrivateContentKind | 'channel_media';
};

async function storeInOxy(input: OxyOnlyInput): Promise<string> {
  const expected = sha256Hex(input.bytes);
  const file = await uploadPrivate(input, expected);
  // A deduplicated file comes back as it already was, visibility included, and
  // an Oxy without stage 4c stores a person's small upload public whatever it
  // asks: either way, recording it would publish private content.
  if (file.visibility !== 'private') throw new OxyFileVisibilityError(input.kind, file.visibility);
  // An SVG is stored sanitized, so its hash is not the one sent; every other
  // mismatch is a fault. Either way the exact bytes stay where they can be read.
  if (file.sha256 !== expected) throw new OxyFileIntegrityError(expected, file.sha256);
  return file.id;
}

interface UploadedPrivateFile {
  readonly id: string;
  readonly sha256: string;
  readonly visibility: string;
}

async function uploadPrivate(input: OxyOnlyInput, sha256: string): Promise<UploadedPrivateFile> {
  const assets = oxy().assets;
  const route = uploadRoute(input.mime, input.bytes.length);
  if (input.owner.kind === 'alia') {
    if (route === 'streamed') {
      const { file } = await assets.uploadAppFile(input.bytes, input.mime, {
        visibility: 'private',
        originalName: input.name,
        timeout: UPLOAD_TIMEOUT_MS,
      });
      return file;
    }
    const { file } = await assets.uploadAppFileLarge(input.bytes, {
      mime: input.mime,
      sha256,
      filename: input.name,
      visibility: 'private',
      verifyTimeoutMs: UPLOAD_TIMEOUT_MS,
    });
    return file;
  }
  // As the person: Oxy checks the owner against the account this proof verifies.
  if (input.owner.requester === null) throw new OxyFileRequesterMissingError();
  const asPerson = assets.withRequester(input.owner.requester);
  if (route === 'streamed') {
    return asPerson.uploadUserMedia(input.owner.oxyUserId, input.bytes, input.mime, {
      visibility: 'private',
      originalName: input.name,
      timeout: UPLOAD_TIMEOUT_MS,
    });
  }
  const { file } = await asPerson.uploadUserMediaLarge(input.owner.oxyUserId, input.bytes, {
    mime: input.mime,
    sha256,
    filename: input.name,
    visibility: 'private',
    verifyTimeoutMs: UPLOAD_TIMEOUT_MS,
  });
  return file;
}

/** The HTTP status an Oxy SDK error carries, when it carries one. */
export function errorStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const record = error as { status?: unknown; response?: { status?: unknown } };
  if (typeof record.status === 'number') return record.status;
  if (typeof record.response?.status === 'number') return record.response.status;
  return undefined;
}

/** Whether Oxy refused the bytes because they were taken down (451 `CONTENT_BLOCKED`). */
function isContentBlocked(error: unknown): boolean {
  if (errorStatus(error) === 451) return true;
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'CONTENT_BLOCKED'
  );
}

/** A closed label for why a write fell back, for the metric and the log. */
function fallbackReason(error: unknown): string {
  if (error instanceof OxyFilesUnavailableError) return 'no_service_identity';
  if (error instanceof OxyFileRequesterMissingError) return 'no_requester';
  if (error instanceof OxyFileVisibilityError) return 'not_private';
  if (error instanceof OxyFileIntegrityError) return 'hash_mismatch';
  const status = errorStatus(error);
  if (status !== undefined) return status >= 500 ? 'oxy_5xx' : `oxy_${status}`;
  if (error instanceof Error && error.name === 'LargeUploadFailedError')
    return 'large_upload_failed';
  return 'unreachable';
}

/** One readable stored file. */
export type StoredContentStream = S3ObjectStream;

/**
 * Open stored content for streaming: the Oxy file first, the legacy object
 * when there is no Oxy file, or when Oxy failed to answer during the move.
 * Oxy's REFUSAL — the person revoked Alia's access, the file is gone or taken
 * down — is final and answers `null`, never the legacy copy.
 */
export async function openStoredContent(
  stored: StoredContent,
  kind: LegacyReadKind,
): Promise<StoredContentStream | null> {
  if (stored.oxyFileId !== null) {
    try {
      return await openOxyFile(stored.oxyFileId);
    } catch (error: unknown) {
      if (stored.objectKey === null) throw error;
      log.files.warn(
        { err: error, kind },
        'Oxy did not serve a migrated file; reading the legacy copy',
      );
    }
  }
  if (stored.objectKey === null) return null;
  return openLegacyObject(stored.objectKey, kind);
}

/** How long an Oxy download link may take to start answering. */
const OXY_DOWNLOAD_RESPONSE_TIMEOUT_MS = 30_000;

/** Raised when an Oxy download link Alia was given did not serve the file (0: no answer in time). */
class OxyDownloadError extends Error {
  constructor(readonly status: number) {
    super(`An Oxy download link answered ${status}`);
    this.name = 'OxyDownloadError';
  }
}

/**
 * Stream one Oxy file Alia may read: its own files, and a person's file Alia
 * stored for them or that they attached to Alia, until they revoke that
 * (`linkedDownloadUrls`, ADR 0043 stage 4c). `null` is Oxy's refusal; a
 * failure to answer throws.
 */
async function openOxyFile(fileId: string): Promise<StoredContentStream | null> {
  const [link] = await oxy().assets.linkedDownloadUrls([fileId]);
  if (link === undefined) return null;
  // An Oxy-minted link on Oxy's own storage host: a trusted fixed host, so a
  // plain fetch — bounded until the response starts. The body is streamed on
  // to the reader, whose own connection decides how long that takes.
  const started = new AbortController();
  const deadline = setTimeout(
    () => started.abort(new OxyDownloadError(0)),
    OXY_DOWNLOAD_RESPONSE_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(link.url, { signal: started.signal });
  } finally {
    clearTimeout(deadline);
  }
  if (!response.ok || response.body === null) throw new OxyDownloadError(response.status);
  return {
    body: Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    contentType: link.mime,
    contentLength: link.size,
  };
}

/**
 * A file this application stored for a person, or that they attached to it, read through its own
 * consented link (`linkedDownloadUrls`): the read a channel turn has, since it carries no session
 * and the task that stored its media is not a proof Oxy takes to read it back. `null` is Oxy's
 * refusal (the person revoked it, or it is not this application's to read).
 */
export async function readLinkedFile(
  fileId: string,
): Promise<{ mime: string; size: number; bytes: () => Promise<Uint8Array> } | null> {
  const [link] = await oxy().assets.linkedDownloadUrls([fileId]);
  if (link === undefined) return null;
  return {
    mime: link.mime,
    size: link.size,
    bytes: async () => {
      const response = await fetch(link.url, {
        signal: AbortSignal.timeout(OXY_DOWNLOAD_RESPONSE_TIMEOUT_MS),
      });
      if (!response.ok) throw new OxyDownloadError(response.status);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/** Read one legacy object, and count the read. */
async function openLegacyObject(
  key: string,
  kind: LegacyReadKind,
): Promise<StoredContentStream | null> {
  noteLegacyRead(kind);
  return readS3Object(key);
}

/**
 * Count one legacy read — in the process counter at once and in Postgres
 * for the retirement gate. The durable count is best effort: a read must not
 * fail because its bookkeeping did.
 */
function noteLegacyRead(kind: LegacyReadKind, db?: ApiDatabase): void {
  legacyStorageReadRecorded(kind);
  void Promise.resolve()
    .then(() => countLegacyRead(db ?? getDb(), kind))
    .catch((err: unknown) =>
      log.files.warn({ err, kind }, 'Could not count a legacy storage read'),
    );
}

/**
 * Which kind a legacy key holds, from the folder `lib/s3.ts` wrote it under
 * (`<env>/<folder>/…`). Only the playback route needs it: it is handed a key
 * and nothing else.
 */
export function legacyKindOfKey(key: string): LegacyReadKind {
  const folder = key.split('/')[1] ?? '';
  if (folder === 'library') return 'library_file';
  if (folder === 'tts') return 'speech_clip';
  if (folder === 'skills') return 'skill_file';
  if (folder.startsWith('audio')) return 'audio_job';
  return 'other';
}

/** A fresh, unique legacy key: `<env>/<folder>/<descriptor>-<uuid>.<ext>`, as `uploadToS3` writes. */
export function newLegacyKey(folder: string, descriptor: string, filename: string): string {
  const env = process.env.NODE_ENV || 'development';
  const base = filename.split('/').pop() ?? '';
  const ext = base.includes('.') ? (base.split('.').pop() ?? '') : '';
  return `${env}/${folder}/${descriptor}-${randomUUID()}${ext === '' ? '' : `.${ext}`}`;
}
