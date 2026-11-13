#!/usr/bin/env bash
# Smoke both GemiesOS images (packages/gemies-os/Dockerfile).
#
# The control API image (HOST_IMAGE) boots with the SAME hardening the systemd
# unit in oxy-infra (`terraform-uswest2/files/gemies-os-userdata.sh`) applies —
# read-only root filesystem, a 16 MB noexec /tmp, every capability dropped,
# no-new-privileges, 256 pids, 512 MB — against a throwaway Postgres, and fails
# unless the image's runtime (Bun as PID 1, the image's own CMD) can:
#   1. refuse a production boot without DATABASE_URL with a NON-ZERO exit,
#   2. create its store and answer /health with 200 and the ops drain on 8081
#      with no Docker socket mounted (the browser reset's `docker` call fails
#      and is logged, which is the spawn path working, not the engine),
#   3. run as Bun at PID 1, so the unit's `docker stop` SIGTERM reaches it,
#   4. exit 0 on that SIGTERM within the unit's 15 s.
# The workspace image (WORKSPACE_IMAGE) must:
#   5. load the bundled browser worker and egress proxy under its own Node, as
#      uid 1000, with playwright-core beside them and files.py in place.
# A unit suite cannot see any of these: they are properties of the images.
set -euo pipefail

: "${HOST_IMAGE:?HOST_IMAGE required}"
: "${WORKSPACE_IMAGE:?WORKSPACE_IMAGE required}"
: "${DATABASE_URL:?DATABASE_URL required (a throwaway database)}"
NAME="gemies-os-smoke-$$"

HARDENING=(
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m
  --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 256 --memory 512m
  --network host
)
CONFIG=(
  -e GEMIES_OS_IMAGE="oxy/gemies-os-workspace@sha256:$(printf '0%.0s' $(seq 64))"
  -e GEMIES_OS_ALLOWED_ROLE_ARNS=arn:aws:iam::123456789012:role/oxy-alia-task
  -e GEMIES_OS_DEPLOYMENT_ID=ci-smoke
)

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# 1. A refused boot must exit non-zero.
refused_log=$(mktemp)
set +e
timeout 60 docker run --rm "${HARDENING[@]}" "${CONFIG[@]}" "$HOST_IMAGE" >"$refused_log" 2>&1
refused=$?
set -e
if [ "$refused" = 0 ] || [ "$refused" = 124 ]; then
  cat "$refused_log" || true
  echo "::error::a production boot without DATABASE_URL exited $refused; it must exit non-zero, promptly"
  exit 1
fi
echo "Refused boot exited $refused."

# 2. The control API, from the image's own CMD.
docker run -d --name "$NAME" "${HARDENING[@]}" "${CONFIG[@]}" -e DATABASE_URL "$HOST_IMAGE" >/dev/null

ready=
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
    ready=1
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  docker logs "$NAME" || true
  echo "::error::the GemiesOS image never answered /health"
  exit 1
fi
# No Docker socket is mounted, so the drain cannot inspect the engine and
# answers 503 `{"data":{"stop":false}}` — "any doubt is do not stop", which is
# the contract. What is asserted is that the ops listener answers it.
drain=$(curl -sS --max-time 10 -X POST http://127.0.0.1:8081/idle/drain)
if ! jq -e '.data.stop | type == "boolean"' <<<"$drain" >/dev/null; then
  echo "::error::the ops drain answered '$drain'"
  exit 1
fi

# 3. PID 1 must be Bun running the control API.
pid1=$(docker exec "$NAME" cat /proc/1/cmdline | tr '\0' ' ')
case "$pid1" in
  "bun packages/gemies-os/dist/index.js "*) ;;
  *)
    echo "::error::PID 1 is '$pid1', expected 'bun packages/gemies-os/dist/index.js'"
    exit 1
    ;;
esac

# 4. The unit stops it with `docker stop --time 15`.
docker stop -t 15 "$NAME" >/dev/null
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
if [ "$exit_code" != 0 ]; then
  docker logs "$NAME" 2>&1 || true
  echo "::error::SIGTERM did not end in exit 0 (exit code $exit_code)"
  exit 1
fi

# 5. The workspace image: what browser-isolation.ts starts, as it starts it.
docker run --rm --entrypoint /usr/local/bin/node "$WORKSPACE_IMAGE" --input-type=module -e "
  import { execFileSync } from 'node:child_process';
  import { access } from 'node:fs/promises';
  await access('/opt/gemies-os/files.py');
  await import('/opt/gemies-os/browser/node_modules/playwright-core/index.mjs');
  for (const entry of ['worker-main.js', 'egress-main.js']) {
    execFileSync('/usr/local/bin/node', ['--check', '/opt/gemies-os/browser/' + entry]);
  }
  if (process.getuid() !== 1000) throw new Error('runs as uid ' + process.getuid());
"
echo "Workspace image: worker and egress bundles parse under Node, playwright-core resolves, files.py present, uid 1000."

echo "GemiesOS image smoke passed: refused boot non-zero, /health + ops drain under the unit's hardening, PID 1 = Bun, SIGTERM exit 0, workspace image loads"
