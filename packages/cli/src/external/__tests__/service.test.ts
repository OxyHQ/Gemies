import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimDaemonSlot,
  daemonHome,
  daemonLogger,
  logSince,
  logSize,
  releaseDaemonSlot,
  runsFromNpxCache,
  stableEntry,
} from '../daemon-home.js';
import {
  launchdPlist,
  scheduledTaskXml,
  serviceManagerFor,
  systemdUnit,
  type CommandResult,
  type RunCommand,
} from '../service.js';

/**
 * The daemon as a per-user service: what each platform's manager is given, and the commands that
 * install, start and remove it. The managers' commands are recorded, never run.
 */
const spec = {
  node: '/usr/bin/node',
  script: '/home/ana/My Tools/codea/dist/index.js',
  env: { PATH: '/home/ana/.local/bin:/usr/bin', XDG_CONFIG_HOME: '/home/ana/.cfg' },
  errorLog: '/home/ana/.local/share/codea/daemon.err.log',
  home: '/home/ana',
};

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'codea-service-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function recorder(answers: Record<string, Partial<CommandResult>> = {}) {
  const calls: string[] = [];
  const run: RunCommand = async (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    const answer = Object.entries(answers).find(([prefix]) => line.startsWith(prefix))?.[1];
    return { code: 0, stdout: '', stderr: '', ...answer };
  };
  return { calls, run };
}

describe('what each manager is given', () => {
  it('systemd: the serve command with paths kept whole, the PATH, restarted on failure, at login', () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/home/ana/My Tools/codea/dist/index.js" serve',
    );
    expect(unit).toContain('Environment="PATH=/home/ana/.local/bin:/usr/bin"');
    expect(unit).toContain('Environment="XDG_CONFIG_HOME=/home/ana/.cfg"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('launchd: run at load, kept alive unless it exits cleanly, escaped', () => {
    const plist = launchdPlist({ ...spec, env: { PATH: '/a&b' } });
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>SuccessfulExit</key><false/>');
    expect(plist).toContain('<string>serve</string>');
    expect(plist).toContain('<key>PATH</key><string>/a&amp;b</string>');
  });

  it('Windows: at this user’s logon, restarted on failure, no time limit, the script quoted', () => {
    const task = scheduledTaskXml(spec, 'DESK\\ana');
    expect(task).toContain('<LogonTrigger><Enabled>true</Enabled><UserId>DESK\\ana</UserId>');
    expect(task).toContain('<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count>');
    expect(task).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(task).toContain(
      '<Arguments>&quot;/home/ana/My Tools/codea/dist/index.js&quot; serve</Arguments>',
    );
  });
});

