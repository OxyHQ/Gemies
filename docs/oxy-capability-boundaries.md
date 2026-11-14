# Oxy tool account boundaries

[ADR 0022](./adr/0022-first-party-platform-authority.md) replaces the historical
owner-grant/requester-ceiling model for own Oxy products. Use [Actors](./actors.mdx)
and [Agents](./agents.md) as the runtime contract.

- Own backends authenticate through the shared workload SDK. Customer API keys and
  third-party OAuth tokens never become first-party authority through an Oxy backend.
- `oxy_*` always binds the actual requester account. Bot owner, funding account,
  selected agent and resource account remain separate identities.
- `self_*` explicitly selects the agent's own account and requires Oxy's live
  actor/relationship checks. It does not select the owner's Inbox.
- Each operation uses a live catalogue pin and a per-call execution authorization on
  Gemies' declared first-party authority (Oxy ADR 0066), naming the person and the
  account. Products enforce tenant, ownership, membership, entitlements and action policy.
- Background runs and nested agents act for the person the work belongs to; workers
  never persist the person's bearer or reconstruct authority from an owner id.
- External connectors, external OAuth providers and local device permissions keep
  their existing controls. Retiring internal app scopes does not alter them.

Transport tests exercise account-bound tickets over HTTP and MCP, replay behavior,
revocation, unavailable receivers and ambiguous effect results. Database tests cover
run scopes, compensation and idempotency.
