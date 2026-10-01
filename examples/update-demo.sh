#!/usr/bin/env bash
# update-demo.sh <example directory> [up|down]
#
# A demo of the update mechanics on one machine, NOT a production setup: it builds
# two versions (1.0.0 and 1.1.0) of the example's images, pushes them to a local
# registry, writes unsigned release.json documents into a file feed, starts 1.0.0
# with the sidecar in trust mode none (acknowledgeUnsigned) and lets the sidecar
# update it to 1.1.0. Nothing is signed; never use trust mode none like this in
# production (docs/trust-modes.md).
#
# Needs Docker with Compose v2. The example's demo/demo.env names its images:
#   DEMO_PROJECT=notes
#   DEMO_IMAGES="app:APP_IMAGE:app/Dockerfile web:WEB_IMAGE:web/Dockerfile"
set -euo pipefail

example="${1:?usage: update-demo.sh <example directory> [up|down]}"
action="${2:-up}"
cd "$example"
# shellcheck source=/dev/null
. ./demo/demo.env

registry="127.0.0.1:5000"
updater_image="${CICD_UPDATER_IMAGE:-ghcr.io/restow-backup/cicd-updater:1.0.0}"
feed="$PWD/demo/feed"
compose=(docker compose --env-file .env -f docker-compose.yml -f demo/docker-compose.demo.yml --profile updater)

if [ "$action" = down ]; then
  "${compose[@]}" down --volumes --remove-orphans || true
  docker rm -f cicd-updater-demo-registry > /dev/null 2>&1 || true
  rm -rf "$feed" .env
  exit 0
fi

if [ -e .env ]; then
  echo "update-demo: .env exists; the demo writes its own. Move it away or run: make demo-down" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64 | amd64) platform=linux/amd64 ;;
  aarch64 | arm64) platform=linux/arm64 ;;
  *) echo "update-demo: unsupported machine $(uname -m)" >&2; exit 1 ;;
esac

if ! docker inspect cicd-updater-demo-registry > /dev/null 2>&1; then
  docker run -d --name cicd-updater-demo-registry -p 127.0.0.1:5000:5000 registry:3 > /dev/null
fi

mkdir -p "$feed"
first_refs="$feed/first-refs.env"
: > "$first_refs"

build_version() {
  local version="$1" images="{" separator=""
  for spec in $DEMO_IMAGES; do
    local key="${spec%%:*}" rest="${spec#*:}"
    local var="${rest%%:*}" file="${rest#*:}"
    local repository="$registry/$DEMO_PROJECT-$key"
    docker build --quiet -f "$file" --build-arg "VERSION=$version" \
      --label "org.opencontainers.image.version=$version" -t "$repository:$version" . > /dev/null
    docker push --quiet "$repository:$version" > /dev/null
    local digest
    digest="$(docker image inspect "$repository:$version" --format '{{range .RepoDigests}}{{println .}}{{end}}' | sed -n "s|^$repository@||p" | head -n 1)"
    images="$images$separator\"$key\": {\"repository\": \"$repository\", \"tag\": \"$version\", \"digest\": \"$digest\", \"platforms\": [\"$platform\"]}"
    separator=", "
    if [ "$version" = 1.0.0 ]; then
      echo "$var=$repository:$version@$digest" >> "$first_refs"
    fi
    echo "built $repository:$version@$digest"
  done
  images="$images}"
  docker run --rm --user "$(id -u):$(id -g)" -v "$feed:/feed" -w /feed "$updater_image" release json create \
    --images "$images" --version "$version" --tag "v$version" --signing none \
    --project "local/demo/$DEMO_PROJECT" --out "/feed/release-$version.json" > /dev/null
}

build_version 1.0.0
build_version 1.1.0
cat > "$feed/index.json" <<JSON
{
  "schemaVersion": 1,
  "releases": [
    { "version": "1.1.0", "tag": "v1.1.0", "prerelease": false, "releaseJson": "release-1.1.0.json" },
    { "version": "1.0.0", "tag": "v1.0.0", "prerelease": false, "releaseJson": "release-1.0.0.json" }
  ]
}
JSON

# The env file: .env.example as written, the demo's values, the 1.0.0 images.
secret() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }
{
  grep -Ev '^(PROJECT_DIR|CICD_UPDATER_IMAGE|POSTGRES_PASSWORD|ADMIN_TOKEN|[A-Z_]*_IMAGE)=' .env.example || true
  echo "PROJECT_DIR=$PWD"
  echo "CICD_UPDATER_IMAGE=$updater_image"
  echo "POSTGRES_PASSWORD=$(secret)"
  echo "ADMIN_TOKEN=$(secret)"
  cat "$first_refs"
} > .env
chmod 600 .env

"${compose[@]}" up -d --wait
echo "1.0.0 is running; scheduling the update to 1.1.0 through the sidecar."
"${compose[@]}" exec -T updater cicd-updater schedule 1.1.0 --in 0 --yes --label update-demo

for _ in $(seq 1 180); do
  phase="$("${compose[@]}" exec -T updater cicd-updater status --json | grep -o '"phase": *"[a-z_]*"' | head -n 1 | sed 's/.*"\([a-z_]*\)"$/\1/')"
  case "$phase" in
    scheduled | running) sleep 2 ;;
    *) break ;;
  esac
done
"${compose[@]}" exec -T updater cicd-updater status
echo
echo "Done. The env file now points at 1.1.0:"
grep -E '_IMAGE=' .env
echo "Clean up with: make demo-down"
