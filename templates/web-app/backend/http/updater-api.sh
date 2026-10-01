#!/bin/sh
# cicd-updater: a reference client for the sidecar's HTTP API, for apps in any language.
# Run it inside your backend container, which has the shared token and the internal
# network; the calls are the ones your backend makes (README.md in this directory).
#
#   sh updater-api.sh state                      everything an admin page needs
#   sh updater-api.sh releases [refresh]         releases with refusals and releaseSha256
#   sh updater-api.sh verify 1.4.0               dry run: signatures and refusals, no pull
#   sh updater-api.sh schedule 1.4.0 900 <releaseSha256>
#   sh updater-api.sh cancel <runId>
#   sh updater-api.sh ack <runId>
#   sh updater-api.sh events [<afterEventId>]    the journal, for your audit log
#   sh updater-api.sh public-status              what the edge forwards (no token)
#   sh updater-api.sh health http://api:3000/healthz
#                                                your health endpoint as the sidecar sees it
#                                                (sends the token: only your own app)
#
# Environment: UPDATER_URL (default http://updater:8090), UPDATER_TOKEN_FILE (default
# /run/cicd-updater/token), ACTOR_ID and ACTOR_LABEL (recorded as requestedBy).
# The token is passed to curl on standard input, never as an argument.
set -eu

URL="${UPDATER_URL:-http://updater:8090}"
TOKEN_FILE="${UPDATER_TOKEN_FILE:-/run/cicd-updater/token}"
ACTOR_ID="${ACTOR_ID:-operator}"
ACTOR_LABEL="${ACTOR_LABEL:-updater-api.sh}"

fail() {
  echo "updater-api.sh: $*" >&2
  exit 2
}

NL='
'

# Plain values only: nothing from the command line reaches the JSON unchecked.
check() {
  case "$2" in *"$NL"*) fail "invalid $1: line break" ;; esac
  printf '%s' "$2" | grep -Eq "$3" || fail "invalid $1: $2"
}

# curl reads the Authorization header from standard input (-H @-).
call() {
  method=$1
  path=$2
  shift 2
  [ -r "$TOKEN_FILE" ] || fail "cannot read $TOKEN_FILE (is the sidecar running?)"
  printf 'Authorization: Bearer %s\n' "$(tr -d '[:space:]' <"$TOKEN_FILE")" |
    curl --silent --show-error --max-time 130 --proto '=http,https' \
      --request "$method" --header @- --header 'Accept: application/json' \
      --write-out '\nHTTP %{http_code}\n' "$@" "$URL$path"
}

post() {
  call POST "$1" --header 'Content-Type: application/json' --data "$2"
}

actor() {
  check "ACTOR_ID" "$ACTOR_ID" '^[A-Za-z0-9@._+-]{1,200}$'
  check "ACTOR_LABEL" "$ACTOR_LABEL" '^[A-Za-z0-9@._+ ()-]{1,200}$'
  printf '{"id":"%s","label":"%s"}' "$ACTOR_ID" "$ACTOR_LABEL"
}

VERSION_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
RUN_RE='^[A-Za-z0-9_-]{1,64}$'

command=${1:-}
[ $# -gt 0 ] && shift
case "$command" in
  state)
    call GET /v1/state
    ;;
  releases)
    if [ "${1:-}" = refresh ]; then call GET '/v1/releases?refresh=true'; else call GET /v1/releases; fi
    ;;
  verify)
    check version "${1:-}" "$VERSION_RE"
    call POST "/v1/releases/$1/verification"
    ;;
  schedule)
    [ $# -eq 3 ] || fail "usage: schedule <version> <leadSeconds> <releaseSha256>"
    check version "$1" "$VERSION_RE"
    check leadSeconds "$2" '^[0-9]{1,7}$'
    check releaseSha256 "$3" '^[0-9a-f]{64}$'
    by=$(actor)
    post /v1/runs "{\"version\":\"$1\",\"leadSeconds\":$2,\"requestedBy\":$by,\"expect\":{\"releaseSha256\":\"$3\"}}"
    ;;
  cancel | ack)
    check runId "${1:-}" "$RUN_RE"
    if [ "$command" = ack ]; then action=acknowledge; else action=cancel; fi
    by=$(actor)
    post "/v1/runs/$1/$action" "{\"requestedBy\":$by}"
    ;;
  events)
    if [ -n "${1:-}" ]; then
      check eventId "$1" '^[0-9]{15}-[0-9]{6}$'
      call GET "/v1/events?limit=100&after=$1"
    else
      call GET '/v1/events?limit=100'
    fi
    ;;
  public-status)
    curl --silent --show-error --max-time 10 --write-out '\nHTTP %{http_code}\n' "$URL/public/v1/status"
    ;;
  health)
    check url "${1:-}" '^https?://[A-Za-z0-9._:/-]+$'
    URL="${1%/}"
    call GET ""
    ;;
  *)
    sed -n '2,20p' "$0" >&2
    exit 2
    ;;
esac
