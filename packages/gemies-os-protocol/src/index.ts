/**
 * GemiesOS's wire contract: what the Gemies API sends to GemiesOS's control API
 * (`packages/gemies-os/src/http.ts`) and what it answers.
 *
 * One copy, imported by both sides. GemiesOS validates every request body with
 * the schemas below; the API's client (`packages/api/src/lib/computer/
 * computer-client.ts`) and its live-view routes build and type their calls from
 * the same names, so a field added on one side is a type error on the other
 * rather than a silent mismatch.
 *
 * Responses are `{ data }` or `{ error: { code, message } }` ({@link WireError}).
 * Nothing here is a credential or a secret: the token comes from the workload
 * exchange (oxy ADR 0026), not from this package.
 */
import { z } from 'zod';

/** Every actor's computer mounts its own volume here, and only here. */
export const WORKSPACE = '/workspace';

// ── The computer ────────────────────────────────────────────────────────────

export type ComputerState = 'running' | 'stopped';

export interface ComputerStatus {
  state: ComputerState;
  workspace: typeof WORKSPACE;
  network: 'disabled';
  /** Last measured size of `/workspace`, when the computer is running. */
  usageBytes: number | null;
  quotaBytes: number;
  idleStopMinutes: number;
}

export const commandRequestSchema = z
  .object({
    operationId: z.string().min(1).max(128),
    command: z.string().min(1).max(16_000),
    cwd: z.string().max(2048).optional(),
    timeoutSeconds: z.number().int().positive().max(3600).optional(),
    background: z.boolean().optional(),
  })
  .strict();

export type CommandRequest = z.infer<typeof commandRequestSchema>;

export type CommandStatus =
  | 'running'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'interrupted';

export interface CommandReceipt {
  operationId: string;
  command: string;
  cwd: string;
  background: boolean;
  status: CommandStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  startedAt: string;
  completedAt: string | null;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
}

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
  truncated: boolean;
}

// ── The browser ─────────────────────────────────────────────────────────────

/** The browser's page size; a click outside it is refused. */
export const VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * Keys a form needs, and nothing that reaches the browser's own UI: no
 * arbitrary chord, no "evaluate this JavaScript", no selector. Each of those
 * would act on a page in a way the screenshot the owner watches does not show.
 */
export const ALLOWED_KEYS = [
  'Enter',
  'Tab',
  'Shift+Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Control+a',
  'Meta+a',
] as const;

export type AllowedKey = (typeof ALLOWED_KEYS)[number];

const MAX_TYPED_CHARACTERS = 2000;
const MAX_SCROLL_PIXELS = 5000;

const coordinate = (max: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(max - 1);

const scrollDelta = z.number().int().min(-MAX_SCROLL_PIXELS).max(MAX_SCROLL_PIXELS);

/** The whole vocabulary anyone — the agent or its owner — can speak to the browser. */
export const browserInputSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('click'),
      x: coordinate(VIEWPORT.width),
      y: coordinate(VIEWPORT.height),
    })
    .strict(),
  z.object({ type: z.literal('type'), text: z.string().min(1).max(MAX_TYPED_CHARACTERS) }).strict(),
  z.object({ type: z.literal('key'), key: z.enum(ALLOWED_KEYS) }).strict(),
  z
    .object({ type: z.literal('scroll'), deltaY: scrollDelta, deltaX: scrollDelta.optional() })
    .strict(),
]);

export type BrowserInput = z.infer<typeof browserInputSchema>;

/** Who is acting. The owner taking over is how logins and captchas get done. */
export const actorRoleSchema = z.enum(['agent', 'owner']);
export type ActorRole = z.infer<typeof actorRoleSchema>;

export interface BrowserState {
  state: 'open' | 'closed';
  url: string;
  title: string;
  controller: ActorRole;
  pendingDownloads: number;
  lastActiveAt: string | null;
}

export interface SavedDownload {
  path: string;
  bytes: number;
  mimeType: string;
}

export interface BrowserResult extends BrowserState {
  /** Files moved into `/workspace/downloads` during this call. */
  downloads: SavedDownload[];
  /** Why a download did not arrive (too large, unsupported type, computer busy). */
  downloadNotes: string[];
}

export interface PageElement {
  tag: string;
  label: string;
  x: number;
  y: number;
  type?: string;
  role?: string;
  href?: string;
  password?: boolean;
  focused?: boolean;
}

/** What the page says: its text and its clickable elements, read by a fixed function. */
export interface PageReading {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  elements: PageElement[];
}

/** `GET …/browser/read`: the reading, plus any download that arrived meanwhile. */
export interface BrowserReading extends PageReading {
  downloads: SavedDownload[];
}

/**
 * What an agent or its owner did in the browser, for the owner to read back.
 *
 * It never carries what was TYPED (a password is typed here) or a full URL (a
 * query string can hold a token): only the action, who did it, the site's
 * origin and the outcome.
 */
export interface BrowserActionReceipt {
  action: 'open' | 'navigate' | 'input' | 'control' | 'close' | 'download';
  by: ActorRole;
  origin: string;
  detail: string;
  status: 'ok' | 'refused' | 'failed';
  at: string;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** A refusal: `code` is a stable machine word the API branches on, `message` is for people. */
export interface WireError {
  code: string;
  message: string;
}
