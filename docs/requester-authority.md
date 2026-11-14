# Acting for people in Oxy, own tools and external MCP

How an action Alia (or another gemie) takes inside an Oxy product is authorized.
The decisions are [ADR 0022](./adr/0022-first-party-platform-authority.md) and
[Oxy ADR 0066](https://github.com/OxyHQ/oxy/blob/main/docs/adr/0066-first-party-services-act-for-people-without-permissions.md);
Oxy's wire contract is
[first-party-delegation.md](https://github.com/OxyHQ/oxy/blob/main/docs/auth/first-party-delegation.md).
Who the actors are is [Actors](./actors.mdx); how tools are built from catalogues
is [Integrations](./integrations.mdx#oxy-apps).

## Own applications: declared, never asked

Oxy's own services never ask a person for permissions, tasks, grants or
consent. Gemies is first-party as its registered workload (it attests as Alia's
application, `6a2f851751b784a86fd0e934`), and Oxy's first-party registry
declares what it does for people (`actsForPeople`):

- `oxy:files`, write: what a person sends a gemie (a Telegram photo, a voice
  note) is kept as their Oxy file, `oxy.assets.actingFor({ accountId })`.
- `oxy:tools`, write: the person's Oxy apps as catalogue tools. Each call gets
  a two-minute execution authorization,
  `oxy.agency.createFirstPartyExecutionAuthorization(terms, { requesterAccountId })`,
  then a ticket bound to that run.

Nothing else is declared, so Gemies does not read linked accounts, switch
accounts or change privacy or safety for a person. Product-credit funding reads
(`product-access`) are outside this lane and unchanged.

The authorization names accounts and nothing else. `oxy_*` tools act on the
person's own account; `self_*` act on the gemie's bot account with the person
as requester, which Oxy admits only while that person operates it. A stranger on
a public gemie reaches their own apps, never the owner's or the bot's. Oxy
checks the workload, the declaration and every account live on each call; the
product then applies its own rules (ownership, privacy, limits, sensitive
operations). The same call works in the foreground and the background (a
channel turn with no session, a follow-up, a heartbeat, a scheduled task, an
email alert): there is no session, task or proof to keep, renew or revoke.

Structured automations keep their exact scope: a run gets the (resource, tool)
set its declared actions name (plus, on Alia's lane, the read tools of the
owner's apps), each with its step, whether it may repeat and its limits, built
when the run starts and authorized per call. A non-repeatable effect runs once
per stage; idempotency keys and step status are unchanged.

Every use is counted in Oxy (`first_party_delegation_activity`) and shown to the
person in Accounts, Security. Stopping is a product setting, not a permission:
disconnecting a channel, choosing which gemie answers an account, unlinking
Telegram from a gemie bot, the email-alerts switch, deleting a task.

## External applications

External OAuth and MCP clients keep explicit scopes and live grants, and their
authority stays external when they reach own services. Oxy is the central OAuth
authorization server (PKCE S256, exact resource and audience binding, explicit
account selection, refresh rotation, revocation). Each app's MCP stays on its
own product domain; there is no aggregate Oxy MCP. Third-party MCP connectors a
person connects to a gemie are theirs to connect and remove.

External Mention media tools use the separate
`assets.withMcpMediaRequester({ connectionToken, tool, accountId })` facade. It
preserves `social.media.create`, the actual client and grants, and the
connection's current account; it grants neither global Files access nor own
authority. External delegation grants, ceilings and user consent remain where
they apply.

## Changing this surface

A new background use of a person's Oxy data needs its declaration in Oxy's
registry first (oxy `seedOxyApplicationsSpecs.ts`, with its test) and its off
switch in the product in the same change. Depend on released `@oxy.so/*`
packages. `scripts/check-retired-vocabulary.mjs` fails CI when the retired
requester proofs (tasks, requester tokens and contexts, task or foreground
execution authorizations, channel task renewal, reauthorisation) return to any
package's source.
