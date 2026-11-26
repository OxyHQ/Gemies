/**
 * `gemies connect` — serve a coding-agent CLI to Gemies as one of the person's gemies (Gemies ADR 0030,
 * ADR 0038, ADR 0039).
 *
 *   gemies connect AB12-CD34-EF56-GH78 --cli codex     pair this machine and keep it connected
 *   gemies connect                                     reinstall the service for what is paired here
 *   gemies status                                      the service, the agents, the last log lines
 *   gemies disconnect [--forget]                       stop and remove the service
 *
 * No sign-in of any kind. The pairing code, minted in Gemies by the signed-in person, is the whole
 * authorisation: redeeming it returns a credential for that one agent, kept on this machine (0600).
 *
 * Then it installs the daemon as a per-user service (`external/service.ts`) and returns once the
 * service reports the agent connected. From there the agent is autonomous: the service starts at
 * login, restarts on failure and outlives the session that ran this, so nobody has to reconnect it.
 *
 * Outbound only: the daemon dials Gemies over WebSocket and drives the installed CLI under the
 * person's own login to it. Nothing listens on this machine.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { config, DEFAULT_API_BASE_URL } from './utils/config.js';
import { startDaemon, type Daemon } from './external/daemon.js';
import {
  claimDaemonSlot,
  daemonHome,
  daemonLogger,
  logSince,
  logSize,
  releaseDaemonSlot,
  stableEntry,
} from './external/daemon-home.js';
import { gemieToolsUrl } from './external/gemie-tools.js';
import { runProcess } from './external/process.js';
import {
  NEW_CODE_HINT,
  redeemCode,
  redeemMachine,
  type ConnectableAgent,
} from './external/redeem.js';
import { runtimeFor } from './external/registry.js';
import { expandHome } from './external/roots.js';
import { serviceManagerFor, type RunCommand, type ServiceManager } from './external/service.js';
import {
  allowedRoots,
  allowRoot,
  disallowRoot,
  forgetAgent,
  forgetAllAgents,
  pairedAgents,
  rememberAgent,
  sessionStore,
  type PairedAgent,
} from './external/state.js';
import { EXTERNAL_CLIS, isExternalCli, type ExternalCli } from './external/types.js';

export interface ConnectOptions {
  cli?: string;
  agent?: string;
  cwd?: string;
  /** Commander turns `--read-only` into `readOnly`. */
  readOnly?: boolean;
}

/** How long `connect` waits for the service to report the agent connected. */
const CONNECT_WAIT_MS = 45_000;

/** A command run without a shell; a missing binary or a signal is a failure, not a throw. */
const run: RunCommand = async (command, args) => {
  const result = await runProcess({
    command,
    args,
    cwd: homedir(),
    signal: new AbortController().signal,
  }).catch((err: unknown) => ({ code: 127, stdout: '', stderr: String(err) }));
  return { ...result, code: result.code ?? 1 };
};

async function installed(cli: ExternalCli): Promise<boolean> {
  return (await run(cli, ['--version'])).code === 0;
}

/**
 * The CLIs a pairing covers: the one asked for with `--cli`, or every supported CLI this computer has
 * (Gemies ADR 0043: a computer is paired once and serves a gemie per CLI). Null, after saying why,
 * when there is none.
 */
async function chooseClis(requested: string | undefined): Promise<ExternalCli[] | null> {
  if (requested !== undefined) {
    if (!isExternalCli(requested)) {
      console.error(chalk.red(`--cli must be one of: ${EXTERNAL_CLIS.join(', ')}`));
      return null;
    }
    if (!(await installed(requested))) {
      console.error(chalk.red(`\`${requested}\` is not installed or not on the PATH.`));
      return null;
    }
    return [requested];
  }
  const found: ExternalCli[] = [];
  for (const cli of EXTERNAL_CLIS) if (await installed(cli)) found.push(cli);
  if (found.length === 0) {
    console.error(chalk.red(`No supported CLI found (${EXTERNAL_CLIS.join(', ')}).`));
    return null;
  }
  return found;
}

const connectable = (agent: PairedAgent): agent is ConnectableAgent =>
  typeof agent.credential === 'string' && agent.credential !== '';

const apiBase = () => config.get('apiBaseUrl') || DEFAULT_API_BASE_URL;

async function manager(): Promise<ServiceManager> {
  const home = daemonHome();
  return serviceManagerFor({
    platform: process.platform,
    run,
    env: process.env,
    dataDir: home.dataDir,
    pidFile: home.pidFile,
    errorLog: home.errorLog,
  });
}

/** What the service keeps of this shell's environment (`ServiceSpec.env`). */
function serviceEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = { PATH: env.PATH ?? '' };
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME'] as const) {
    const value = env[key];
    if (value) kept[key] = value;
  }
  return kept;
}

function describeAgent(agent: PairedAgent): string {
  const where = agent.cwd ?? homedir();
  return `${agent.name}: works in ${where}${agent.write === false ? ' (read-only)' : ', may edit files there'}`;
}

