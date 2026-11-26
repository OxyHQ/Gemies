/**
 * The daemon as a per-user service (Gemies ADR 0038): it starts at login, restarts when it fails and
 * outlives the CLI session that ran `gemies connect`, so a gemie is never waiting for its person to
 * reconnect it.
 *
 *  - Linux: a systemd `--user` unit, `codea.service`, enabled for `default.target`, with lingering
 *    turned on when Linux allows it, so it also runs after a reboot before anybody logs in.
 *  - macOS: a launchd LaunchAgent, `so.oxy.codea`, loaded at login and kept alive on failure.
 *  - Windows: a Scheduled Task, `Codea`, run at logon and restarted on failure.
 *  - Anything else (a Linux without a user systemd, as WSL without `systemd=true`): a detached
 *    process, which survives the session but not a restart, and says so.
 *
 * Every manager runs the same command, `<node> <codea> serve`, which serves every agent paired on
 * this machine and writes its own log. Nothing here asks the person anything: they pasted one text.
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

/** What the service runs and where. */
export interface ServiceSpec {
  /** Absolute path of the Node binary. */
  readonly node: string;
  /** Absolute path of the CLI's entry (`dist/index.js`) in a place that outlives npx's cache. */
  readonly script: string;
  /**
   * The environment the daemon needs from the person's: the PATH its agent CLIs (`claude`, `codex`,
   * `opencode`) are found on, and the XDG folders when they are set, so the service reads the same
   * pairing and writes the same log as the `codea` that installed it.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Where the service's own output goes when the daemon cannot write its log. */
  readonly errorLog: string;
  readonly home: string;
}

export type ServiceKind = 'systemd' | 'launchd' | 'schtasks' | 'detached';

export interface ServiceState {
  readonly installed: boolean;
  readonly running: boolean;
  /** One line from the manager, for `gemies status`. */
  readonly detail: string;
}

