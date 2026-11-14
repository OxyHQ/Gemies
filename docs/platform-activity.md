# Ecosystem activity

Each deployed API process publishes bounded activity aggregates to Oxy, whether
or not anyone has opened the dashboard. HTTP middleware observes requests and
completed responses, including errors; the shared outgoing observer covers fetch
and Node HTTP clients. Requests and responses have independent directions.
Socket.IO application events and observed raw WebSocket messages are counted
separately from HTTP. Ping/pong frames and Socket.IO acknowledgements are not
application events.

The publisher sends only service identities, infrastructure regions, coarse edge
PoPs, direction, scope, category and aggregate counts. It never sends payloads,
paths, query strings, IPs, user IDs, credentials or socket IDs. A Cloudflare PoP
is a network ingress location, not a visitor's physical location.

Both services (`alia` and `alia-integrations`) start it with `startEcosystemTraffic`
from `@oxy.so/core/server`, with `deployedOnly`. `OXY_ECOSYSTEM_ACTIVITY_ENABLED`
is `true` or `false` (anything else fails at boot) and wins; unset, a process
publishes only on an ECS task, never in a developer shell. Keep it `false` in
local environments, even when using AWS storage.

`AWS_REGION` (else `AWS_DEFAULT_REGION`) supplies the process location; once a
process publishes, a missing region fails at boot. The ECS agent injects both
on every task of `oxy-cluster` (EC2 capacity), so `alia-integrations`, whose task
definition declares neither, has them too (checked on its running task on
2026-11-14); `alia` also declares `AWS_REGION` in oxy-infra.

Publication is authenticated by an Oxy service token, and a deployed task mints
one by attesting its ECS task role rather than from a credential (oxy ADR 0026),
so neither `OXY_SERVICE_API_KEY` nor `OXY_SERVICE_API_SECRET` is set on either
service, and the publisher ignores them if present. A local process that sets
the flag to `true` attests a temporary IAM role through
`createAwsWorkloadCredentialProvider`.

Each process registers a fresh instance, refreshes its lease, and removes it
during graceful shutdown. Crashed instances disappear when their
lease expires. Oxy broadcasts authoritative snapshots over Socket.IO.

Counters describe observed application operations, not network bytes. Direct
object-storage downloads, media transports, database wire protocols and third
party runtime internals require instrumentation at their owning services.

## Static web traffic

The web app's traffic (`alia.onl`) is measured keylessly by Oxy from Cloudflare's own analytics; see OxyHQ/oxy `docs/operations/cloudflare-web-activity.md`. Alia holds no Oxy activity secret and its Worker runs no activity code: it hands the request straight to its `ASSETS` binding. The `OXY_EDGE_ACTIVITY_*` bindings were never provisioned and nothing reads them now; if one is ever found on a deployment, delete it.

## Package versions

Core and contracts are aligned through workspace overrides so browser and server packages share one version. The asset Workers' pass-through check is `node --test scripts/asset-worker.test.mjs`.
