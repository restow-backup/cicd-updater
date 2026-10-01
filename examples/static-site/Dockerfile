# The site image: nginx (unprivileged, port 8080) with the static files and a
# version.json the updater's health check reads.
FROM nginxinc/nginx-unprivileged:1.29-alpine
ARG VERSION=0.0.0-dev
# The base image runs as nginx (uid 101); the files are written as root and only read.
USER root
COPY site/ /usr/share/nginx/html/
RUN printf '{"version":"%s"}\n' "${VERSION#v}" > /usr/share/nginx/html/version.json
USER 101
EXPOSE 8080