/** What the person is told: what was installed, and how to remove it. */
export interface ServiceDescription {
  readonly kind: ServiceKind;
  readonly what: string;
  readonly where: string;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export type RunCommand = (command: string, args: readonly string[]) => Promise<CommandResult>;

export interface ServiceManager {
  readonly kind: ServiceKind;
  describe(): ServiceDescription;
  /** Writes (or rewrites) the service and (re)starts it. Returns notes worth telling the person. */
  install(spec: ServiceSpec): Promise<string[]>;
  /** Stops and removes it; nothing left behind. */
  uninstall(): Promise<void>;
  state(): Promise<ServiceState>;
}

export const SYSTEMD_UNIT = 'codea.service';
export const LAUNCHD_LABEL = 'so.oxy.codea';
export const WINDOWS_TASK = 'Codea';

const DESCRIPTION = 'Gemies: serves your coding agents to Gemies';

/** `"a b"` for systemd and for Windows: a path with a space stays one argument. */
const quoted = (value: string): string => `"${value.replace(/(["\\])/g, '\\$1')}"`;

const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The systemd user unit. `on-failure`: a daemon that exits 0 has nothing left to serve. */
export function systemdUnit(spec: ServiceSpec): string {
  return [
    '[Unit]',
    `Description=${DESCRIPTION}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quoted(spec.node)} ${quoted(spec.script)} serve`,
    `WorkingDirectory=${spec.home}`,
    ...Object.entries(spec.env).map(([key, value]) => `Environment=${quoted(`${key}=${value}`)}`),
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** The LaunchAgent. `KeepAlive.SuccessfulExit = false`: restarted unless it exits 0. */
export function launchdPlist(spec: ServiceSpec): string {
  const string = (value: string) => `<string>${xml(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${string(LAUNCHD_LABEL)}`,
    `  <key>ProgramArguments</key><array>${string(spec.node)}${string(spec.script)}${string('serve')}</array>`,
    `  <key>EnvironmentVariables</key><dict>${Object.entries(spec.env)
      .map(([key, value]) => `<key>${xml(key)}</key>${string(value)}`)
      .join('')}</dict>`,
    `  <key>WorkingDirectory</key>${string(spec.home)}`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ProcessType</key><string>Background</string>',
    `  <key>StandardOutPath</key>${string('/dev/null')}`,
    `  <key>StandardErrorPath</key>${string(spec.errorLog)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * The Scheduled Task: at this user's logon, restarted every minute on failure for as long as it
 * fails, with no time limit, and started now when it was missed.
 */
export function scheduledTaskXml(spec: ServiceSpec, user: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>${xml(DESCRIPTION)}</Description></RegistrationInfo>`,
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>`,
    '  <Principals><Principal id="Author">',
    `    <UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>`,
    '  </Principal></Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>',
    '    <Hidden>true</Hidden>',
    '  </Settings>',
    '  <Actions Context="Author"><Exec>',
    `    <Command>${xml(spec.node)}</Command>`,
    `    <Arguments>${xml(`${quoted(spec.script)} serve`)}</Arguments>`,
    `    <WorkingDirectory>${xml(spec.home)}</WorkingDirectory>`,
    '  </Exec></Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

function writeFile(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function must(run: RunCommand, command: string, args: readonly string[]): Promise<string> {
  const result = await run(command, args);
  if (result.code !== 0) {
    throw new Error(
      `\`${command} ${args.join(' ')}\` failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

function systemdManager(run: RunCommand, managerEnvironment: string): ServiceManager {
  // Where the user manager looks: ITS `XDG_CONFIG_HOME`, which need not be this shell's.
  const configHome =
    /^XDG_CONFIG_HOME=(.+)$/m.exec(managerEnvironment)?.[1] || join(homedir(), '.config');
  const unitPath = join(configHome, 'systemd', 'user', SYSTEMD_UNIT);
  const user = userInfo().username;
  return {
    kind: 'systemd',
    describe: () => ({
      kind: 'systemd',
      what: `systemd user service ${SYSTEMD_UNIT}`,
      where: unitPath,
    }),
    async install(spec) {
      writeFile(unitPath, systemdUnit(spec));
      await must(run, 'systemctl', ['--user', 'daemon-reload']);
      await must(run, 'systemctl', ['--user', 'enable', SYSTEMD_UNIT]);
      await must(run, 'systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
      // Without lingering, a user's services stop at logout and wait for a login after a reboot.
      const linger = await run('loginctl', ['show-user', user, '--property=Linger']);
      if (linger.stdout.trim() === 'Linger=yes') return [];
      const enabled = await run('loginctl', ['enable-linger', user]);
      return enabled.code === 0
        ? ['Lingering is on, so it also runs after a restart before you log in.']
        : [
            `It starts when you log in. To keep it running while you are logged out and right after a restart, run once: sudo loginctl enable-linger ${user}`,
          ];
    },
    async uninstall() {
      await run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
      rmSync(unitPath, { force: true });
      await run('systemctl', ['--user', 'daemon-reload']);
    },
    async state() {
      const installed = existsSync(unitPath);
      const active = await run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
      const detail = active.stdout.trim() || 'not installed';
      return { installed, running: detail === 'active', detail: `systemd: ${detail}` };
    },
  };
}

function launchdManager(run: RunCommand): ServiceManager {
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const domain = `gui/${userInfo().uid}`;
  return {
    kind: 'launchd',
    describe: () => ({ kind: 'launchd', what: `launchd agent ${LAUNCHD_LABEL}`, where: plistPath }),
    async install(spec) {
      writeFile(plistPath, launchdPlist(spec));
      // A previous version may be loaded; bootout of nothing fails, which is fine.
      await run('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
      await must(run, 'launchctl', ['bootstrap', domain, plistPath]);
      await must(run, 'launchctl', ['kickstart', '-k', `${domain}/${LAUNCHD_LABEL}`]);
      return [];
    },
    async uninstall() {
      await run('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
      rmSync(plistPath, { force: true });
    },
    async state() {
      const installed = existsSync(plistPath);
      const printed = await run('launchctl', ['print', `${domain}/${LAUNCHD_LABEL}`]);
      const running = printed.code === 0 && /state = running/.test(printed.stdout);
      return {
        installed,
        running,
        detail: `launchd: ${printed.code === 0 ? (running ? 'running' : 'loaded, not running') : 'not loaded'}`,
      };
    },
  };
}

function schtasksManager(run: RunCommand, env: NodeJS.ProcessEnv, dataDir: string): ServiceManager {
  const user = env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : userInfo().username;
  const xmlPath = join(dataDir, 'codea-task.xml');
  return {
    kind: 'schtasks',
    describe: () => ({
      kind: 'schtasks',
      what: `Scheduled Task "${WINDOWS_TASK}" (at logon)`,
      where: `Task Scheduler › ${WINDOWS_TASK}`,
    }),
    async install(spec) {
      // Task Scheduler reads its XML as UTF-16 with a byte-order mark.
      writeFile(
        xmlPath,
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(scheduledTaskXml(spec, user), 'utf16le'),
        ]),
      );
      await run('schtasks', ['/End', '/TN', WINDOWS_TASK]);
      await must(run, 'schtasks', ['/Create', '/TN', WINDOWS_TASK, '/XML', xmlPath, '/F']);
      await must(run, 'schtasks', ['/Run', '/TN', WINDOWS_TASK]);
      rmSync(xmlPath, { force: true });
      return [];
    },
    async uninstall() {
      await run('schtasks', ['/End', '/TN', WINDOWS_TASK]);
      await run('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F']);
    },
    async state() {
      const query = await run('schtasks', ['/Query', '/TN', WINDOWS_TASK, '/FO', 'LIST']);
      const status = /Status:\s*(.+)/.exec(query.stdout)?.[1]?.trim() ?? 'not installed';
      return {
        installed: query.code === 0,
        running: status === 'Running',
        detail: `Task Scheduler: ${status}`,
      };
    },
  };
}

/** A process detached from the session: it outlives it, not a restart. The last resort. */
function detachedManager(pidFile: string, errorLog: string): ServiceManager {
  const pid = (): number | null => {
    try {
      const value = Number(readFileSync(pidFile, 'utf8'));
      if (!Number.isInteger(value) || value <= 0) return null;
      process.kill(value, 0);
      return value;
    } catch {
      return null;
    }
  };
  return {
    kind: 'detached',
    describe: () => ({ kind: 'detached', what: 'a background process', where: pidFile }),
    async install(spec) {
      const running = pid();
      if (running !== null) process.kill(running, 'SIGTERM');
      mkdirSync(dirname(errorLog), { recursive: true });
      const err = openSync(errorLog, 'a');
      const child = spawn(spec.node, [spec.script, 'serve'], {
        cwd: spec.home,
        detached: true,
        stdio: ['ignore', 'ignore', err],
        env: { ...process.env, ...spec.env },
      });
      child.unref();
      closeSync(err);
      return [
        'No per-user service manager is available here, so it runs as a background process: it survives this session but not a restart. On WSL, turn systemd on (`[boot] systemd=true` in /etc/wsl.conf) and run `gemies connect` again to install a service.',
      ];
    },
    async uninstall() {
      const running = pid();
      if (running !== null) process.kill(running, 'SIGTERM');
    },
    async state() {
      const running = pid() !== null;
      return {
        installed: running,
        running,
        detail: `background process: ${running ? 'running' : 'not running'}`,
      };
    },
  };
}

/** The manager this machine has: chosen by platform, and on Linux by whether user systemd answers. */
export async function serviceManagerFor(input: {
  platform: NodeJS.Platform;
  run: RunCommand;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  pidFile: string;
  errorLog: string;
}): Promise<ServiceManager> {
  const { platform, run, env } = input;
  if (platform === 'darwin') return launchdManager(run);
  if (platform === 'win32') return schtasksManager(run, env, input.dataDir);
  const probe = await run('systemctl', ['--user', 'show-environment']).catch(() => null);
  if (probe !== null && probe.code === 0) return systemdManager(run, probe.stdout);
  return detachedManager(input.pidFile, input.errorLog);
}
