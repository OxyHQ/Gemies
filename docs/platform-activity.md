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

Both services start through `startEcosystemTraffic` from `@oxy.so/core/server`. `OXY_ECOSYSTEM_ACTIVITY_ENABLED` is `true` or `false` (anything else fails at boot) and wins; unset, `alia` publishes only on an ECS task (`deployedOnly`) and `alia-integrations` wherever `AWS_REGION` is set. Keep it `false` in local environments, even when using AWS storage. Once publishing, a missing `AWS_REGION` fails at boot.

`AWS_REGION` supplies the process location. Publication is authenticated by an
Oxy service token, and a deployed task mints one by attesting its ECS task role
rather than from a credential (oxy ADR 0026) — so neither
`OXY_SERVICE_API_KEY` nor `OXY_SERVICE_API_SECRET` is set on `alia` or
`alia-integrations`. Both remain the way a local process, which can attest
nothing, publishes at all. Enabled producer configuration is validated before
listening, and what is validated is whether this process can mint a token: the
check used to read the two variables, which would have switched observability
off on exactly the deployments that can authenticate. Each process registers a fresh instance, refreshes its lease,
and removes it during graceful shutdown. Crashed instances disappear when their
lease expires. Oxy broadcasts authoritative snapshots over Socket.IO.

Counters describe observed application operations, not network bytes. Direct
object-storage downloads, media transports, database wire protocols and third
party runtime internals require instrumentation at their owning services.

## Static web traffic

The web app's traffic (`alia.onl`) is measured keylessly by Oxy from Cloudflare's own analytics; see OxyHQ/oxy `docs/operations/cloudflare-web-activity.md`. Alia holds no Oxy activity secret and its Worker runs no activity code: it hands the request straight to its `ASSETS` binding. The `OXY_EDGE_ACTIVITY_*` bindings were never provisioned and nothing reads them now; if one is ever found on a deployment, delete it.

## Package versions

Core and contracts are aligned through workspace overrides so browser and server packages share one version. The asset Workers' pass-through check is `node --test scripts/asset-worker.test.mjs`.