describe('installing and removing', () => {
  const common = (dir: string) => ({
    dataDir: dir,
    pidFile: join(dir, 'daemon.pid'),
    errorLog: join(dir, 'err.log'),
  });

  it('systemd: writes the unit, enables and restarts it, and turns lingering on', async () => {
    const dir = scratch();
    const { calls, run } = recorder({
      'systemctl --user show-environment': { stdout: `HOME=/home/ana\nXDG_CONFIG_HOME=${dir}\n` },
      'loginctl show-user': { stdout: 'Linger=no\n' },
    });
    const manager = await serviceManagerFor({ platform: 'linux', run, env: {}, ...common(dir) });
    expect(manager.kind).toBe('systemd');
    const notes = await manager.install(spec);
    expect(readFileSync(join(dir, 'systemd/user/codea.service'), 'utf8')).toBe(systemdUnit(spec));
    expect(calls).toEqual(
      expect.arrayContaining([
        'systemctl --user daemon-reload',
        'systemctl --user enable codea.service',
        'systemctl --user restart codea.service',
      ]),
    );
    expect(calls.some((c) => c.startsWith('loginctl enable-linger'))).toBe(true);
    expect(notes.join(' ')).toContain('Lingering is on');

    await manager.uninstall();
    expect(calls).toContain('systemctl --user disable --now codea.service');
    expect(() => readFileSync(join(dir, 'systemd/user/codea.service'))).toThrow();
  });

  it('systemd: says how to keep it running logged out when Linux refuses lingering', async () => {
    const dir = scratch();
    const { run } = recorder({
      'loginctl show-user': { stdout: 'Linger=no' },
      'loginctl enable-linger': { code: 1, stderr: 'denied' },
    });
    const manager = await serviceManagerFor({
      platform: 'linux',
      run,
      env: { XDG_CONFIG_HOME: dir },
      ...common(dir),
    });
    expect((await manager.install(spec)).join(' ')).toContain('sudo loginctl enable-linger');
  });

  it('falls back to a detached process where no user systemd answers, and says it will not survive a restart', async () => {
    const dir = scratch();
    const { run } = recorder({ 'systemctl --user show-environment': { code: 1 } });
    const manager = await serviceManagerFor({ platform: 'linux', run, env: {}, ...common(dir) });
    expect(manager.kind).toBe('detached');
  });

  it('launchd on macOS', async () => {
    const { run } = recorder();
    const manager = await serviceManagerFor({
      platform: 'darwin',
      run,
      env: {},
      ...common(scratch()),
    });
    expect(manager.kind).toBe('launchd');
    expect(manager.describe().where).toMatch(/Library\/LaunchAgents\/so\.oxy\.codea\.plist$/);
  });

  it('Windows: creates the task from its XML, runs it, and deletes it on uninstall', async () => {
    const dir = scratch();
    const { calls, run } = recorder();
    const manager = await serviceManagerFor({
      platform: 'win32',
      run,
      env: { USERDOMAIN: 'DESK', USERNAME: 'ana' },
      ...common(dir),
    });
    await manager.install(spec);
    expect(calls).toEqual(
      expect.arrayContaining([
        `schtasks /Create /TN Codea /XML ${join(dir, 'codea-task.xml')} /F`,
        'schtasks /Run /TN Codea',
      ]),
    );
    await manager.uninstall();
    expect(calls).toContain('schtasks /Delete /TN Codea /F');
  });

  it('fails loudly when the manager refuses', async () => {
    const dir = scratch();
    const { run } = recorder({ 'systemctl --user enable': { code: 1, stderr: 'no bus' } });
    const manager = await serviceManagerFor({
      platform: 'linux',
      run,
      env: { XDG_CONFIG_HOME: dir },
      ...common(dir),
    });
    await expect(manager.install(spec)).rejects.toThrow(/no bus/);
  });
});

describe('the daemon’s home', () => {
  it('lives in each platform’s per-user data folder', () => {
    expect(daemonHome('linux', { XDG_DATA_HOME: '/d' }).log).toBe('/d/codea/daemon.log');
    expect(daemonHome('win32', { LOCALAPPDATA: 'C:/L' }).dataDir).toBe(join('C:/L', 'Codea'));
  });

  it('copies a CLI npx fetched to a place npm will not clean, and uses any other where it is', async () => {
    const { calls, run } = recorder();
    expect(runsFromNpxCache('/home/ana/.npm/_npx/abc/node_modules/@gemies/cli/dist/index.js')).toBe(
      true,
    );
    const entry = await stableEntry({
      script: '/home/ana/.npm/_npx/abc/node_modules/@gemies/cli/dist/index.js',
      version: '4.2.0',
      runtimeDir: '/rt',
      run,
      env: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' },
    });
    expect(entry).toBe(join('/rt', 'node_modules', '@gemies', 'cli', 'dist', 'index.js'));
    expect(calls[0]).toContain('npm-cli.js install --prefix /rt');
    expect(calls[0]).toContain('@gemies/cli@4.2.0');

    const dir = scratch();
    const local = join(dir, 'index.js');
    writeFileSync(local, '');
    expect(
      await stableEntry({ script: local, version: '4.2.0', runtimeDir: '/rt', run }),
    ).toContain('index.js');
    expect(calls).toHaveLength(1);
  });

  it('keeps one daemon per machine', () => {
    const pidFile = join(scratch(), 'daemon.pid');
    expect(claimDaemonSlot(pidFile, process.pid)).toBe(true);
    // A live process holds it: another daemon may not.
    expect(claimDaemonSlot(pidFile, process.pid + 1_000_000)).toBe(false);
    releaseDaemonSlot(pidFile, process.pid);
    expect(claimDaemonSlot(pidFile, 4242)).toBe(true);
  });

  it('logs lines a reader can wait on from an offset', () => {
    const path = join(scratch(), 'daemon.log');
    const log = daemonLogger(path);
    log('first');
    const offset = logSize(path);
    log('Connected: Claude Code · desk');
    expect(logSince(path, offset)).toMatch(/Z Connected: Claude Code · desk\n$/);
    expect(logSince(path, offset)).not.toContain('first');
  });
});
