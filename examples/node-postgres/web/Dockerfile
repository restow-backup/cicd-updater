# The edge image: Caddy with the admin page. Built from the example directory:
#   docker buildx build -f web/Dockerfile .
FROM node:24-alpine AS assets
WORKDIR /build
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/src/web src/web
RUN npm run build:web

FROM caddy:2-alpine
COPY web/Caddyfile /etc/caddy/Caddyfile
COPY web/public /srv/public
COPY --from=assets /build/dist/admin.js /srv/public/admin.js
EXPOSE 8080
