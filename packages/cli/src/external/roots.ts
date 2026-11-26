/**
 * Which folders a session may work in (Gemies ADR 0043 §3). Gemies asks for a folder; this computer
 * decides. A folder is accepted only inside a root its owner allowed here (`gemies allow <folder>`)
 * or the folder the agent was paired in, after symlinks are resolved, so a link inside an allowed
 * root cannot lead out of it, and a compromised server cannot ask for `~/.ssh`.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type SessionCwd = { ok: true; cwd: string } | { ok: false; message: string };

/** `~` and `~/x` mean the home folder of whoever runs the daemon. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return path;
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isInside(root: string, folder: string): boolean {
  const rel = relative(root, folder);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * The folder a turn runs in. `requested` is what Gemies asked for; `roots` what this computer allows.
 * Nothing is created: the folder must already exist and be a directory.
 */
export function resolveSessionCwd(
  requested: string,
  roots: readonly string[],
  home: string = homedir(),
): SessionCwd {
  const expanded = expandHome(requested, home);
  if (!isAbsolute(expanded)) return { ok: false, message: 'The folder must be an absolute path.' };
  const folder = resolve(expanded);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    return { ok: false, message: `The folder ${requested} does not exist on this computer.` };
  }
  const actual = real(folder);
  const allowed =
    actual !== null &&
    roots.some((root) => {
      const rootReal = real(resolve(expandHome(root, home)));
      return rootReal !== null && isInside(rootReal, actual);
    });
  if (!allowed) {
    return {
      ok: false,
      message: `${requested} is not a folder this computer allows. Run \`gemies allow ${requested}\` there to allow it.`,
    };
  }
  return { ok: true, cwd: actual };
}
