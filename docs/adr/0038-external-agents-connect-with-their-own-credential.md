# 38. An external agent connects with its own credential; the pairing code is the authorisation

Status: Accepted (2026-11-13, the owner's decision: connecting an external agent is pasting one text
into it, and the agent never asks to sign in to Oxy — "no tiene sentido si se supone que ya le pasamos
el código"). Supersedes the Oxy session of the daemon in [ADR 0030](./0030-external-agents.md) §4 and
§5.
Date: 2026-11-13.

## Context

Pairing a CLI (ADR 0030) took two sign-ins for one intent. The person, signed in to Gemies, minted a
code; then the daemon on their machine signed in to Oxy by the device flow, printed a link, and waited
for the person to approve it, because `POST /agents/external/redeem` and `/ws/external-agent` both
took the person's Oxy session. The agent pasted the text, showed the person a sign-in link, and
waited: the code had already said who the person was, and the second sign-in added nothing but a
step.

It also gave the daemon more than it needed. The relay took the person's whole Oxy session, the scope
`codea login` holds, to run one agent; a narrower scope did not exist (ADR 0030, Consequences).
Since ADR 0036 an external agent has no Oxy account, so nothing about it is Oxy's to authenticate.

## Decision

1. **The code is the authorisation.** A signed-in person mints it (`POST /agents/external/pair`,
   Oxy session), so it is bound to them on our side: its row names the owner. It is single-use,
   lives 10 minutes, is `XXXX-XXXX-XXXX-XXXX` (~79 bits from a CSPRNG) and only its SHA-256 is
   stored. `POST /agents/external/redeem` takes **no session**: the code's row, not the caller, says
   which account the redemption acts for, and consuming it is one conditional `UPDATE`.
2. **Redeeming returns the agent's own credential**, `gxa_` + 32 random bytes, once. The link stores
   its SHA-256 (`external_agent_links.credential_hash`). The credential opens `/ws/external-agent`
   for that one agent and nothing else: no HTTP route reads it, it is not an Oxy session, and it
   does not expire while the agent exists. The relay compares hashes in constant time.
3. **The daemon keeps it and nothing else.** Codea stores it beside the agent it serves, in a file
   readable by its owner only (0600), and presents it on every connection: a restart reconnects
   with no sign-in. `codea connect` asks for no Oxy session, and has no device flow.
4. **Revoking kills it.** `DELETE /agents/external/:agentId` revokes the link, which is the only
   place the credential is checked, disconnects the daemon and deletes the agent (ADR 0032).
5. **Reconnecting replaces it.** A code minted for an existing agent (`pair` with `{ agentId }`,
   only for a live external agent of the caller's) carries `external_agent_pairings.agent_id`;
   redeeming it points the link at the new machine (CLI, computer, credential) instead of creating a
   gemie, and cuts off any socket opened with another credential, on whichever instance holds it.
   Its daemon is refused with `invalid_credential` on reconnecting and stops without forgetting
   anything another daemon on the same machine has since stored. The app offers it as
   **Reconnect** on each connected agent: a new machine, a lost credential, a suspected leak.
6. **Redemption is rate limited and logged.** Ten attempts a minute per address, used codes or not
   (`checkWindowLimit`, a Redis outage degrades to a per-instance limit); five codes a minute per
   account. Each redemption is logged with the agent, the owner, the CLI, the computer and the
   address; each refusal with the address. Consuming the code and creating the agent and its link
   happen in one transaction, so our failure does not burn the person's code.
7. **The pasted text is self-sufficient**: one command,
   `npx -y @alia-codea/cli@latest connect <code> --cli <claude|codex|opencode>`, how to keep it
   running, what to report and when to stop. It says no sign-in is needed.

## Migration

A link paired before this has no credential. Until it is reconnected, the relay still lets its
owner's Oxy session open it (`token` in the `auth` frame, Codea 3.x); a link that has a credential
never takes a session. The daemons already running keep working through the deploy. The owner
reconnects the agent from Settings (**Reconnect**), which issues it a credential and closes the lane
for it.

**Removal:** when production holds no live link with a null `credential_hash`
(`SELECT count(*) FROM external_agent_links WHERE revoked_at IS NULL AND credential_hash IS NULL`
is 0), the lane goes: `opensLink` keeps only the credential, `DaemonFrame`'s `token` goes, and so
does `authenticateSocketToken`, which nothing else uses.

## Consequences

- A leaked code is useless once used or after 10 minutes. A leaked credential runs that one agent's
  connection: whoever holds it receives the turns meant for the agent until the owner reconnects
  or removes it. That is the same blast radius the daemon's machine already had, and much smaller
  than the Oxy session it replaces.
- The machine needs no account, so a person can connect a CLI on a computer they never signed in to
  Oxy on.
- Turns, presence and the relay's cross-instance routing (ADR 0031) are unchanged.
