# The app image (api and worker). Node.js 24 runs the TypeScript sources directly
# (type stripping); there is no compile step.
FROM node:24-alpine AS deps
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine
ARG VERSION=0.0.0-dev
ENV NODE_ENV=production \
    APP_VERSION=${VERSION}
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY app/package.json ./
COPY app/src src
COPY app/migrations migrations
USER node
EXPOSE 3000
CMD ["node", "src/server.ts"]
