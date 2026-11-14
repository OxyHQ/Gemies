/**
 * What the production canaries share and nothing else: the QA account check
 * and the public-domain recording they speak (LibriVox's Gettysburg Address,
 * archive.org/details/gettysburg_address_librivox), fetched at run time,
 * checked against a pinned SHA-256 and decoded with the image's own
 * `ffmpeg-static`, so no audio is checked in. No module here runs on import.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const CANARY_AUDIO = {
  url: 'https://archive.org/download/gettysburg_address_librivox/gettysburg_address_lincoln_64kb.mp3',
  sha256: '59d825396d35e13601bbdc79a4867f7a55b09a6c65f1792657a2c67ddf666ead',
} as const;

const SAMPLE_RATE = 24_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The QA account in ALIA_CANARY_OXY_USER_ID, or a refusal; never echoed whole. */
export function qaAccount(env: NodeJS.ProcessEnv): string {
  const account = env.ALIA_CANARY_OXY_USER_ID;
  if (
    !account ||
    !/^([a-f0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(
      account,
    )
  )
    throw new Error('ALIA_CANARY_OXY_USER_ID must name one exact QA account');
  return account;
}

/** The recording's first `seconds` as mono 24 kHz: raw PCM16 to stream, a WAV clip to upload. */
function ffmpegDecode(
  ffmpeg: string,
  input: string | Uint8Array,
  seconds: number,
  container: 's16le' | 'wav' = 's16le',
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        typeof input === 'string' ? input : 'pipe:0',
        '-t',
        String(seconds),
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        ...(container === 'wav' ? ['-c:a', 'pcm_s16le'] : []),
        '-f',
        container,
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on('error', reject);
    // `-t` makes ffmpeg stop reading once it has the seconds it needs, so the
    // rest of a piped recording meets a closed stdin: EPIPE is that, not a
    // failure. Unhandled, it crashed the process after the report was written.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 300)}`)),
    );
    if (typeof input === 'string') child.stdin.end();
    else child.stdin.end(Buffer.from(input));
  });
}

async function ffmpegPath(): Promise<string> {
  const module = (await import('ffmpeg-static')) as { default: string | null };
  if (!module.default) throw new Error('ffmpeg-static has no binary for this platform');
  return module.default;
}

/** archive.org answers an occasional 500 from one mirror, so three tries. */
async function fetchRecording(): Promise<Uint8Array> {
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(5_000);
    const response = await fetch(CANARY_AUDIO.url, { signal: AbortSignal.timeout(60_000) });
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    status = response.status;
  }
  throw new Error(`fetching the recording answered ${status} three times`);
}

/** 24 kHz mono of the recording's (or a local file's) first `seconds`: PCM16 or a WAV clip. */
export async function loadRecording(options: {
  readonly seconds: number;
  readonly container: 's16le' | 'wav';
  readonly audioFile?: string;
}): Promise<Buffer> {
  const ffmpeg = await ffmpegPath();
  if (options.audioFile !== undefined)
    return ffmpegDecode(ffmpeg, options.audioFile, options.seconds, options.container);
  const bytes = await fetchRecording();
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== CANARY_AUDIO.sha256) throw new Error(`the recording's SHA-256 is ${digest}`);
  return ffmpegDecode(ffmpeg, bytes, options.seconds, options.container);
}
