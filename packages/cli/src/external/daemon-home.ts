/**
 * Where the background daemon lives on this machine: its log, its lock, and a copy of the CLI that
 * outlives npx's cache, so the service never points at a directory npm may clean.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunCommand } from './service.js';

export interface DaemonHome {
  readonly dataDir: string;
  /** What `gemies serve` writes: one line per event, read back by `connect` and `status`. */
  readonly log: string;
  /** What the service manager catches before the daemon's own log is open. */
  readonly errorLog: string;
  /** The running daemon's pid: one daemon per machine. */
  readonly pidFile: string;
  /** The stable copy of the CLI the service runs. */
  readonly runtimeDir: string;
}

export function daemonHome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): DaemonHome {
  const dataDir =
    platform === 'win32'
      ? join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Codea')
      : platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'Codea')
        : join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'codea');
  return {
    dataDir,
    log: join(dataDir, 'daemon.log'),
    errorLog: join(dataDir, 'daemon.err.log'),
    pidFile: join(dataDir, 'daemon.pid'),
    runtimeDir: join(dataDir, 'runtime'),
  };
}

/** The CLI was started by npx: its files sit in a cache npm may clear at any time. */
export function runsFromNpxCache(script: string): boolean {
  return /[\\/]_npx[\\/]/.test(script);
}

/**
 * The entry the service runs. A CLI installed for good (globally, or a checkout) is used where it
 * is; one npx fetched is installed once, at this exact version, under the daemon's own directory.
 */
export async function stableEntry(input: {
  script: string;
  version: string;
  runtimeDir: string;
  run: RunCommand;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const { script, version, runtimeDir, run } = input;
  if (!runsFromNpxCache(script)) return realpathSync(script);
  const env = input.env ?? process.env;
  // npx sets `npm_execpath` to npm's own entry: run it with this Node, which needs no shell (a
  // `.cmd` on Windows would).
  const npmCli =
    env.npm_execpath && /npm-cli\.js$/.test(env.npm_execpath) ? env.npm_execpath : null;
  const args = [
    'install',
    '--prefix',
    runtimeDir,
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    `@gemies/cli@${version}`,
  ];
  const result = npmCli
    ? await run(process.execPath, [npmCli, ...args])
    : await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args);
  if (result.code !== 0) {
    throw new Error(
      `Could not install @gemies/cli@${version} for the service: ${result.stderr.trim()}`,
    );
  }
  return join(runtimeDir, 'node_modules', '@gemies', 'cli', 'dist', 'index.js');
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Appends timestamped lines; past 5 MB the log moves to `.1` and starts over. */
export function daemonLogger(path: string): (line: string) => void {
  return (line) => {
    try {
      if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // A log that cannot be written must not take the daemon down.
    }
  };
}

/** The log's current size, so a reader can wait for what comes after it. */
export function logSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** The log from `offset` on. */
export function logSince(path: string, offset: number): string {
  try {
    return readFileSync(path, 'utf8').slice(offset);
  } catch {
    return '';
  }
}

/**
 * Takes the machine's one daemon slot: false when another daemon holds it. Two daemons serving one
 * agent would replace each other's connection forever.
 */
export function claimDaemonSlot(pidFile: string, pid = process.pid): boolean {
  try {
    const held = Number(readFileSync(pidFile, 'utf8'));
    if (Number.isInteger(held) && held > 0 && held !== pid) {
      process.kill(held, 0);
      return false;
    }
  } catch {
    // No file, or its process is gone: the slot is free.
  }
  mkdirSync(join(pidFile, '..'), { recursive: true });
  writeFileSync(pidFile, String(pid));
  return true;
}

export function releaseDaemonSlot(pidFile: string, pid = process.pid): void {
  try {
    if (Number(readFileSync(pidFile, 'utf8')) === pid) rmSync(pidFile, { force: true });
  } catch {
    // Already gone.
  }
}