/** Waits until the service has logged every agent connected, or the deadline passes. */
async function waitForConnected(log: string, offset: number, names: string[]): Promise<string[]> {
  const deadline = Date.now() + CONNECT_WAIT_MS;
  for (;;) {
    const written = logSince(log, offset);
    const missing = names.filter((name) => !written.includes(`Connected: ${name}`));
    if (missing.length === 0 || Date.now() > deadline) return missing;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function connect(
  code: string | undefined,
  options: ConnectOptions,
  version: string,
): Promise<void> {
  const apiBaseUrl = apiBase();
  const cwd = resolve(options.cwd ?? process.cwd());
  const write = options.readOnly !== true;

  if (code !== undefined) {
    const clis = await chooseClis(options.cli);
    if (clis === null) process.exit(1);
    const hostName = hostname().slice(0, 80) || 'this computer';
    // One CLI goes through the request every Gemies version understands; several pair the computer.
    const redeemed =
      clis.length === 1
        ? await redeemCode({ apiBaseUrl, code, cli: clis[0], hostName })
        : await redeemMachine({ apiBaseUrl, code, clis, hostName });
    if (typeof redeemed === 'string') {
      console.error(chalk.red(redeemed));
      process.exit(1);
    }
    for (const agent of Array.isArray(redeemed) ? redeemed : [redeemed]) {
      rememberAgent({ ...agent, cwd, write });
      console.log(chalk.green(`Paired: ${agent.name}`));
    }
  } else if (options.cwd !== undefined || options.readOnly !== undefined) {
    // Without a code, the options move the agents already paired here.
    for (const agent of pairedAgents(apiBaseUrl)) {
      if (options.agent === undefined || agent.agentId === options.agent) {
        rememberAgent({ ...agent, cwd, write });
      }
    }
  }

  const agents = pairedAgents(apiBaseUrl);
  // Paired by Codea 3.x, with the person's Oxy session: Gemies issues it a credential once it is
  // reconnected with a code made for it.
  for (const agent of agents.filter((a) => !connectable(a))) {
    console.error(
      chalk.yellow(
        `${agent.name} needs reconnecting once: in Gemies, Settings → Connect external Gemie → Reconnect, then paste the text it gives you into your agent.`,
      ),
    );
  }
  const serving = agents.filter(connectable);
  if (serving.length === 0) {
    if (agents.length === 0) {
      console.error(chalk.red(`This machine is not paired with any agent. ${NEW_CODE_HINT}`));
    }
    process.exit(1);
  }

  const home = daemonHome();
  const service = await manager();
  const offset = logSize(home.log);
  let notes: string[];
  try {
    const script = await stableEntry({
      script: process.argv[1] ?? '',
      version,
      runtimeDir: home.runtimeDir,
      run,
    });
    notes = await service.install({
      node: process.execPath,
      script,
      env: serviceEnv(process.env),
      errorLog: home.errorLog,
      home: homedir(),
    });
  } catch (err: unknown) {
    console.error(chalk.red(`Could not install the background service: ${(err as Error).message}`));
    process.exit(1);
  }

  const { what, where } = service.describe();
  console.log(
    chalk.gray(`Installed ${what} (${where}): it starts at login and restarts if it fails.`),
  );
  for (const note of notes) console.log(chalk.gray(note));
  for (const agent of serving) console.log(chalk.gray(describeAgent(agent)));
  console.log(
    chalk.gray(
      `Logs: ${home.log}. Check it with \`gemies status\`; remove it with \`gemies disconnect\`.`,
    ),
  );

  const missing = await waitForConnected(
    home.log,
    offset,
    serving.map((agent) => agent.name),
  );
  for (const agent of serving) {
    if (!missing.includes(agent.name)) console.log(chalk.green(`Connected: ${agent.name}`));
  }
  if (missing.length > 0) {
    console.error(
      chalk.yellow(
        `The service is installed but has not connected ${missing.join(', ')} yet; it keeps trying. Last lines of ${home.log}:\n${logSince(home.log, offset).trim().split('\n').slice(-8).join('\n')}`,
      ),
    );
    process.exit(1);
  }
}

/**
 * `gemies serve` — what the service runs: every agent paired here, each in its own folder, until
 * the service is stopped. Exits 0 when nothing is left to serve (revoked agents), and non-zero when
 * Gemies keeps refusing, so the service manager restarts it.
 */
export async function serve(): Promise<void> {
  const home = daemonHome();
  const log = daemonLogger(home.log);
  if (!claimDaemonSlot(home.pidFile)) {
    console.error('Another Gemies daemon is already serving this machine (see `gemies status`).');
    process.exit(0);
  }
  const apiBaseUrl = apiBase();
  const agents = pairedAgents(apiBaseUrl).filter(connectable);
  if (agents.length === 0) {
    log('Nothing to serve: no agent is paired on this machine.');
    releaseDaemonSlot(home.pidFile);
    return;
  }

  const wsUrl = `${apiBaseUrl.replace(/^http/, 'ws')}/ws/external-agent`;
  const daemons: Daemon[] = [];
  log(`Serving ${agents.length} agent(s) from ${apiBaseUrl}`);
  for (const agent of agents) {
    let announced = false;
    const daemon = startDaemon({
      wsUrl,
      agentId: agent.agentId,
      agentName: agent.name,
      runtime: runtimeFor(agent.cli),
      cli: agent.cli,
      sessions: sessionStore(),
      allowedRoots,
      cwd: agent.cwd ?? homedir(),
      write: agent.write !== false,
      credential: agent.credential,
      toolsUrl: gemieToolsUrl(apiBaseUrl, agent.agentId),
      log: (message) => {
        if (message === 'connected') {
          // Every reconnect is logged; `connect` waits for the first one after it installed.
          log(`Connected: ${agent.name}`);
          if (!announced) console.log(`Connected: ${agent.name}`);
          announced = true;
          return;
        }
        log(`[${agent.name}] ${message}`);
      },
    });
    daemons.push(daemon);
    void daemon.done.then((exit) => {
      if (exit.reason === 'revoked' || exit.reason === 'unknown-agent') {
        forgetAgent(agent.agentId, agent.credential);
        log(`${agent.name} was removed in Gemies; this machine forgot it.`);
      } else if (exit.reason === 'credential-rejected') {
        forgetAgent(agent.agentId, agent.credential);
        log(`${agent.name} was reconnected with a newer code; this connection stopped.`);
      }
    });
  }

  const stopAll = () => {
    for (const daemon of daemons) daemon.stop();
  };
  process.once('SIGINT', stopAll);
  process.once('SIGTERM', stopAll);

  const exits = await Promise.all(daemons.map((daemon) => daemon.done));
  releaseDaemonSlot(home.pidFile);
  if (exits.some((exit) => exit.reason === 'auth-failed')) {
    log('Gemies kept refusing a connection; exiting so the service restarts this daemon.');
    process.exit(1);
  }
}

/** `gemies status` — the service, the agents it serves and its last log lines. */
export async function status(): Promise<void> {
  const home = daemonHome();
  const service = await manager();
  const state = await service.state();
  const { what, where } = service.describe();
  console.log(
    `${state.installed ? 'Installed' : 'Not installed'}: ${what} (${where}) — ${state.detail}`,
  );
  const agents = pairedAgents(apiBase());
  if (agents.length === 0) console.log('No agent is paired on this machine.');
  for (const agent of agents) {
    console.log(`  ${describeAgent(agent)}${connectable(agent) ? '' : ' (needs reconnecting)'}`);
  }
  const tail = logSince(home.log, Math.max(0, logSize(home.log) - 4000))
    .trim()
    .split('\n')
    .slice(-10)
    .join('\n');
  if (tail) console.log(chalk.gray(`\nLast lines of ${home.log}:\n${tail}`));
  if (state.installed) console.log(chalk.gray('\nRemove it with `gemies disconnect`.'));
}

/** `gemies disconnect` — stop and remove the service; with `--forget`, the agents' credentials too. */
export async function disconnect(options: { forget?: boolean }): Promise<void> {
  const service = await manager();
  const { what } = service.describe();
  await service.uninstall();
  console.log(`Stopped and removed ${what}. Nothing of Gemies runs in the background now.`);
  if (options.forget) {
    forgetAllAgents();
    console.log(
      'This machine forgot its agents and their credentials. Remove them in Gemies (Settings → Connect external Gemie) to revoke them there too.',
    );
  } else {
    console.log('The agents stay paired here: `gemies connect` installs the service again.');
  }
}

/**
 * `gemies allow [folder]` — which folders sessions opened from Gemies may work in (ADR 0043).
 * Gemies only asks for a folder; this computer decides, and a folder outside what is allowed here is
 * refused. With no folder, lists them; `--remove` stops allowing one.
 */
export function allow(folder: string | undefined, options: { remove?: boolean }): void {
  if (folder === undefined) {
    const roots = allowedRoots();
    if (roots.length === 0) {
      console.log(
        'No folder is allowed for sessions opened from Gemies yet. Allow one with `gemies allow <folder>`.',
      );
    }
    for (const root of roots) console.log(root);
    return;
  }
  const path = resolve(expandHome(folder));
  if (options.remove) {
    console.log(
      disallowRoot(path) ? `No longer allowed: ${path}` : `${path} was not an allowed folder.`,
    );
    return;
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    console.error(chalk.red(`${path} is not a folder on this computer.`));
    process.exit(1);
  }
  const real = realpathSync(path);
  console.log(
    allowRoot(real)
      ? chalk.green(`Sessions opened from Gemies may now work in ${real} and everything under it.`)
      : `${real} was already allowed.`,
  );
}
