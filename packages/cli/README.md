# @gemies/cli

Gemies on your computer. `gemies connect <code> --cli claude|codex|opencode` pairs this machine and
keeps Claude Code, Codex or OpenCode connected to Gemies as one of your gemies, as a per-user
background service that starts at login. Nothing listens on the machine: the daemon dials Gemies and
drives the CLI you are already signed in to.

```bash
gemies connect AB12-CD34-EF56-GH78 --cli claude   # pair and install the service
gemies status                                     # the service, the agents, the last log lines
gemies disconnect [--forget]                      # stop and remove the service
```

Decisions: [ADR 0030](../../docs/adr/0030-external-agents.md),
[0038](../../docs/adr/0038-external-agents-connect-with-their-own-credential.md),
[0043](../../docs/adr/0043-external-agents-are-machines-with-sessions.md).

It keeps the on-disk names the Codea CLI used (`codea` data directory, `codea.service`,
`alia-codea-cli` settings) so a machine paired with `codea connect` carries over without pairing again.
