#!/usr/bin/env node
// Serve a coding-agent CLI to Gemies as one of the person's gemies (Gemies ADR 0030, 0038, 0043).
// No sign-in: the pairing code is the authorisation. The daemon runs as a per-user service.
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { connect, disconnect, serve, status } from './connect.js';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('gemies')
  .description('Gemies on your computer: connect Claude Code, Codex or OpenCode to Gemies')
  .version(VERSION);

program
  .command('connect [code]')
  .description(
    'Connect Claude Code, Codex or OpenCode to Gemies as one of your gemies, and keep it connected as a background service that starts at login. With a code from Gemies (Settings → Connect external Gemie) it pairs this machine; without one it reinstalls the service for the agents already paired here.',
  )
  .option('--cli <cli>', 'Which CLI this machine serves: claude, codex or opencode')
  .option('--agent <id>', 'With --cwd or --read-only and no code: change only this paired agent')
  .option('--cwd <dir>', 'Working directory the agent runs in (default: the current one)')
  .option(
    '--read-only',
    'Do not let the agent change anything (default: it may edit files in the working directory)',
  )
  .action(async (code: string | undefined, options) => {
    await connect(code, options, VERSION);
  });

program
  .command('status')
  .description('Show the background service, the agents it serves and its last log lines')
  .action(async () => {
    await status();
  });

program
  .command('disconnect')
  .description('Stop and remove the background service')
  .option('--forget', 'Also forget the agents paired on this machine and their credentials')
  .action(async (options) => {
    await disconnect(options);
  });

// What the service runs; not meant to be typed.
program
  .command('serve', { hidden: true })
  .description('Serve every agent paired on this machine (run by the background service)')
  .action(async () => {
    await serve();
  });

program.parse();
