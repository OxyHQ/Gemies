# ============================================
# GemiesOS — its two images, from one builder
# ============================================
# Built from the REPOSITORY ROOT, linux/arm64 for the Graviton host, one target
# per image (`deploy-gemies-os.yml` pushes both, CI builds both):
#
#   docker build -f packages/gemies-os/Dockerfile --target host .        oxy/gemies-os
#   docker build -f packages/gemies-os/Dockerfile --target workspace .   oxy/gemies-os-workspace
#
# `host` is the control API: it drives the instance's Docker engine through the
# socket the systemd unit mounts and never runs an actor's code itself.
# `workspace` is the image every actor's computer runs — node, python3, git and
# bash, nothing that listens, uid 1000 with `/workspace` as its only writable
# mount — and, with another entrypoint, the gemies' browser and its egress proxy.
#
# Both start from the same install of this workspace (`@gemies/os` and its wire
# contract `@gemies/os-protocol`), so a dependency is resolved once, at the
# lockfile's version, for both. As in packages/api/Dockerfile, every workspace
# manifest is copied: bun reads all of them before it resolves anything.

ARG BUN_VERSION=1.4.3

FROM oven/bun:${BUN_VERSION}-slim AS builder
WORKDIR /build
COPY package.json bun.lock bunfig.toml ./
COPY packages/api/package.json ./packages/api/
COPY packages/app/package.json ./packages/app/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/server/package.json ./packages/server/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/gemies-os/package.json ./packages/gemies-os/
COPY packages/gemies-os-protocol/package.json ./packages/gemies-os-protocol/
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1
RUN bun install --frozen-lockfile --filter "@gemies/os"
COPY packages/gemies-os-protocol/ ./packages/gemies-os-protocol/
COPY packages/gemies-os/ ./packages/gemies-os/
# The control API, compiled as it runs under Bun. The wire contract is not
# compiled: it is TypeScript that Bun loads as-is.
RUN cd packages/gemies-os && ../../node_modules/.bin/tsc -p tsconfig.build.json
# The browser worker and the egress proxy run under Node in the workspace
# image, so they are bundled — the wire contract and zod included — and only
# playwright-core, which ships its own CLI and browser registry, stays outside.
RUN cd packages/gemies-os && bun build --target=node --format=esm --external playwright-core \
      src/browser/worker-main.ts src/browser/egress-main.ts --outdir /build/browser

# Only the Docker CLI binary, from Docker's own image.
FROM docker:27-cli AS docker-cli

# ── host: the control API ──────────────────────────────────────────────────
# Runtime: Bun, on the builder's own image (the exact Bun and libc the
# dependencies were installed against). This process uses express, pino,
# postgres and `child_process.spawn('docker', …)`; it never loads
# playwright-core. Rolling back to Node is reverting the change that made the
# switch: no command outside this file names the runtime, the systemd unit in
# oxy-infra (`gemies-os-userdata.sh`) runs the image's own CMD.
FROM oven/bun:${BUN_VERSION}-slim AS host
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages/gemies-os-protocol/package.json ./packages/gemies-os-protocol/package.json
COPY --from=builder /build/packages/gemies-os-protocol/src ./packages/gemies-os-protocol/src
COPY --from=builder /build/packages/gemies-os/package.json ./packages/gemies-os/package.json
COPY --from=builder /build/packages/gemies-os/dist ./packages/gemies-os/dist
COPY packages/gemies-os/NOTICE ./packages/gemies-os/NOTICE

# Runs as root inside the container ONLY to reach the mounted Docker socket,
# whose group id differs per host; the systemd unit runs it with a read-only
# root filesystem, no added capabilities and no published port beyond 8080.
# Stated rather than inherited, so it does not depend on the base image's default.
USER root
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1
# The image's entrypoint execs this, so Bun is PID 1 and receives the SIGTERM
# of the unit's `docker stop --time 15`. The `node` the base image puts on PATH
# is a symlink to bun: there is no Node in this image.
CMD ["bun", "packages/gemies-os/dist/index.js"]

# ── workspace: every actor's computer, and the browser ─────────────────────
# Adapted from OpenMuse `apps/computer/Dockerfile` and `apps/worker/Dockerfile`
# (MIT, see NOTICE). It stays on Node: `node` is part of what an agent is
# given, and browser-isolation.ts starts the worker as /usr/local/bin/node.
#
# ONE image for the shell and the browser, on purpose: it is the image pinned
# by digest in SSM and pulled by the host at every start. The cost is ~300 MB of
# Chromium on disk in the shell, where it is inert: the shell has no network,
# and nothing in it starts a browser unless the agent does so itself.
#
# The host refuses to attach to a container whose image is not EXACTLY the
# reference it was configured with (`GEMIES_OS_IMAGE`), so a rebuilt image
# takes effect only for containers created after the host is told about it.
# The default entrypoint is `sleep infinity`: a computer does nothing on its
# own; every process in it is a `docker exec` the host started, under `timeout`.
FROM node:22-bookworm-slim AS workspace

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash python3 git coreutils ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/gemies-os/browser/node_modules /workspace \
    && chown 1000:1000 /workspace

# The bundled worker and proxy, and their one external dependency at the
# lockfile's version.
COPY --from=builder /build/node_modules/playwright-core /opt/gemies-os/browser/node_modules/playwright-core
COPY --from=builder /build/browser /opt/gemies-os/browser
RUN echo '{"type":"module","private":true}' > /opt/gemies-os/browser/package.json

# Chromium's headless shell (no full browser, no Firefox/WebKit) and the system
# libraries and fonts it needs. PLAYWRIGHT_BROWSERS_PATH is set only for this
# step and in the browser container's environment — not in the image's, which
# every computer's isolation check reads (`isolation.ts` ALLOWED_ENV).
RUN PLAYWRIGHT_BROWSERS_PATH=/opt/gemies-os/ms-playwright \
      node /opt/gemies-os/browser/node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /tmp/* \
    && chmod -R a+rX /opt/gemies-os/ms-playwright /opt/gemies-os/browser

COPY packages/gemies-os/workspace-image/files.py /opt/gemies-os/files.py
RUN chmod 0555 /opt/gemies-os/files.py

# No VOLUME: a computer always mounts its own workspace volume at /workspace,
# and a declared volume would give the browser containers an anonymous one.
ENV HOME=/workspace LANG=C.UTF-8
WORKDIR /workspace
USER 1000:1000
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
