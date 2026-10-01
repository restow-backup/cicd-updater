# The e2e stub app: one image, its behaviour fixed per release by build arguments, so a
# scenario can publish a version that migrates, never becomes ready, crashes or reports
# a wrong version. Node.js built-ins only; psql for the migrations.
FROM node:24-alpine
RUN apk add --no-cache postgresql17-client
ARG VERSION=0.0.0
# app | edge: the edge image differs from the app image (its own digest)
ARG STUB_ROLE=app
# ok | unready | crash | wrong-version
ARG STUB_HEALTH=ok
# none, or the migration this version applies (a number)
ARG STUB_MIGRATION=none
# 1: the migration exits 1 before it changes anything
ARG STUB_MIGRATE_FAIL=0
# 1: the server applies its migration when it starts (no separate migrate hook)
ARG STUB_MIGRATE_ON_START=0
# MiB of random data in an extra layer (a pull that takes a while); unique per version
ARG STUB_PAD_MB=0
RUN if [ "$STUB_PAD_MB" -gt 0 ]; then \
      mkdir -p /pad && echo "$VERSION" > /pad/version && \
      dd if=/dev/urandom of=/pad/data bs=1048576 count="$STUB_PAD_MB" 2> /dev/null; \
    fi
ENV STUB_VERSION=${VERSION} \
    STUB_ROLE=${STUB_ROLE} \
    STUB_HEALTH=${STUB_HEALTH} \
    STUB_MIGRATION=${STUB_MIGRATION} \
    STUB_MIGRATE_FAIL=${STUB_MIGRATE_FAIL} \
    STUB_MIGRATE_ON_START=${STUB_MIGRATE_ON_START}
WORKDIR /app
COPY server.mjs migrate.mjs ./
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
