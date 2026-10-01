#!/bin/sh
# The cicd-updater command inside the image (docker compose exec updater cicd-updater doctor).
exec node /opt/cicd-updater/cicd-updater.mjs "$@"
