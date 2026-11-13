# ============================================
# Alia Integrations — Production Dockerfile
# ============================================
# Unified service: messaging gateways + bots + browser + terminal
# Includes: Node.js, Chromium (Playwright)

# Base images are pinned by DIGEST: the digest is what the build pulls, and the
# tag is only for readers (BuildKit ignores it when a digest is present). A bump
# needs the new tag's multi-arch index digest (linux/arm64 included), then a
# re-pin of `alia-integrations` in .github/scripts/reviewed-images.json, which is
# the owner's review of the new base. `node:22-bookworm-slim` appears twice
# (toolchain and runtime) and both must move together: native modules are built
# in one and loaded in the other.

# Bun 1.4.3 (the root package.json's "packageManager"), from the official image
# by digest. A named stage, so scripts/check-bun-pin.mjs reads its tag and holds
# it to the pin; the toolchain below copies only the binary out of it.
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS bun

# --- Toolchain: bun + the compilers native modules (node-pty) build with ---
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS toolchain

# Install build tools for native modules (node-pty requires python3 + make + g++).
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl unzip git && \
    rm -rf /var/lib/apt/lists/*

# Bun, from the `bun` stage above rather than `curl https://bun.com/install |
# bash`, which installed whatever release was latest on the day of the build.
# Bun is used only to install and build here; it never reaches the runtime.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# Rewrite git+ssh:// to git+https:// so cloning works without SSH keys
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# --- Stage 1: Builder ---
FROM toolchain AS builder

WORKDIR /build

# Copy root workspace files
COPY package.json bun.lock ./
COPY packages/api/package.json ./packages/api/
COPY packages/app/package.json ./packages/app/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/server/package.json ./packages/server/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/gemies-os/package.json ./packages/gemies-os/
COPY packages/gemies-os-protocol/package.json ./packages/gemies-os-protocol/

# Install all dependencies (including devDependencies for build), exactly as
# bun.lock records them. Matches packages/api/Dockerfile.
RUN bun install --frozen-lockfile --filter @alia/integrations

# Copy source
COPY packages/server/ ./packages/server/
RUN cd packages/server && bun run build
COPY packages/integrations/ ./packages/integrations/

# Build TypeScript
RUN bun run --filter @alia/integrations build

# --- Production dependencies only ---
FROM toolchain AS production-deps

# Same install environment the runtime stage used to give this install.
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Copy root workspace files
COPY package.json bun.lock ./
COPY packages/api/package.json ./packages/api/
COPY packages/app/package.json ./packages/app/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/server/package.json ./packages/server/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/gemies-os/package.json ./packages/gemies-os/
COPY packages/gemies-os-protocol/package.json ./packages/gemies-os-protocol/

# Install production dependencies only, and no peers: in this workspace the app resolves React
# Native, Expo and the rest of Bloom's app peers, and a filtered install would bring every peer the
# lockfile resolved (about 800 MB). What integrations needs is its own dependency — Bloom's
# server-safe `agent-avatar/svg` imports none of them, and Baileys' peer `sharp` is listed.
RUN bun install --production --frozen-lockfile --filter @alia/integrations --omit=peer

# node-pty has no linux prebuild, so its `install` script compiles it with
# node-gyp — and bun never runs that script here: the root `trustedDependencies`
# names a package, which REPLACES bun's default trust list rather than extending
# it, so node-pty landed with no `build/Release/pty.node` and
# `import('node-pty')` threw in every container. The build is run explicitly,
# on this stage's Debian/glibc and Node (the runtime's own base), with the
# node-gyp npm bundles; `post-install.js` then prunes the object files so only
# `pty.node` ships. Trusting node-pty in package.json instead would make every
# Linux `bun install` (CI, developers) need node-gyp on PATH.
RUN cd "$(dirname "$(node -p "require.resolve('node-pty/package.json', { paths: ['/app/packages/integrations'] })")")" && \
    node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild && \
    node scripts/post-install.js && \
    rm -rf /root/.cache/node-gyp && \
    cd /app/packages/integrations && node -e "require('node-pty')"

# --- Stage 2: Production Runtime ---
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime

# Install system dependencies:
# - curl: health checks
# - chromium: Playwright browser automation
# Nothing is compiled or installed with bun here: node_modules (with node-pty's
# native build) comes from `production-deps`.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl \
      chromium \
      ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Tell Playwright to use system Chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# The unprivileged "node" user owns /app and everything copied into it. Each
# COPY below sets the owner itself: a trailing `chown -R` over the installed
# tree rewrote every file into a second layer and shipped node_modules twice,
# which every Fargate task pulled on every rollout.
RUN chown node:node /app

# Production dependencies and the workspace manifests, built in `production-deps`
# on this same Debian/glibc base so native modules match.
COPY --from=production-deps --chown=node:node /app/ ./

# Copy built output from builder
COPY --from=builder --chown=node:node /build/packages/integrations/dist ./packages/integrations/dist
COPY --from=builder --chown=node:node /build/packages/server/dist ./packages/server/dist

# The migrations, which are DATA and are therefore not in `dist`.
#
# `src/db/migrate.ts` resolves them as `join(__dirname, '..', '..', 'drizzle')`,
# which from `dist/db/` is `/app/packages/integrations/drizzle` — a path that did
# not exist in this image. Nothing noticed because nothing had ever run the
# migrator from a container: `drizzle-kit` is a devDependency and cannot be
# reached from here, and `db:migrate` is a `bun` script run against a developer's
# own checkout.
#
# It fails loudly rather than silently — @oxy.so/db's `readJournal` throws naming
# the missing path — but it fails at the one-shot migration task, i.e. after a
# full ARM64 build, on the step whose whole job is to run before the rollout.
#
# `packages/api/Dockerfile:116` is the control: it has always copied its own
# `drizzle` directory, for exactly this reason.
COPY --from=builder --chown=node:node /build/packages/integrations/drizzle ./packages/integrations/drizzle

# Fail the build rather than the feature if the pty binding cannot load.
# node-pty is resolved from the package, as `dist/` resolves it: the image's
# install uses bun's isolated linker (bunfig.toml is not in the build context),
# so /app/node_modules has no top-level node-pty.
RUN cd packages/integrations && node -e "require('node-pty')"

# Security: run as non-root
USER node

ENV NODE_ENV=production
EXPOSE 3005

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3005/health || exit 1

CMD ["node", "packages/integrations/dist/index.js"]
