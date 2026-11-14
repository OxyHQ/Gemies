# Alia integrations rollout

The private ECS service has its own PostgreSQL database. The API uses
`http://integrations.alia.internal.oxy.so:3005`, declared by Terraform's
`integrations` service in `alia.internal.oxy.so`.

## Prerequisites

Deploy the Oxy issuer and shared core reader before these consumers. Bind both
`oxy-alia-task` and `oxy-alia-integrations-task` to Alia's registered application,
with explicit deployment environments. Each receiver pins its exact opposite
process and the canonical audience exported by `@gemies/server`. Temporary
workload credentials replace internal scopes and shared gateway/bot passwords.
External connector OAuth and provider webhook signatures remain.

A channel holds no Oxy task (Oxy ADR 0066): the API acts for the person the
verified channel identifies, on Gemies' declared first-party authority. Never
select that person from a bare account ID.

## Configuration

Deploys overlay `INTEGRATIONS_URL` and explicitly remove inherited process secrets.
Phase C no longer has a dependency between the two deployment workflows: both
sides already emit workloads. Before releasing C, verify the phase-B API and
gateway runtime digests, completed task reconciliation and old-task drain. Do not
use C to skip that transition. Terraform alone does not update the running
revision; read back deployed task definitions.

`/oxy/alia-integrations/DATABASE_URL` remains an SSM-owned database credential.
`TOKEN_ENCRYPTION_KEY` remains storage encryption for connector records; rotation
requires a data migration. These are not service authentication. Workflows read
parameter metadata without printing or decrypting values. Retire obsolete SSM
parameters through infra only after both transports are verified live.

## Verification

1. Confirm issuer readiness and both active environment-bound registrations.
2. Confirm both ECS rollouts completed with the intended image digest.
3. Resolve the private Cloud Map address from an API task.
4. Read running task definitions: no Oxy client keys; process secrets remain
   only during B and must disappear in C.
5. Exercise an owned connector and a linked channel; reject an external app,
   another workload, missing context and another account's session.
6. Disconnect the channel; the next private tool call on it must fail.

A health check alone does not prove authentication or account isolation. Roll
back only to an image whose protocol matches its runtime configuration. Never
restore account-header impersonation or remove storage keys to recover.
