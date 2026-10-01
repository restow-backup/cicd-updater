# syntax=docker/dockerfile:1.7
#
# The cicd-updater sidecar image: ghcr.io/restow-backup/cicd-updater:<X.Y.Z>
#
#   build    -> installs the workspace and bundles the sidecar (packages/sidecar,
#               tsup) into one ES module with every dependency inside; runs as
#               the unprivileged node user
#   tools    -> the Docker CLI with its buildx and compose plugins, and cosign,
#               taken from their official images pinned by digest (the digest is
#               the integrity check; Dependabot proposes updates)
#   runtime  -> Node.js 24 LTS on Alpine, the bundle, the tools, age and tini
#               from Alpine's signed packages, and the licence texts
#
# Build from the repository root:
#   docker buildx build -f docker/Dockerfile --build-arg VERSION=1.0.0 .
#
# The runtime runs as root on purpose: it holds the Docker socket, which is root
# on the host anyway, and it must replace the project's env file with its
# original owner and mode (docs/security.md). The build stage runs unprivileged.

# The images are written out in the FROM lines (not as ARGs) so Dependabot can
# propose updates of tag and digest together; the two Node.js lines move together.

########################################
# build: the bundled sidecar
########################################
FROM --platform=$BUILDPLATFORM node:24.21-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
ENV CI=true
# The pnpm version of package.json (packageManager).
RUN npm install --global pnpm@9.15.9 && pnpm --version
USER node
WORKDIR /home/node/src
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node packages/protocol/package.json packages/protocol/
COPY --chown=node:node packages/feed/package.json packages/feed/
COPY --chown=node:node packages/engine/package.json packages/engine/
COPY --chown=node:node packages/sidecar/package.json packages/sidecar/
COPY --chown=node:node packages/release-tools/package.json packages/release-tools/
COPY --chown=node:node packages/sdk/package.json packages/sdk/
RUN --mount=type=cache,id=cicd-updater-pnpm,target=/home/node/.local/share/pnpm/store,uid=1000,gid=1000 \
    pnpm install --frozen-lockfile
COPY --chown=node:node tsconfig.base.json ./
COPY --chown=node:node packages/ packages/
RUN pnpm --filter @cicd-updater/sidecar build \
    && node packages/sidecar/dist/cicd-updater.mjs --help > /dev/null

########################################
# tools: Docker CLI, buildx, compose and cosign, pinned by image digest
########################################
FROM docker:29.8.2-cli@sha256:b1805116a6a86cc591b5d5f60a910a0715cdcc9d18d866ad68b1457ead25c35c AS docker-cli
FROM ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8 AS cosign

########################################
# runtime
########################################
FROM node:24.21-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
ARG VERSION=0.0.0-dev
ARG REVISION=
ARG CREATED=
LABEL org.opencontainers.image.title="cicd-updater" \
      org.opencontainers.image.description="Signed, self-service updates for apps run with Docker Compose: the update sidecar and the release CLI." \
      org.opencontainers.image.source="https://github.com/restow-backup/cicd-updater" \
      org.opencontainers.image.url="https://github.com/restow-backup/cicd-updater" \
      org.opencontainers.image.documentation="https://github.com/restow-backup/cicd-updater/tree/main/docs" \
      org.opencontainers.image.vendor="IT Systeme Flores UG (haftungsbeschränkt)" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

# age encrypts backups and tini reaps orphaned children. Volume archives are
# written and read with BusyBox tar of the base system (the volume backup runs
# this image with --entrypoint tar). npm, npx, corepack and yarn are not needed.
RUN apk add --no-cache age tini ca-certificates \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=cosign /ko-app/cosign /usr/local/bin/cosign

COPY --from=build /home/node/src/packages/sidecar/dist/cicd-updater.mjs /opt/cicd-updater/cicd-updater.mjs
COPY LICENSE NOTICE THIRD_PARTY_NOTICES /usr/share/doc/cicd-updater/
COPY --chmod=0755 docker/cicd-updater.sh /usr/local/bin/cicd-updater

# Fail the build when a tool is missing or does not run on this platform.
RUN cicd-updater version \
    && docker --version \
    && docker buildx version \
    && docker compose version \
    && cosign version > /dev/null \
    && age --version \
    && command -v tar > /dev/null

ENV NODE_ENV=production
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["cicd-updater", "healthcheck"]
ENTRYPOINT ["/sbin/tini", "--", "node", "/opt/cicd-updater/cicd-updater.mjs"]
CMD ["serve"]
