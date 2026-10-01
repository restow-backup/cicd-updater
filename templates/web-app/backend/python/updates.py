"""cicd-updater: the app's update endpoints for FastAPI, calling the sidecar's HTTP API.

    GET  /api/maintenance                         every signed-in user: the banner
    GET  /api/admin/updates                       admin: the sidecar's state (null: none)
    GET  /api/admin/updates/releases[?refresh=1]  admin: releases and why one is refused
    POST /api/admin/updates                       admin with a recent strong sign-in: schedule
    POST /api/admin/updates/{run_id}/cancel       admin: cancel, or abort before the point
                                                  of no return
    POST /api/admin/updates/{run_id}/acknowledge  admin: clear a finished run

The answers have the same shape as the TypeScript version (backend/node/updates.ts), so
both frontends in frontend/ work with it. The sidecar trusts whoever holds its token, so
this module decides who may act (docs/app-integration.md, section 1). Every place you
must adapt is marked TODO(cicd-updater).

    from updates import install
    install(app)   # the router and the error handlers

Requires: fastapi, httpx (Python 3.10 or newer).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import JSONResponse

UPDATER_URL = os.environ.get("UPDATER_URL", "").rstrip("/")  # empty: no sidecar here
TOKEN_FILE = Path(os.environ.get("UPDATER_TOKEN_FILE", "/run/cicd-updater/token"))
STEP_UP = timedelta(minutes=10)
LEAD_TIMES = [0, 60, 300, 900, 1800, 3600]  # the SDK's DEFAULT_LEAD_TIMES, in seconds
SLOW = 120.0  # releases and scheduling: the sidecar asks the release host and the registry

PLAIN_VERSION = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
RUN_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass
class Actor:
    id: str  # your user id (at most 200 characters)
    label: str  # what an auditor recognises, for example the email address
    is_installation_admin: bool  # not a tenant or project admin: an update affects everyone
    impersonated: bool  # support staff acting as this user never counts
    strong_auth_at: Optional[datetime]  # last passkey, password plus TOTP or OIDC sign-in (aware)


async def current_actor(request: Request) -> Optional[Actor]:
    """TODO(cicd-updater): map your session to an Actor; None when nobody is signed in."""
    raise NotImplementedError("map your session to an Actor")


async def audit(
    action: str, outcome: str, code: str, actor: Optional[Actor], target: Optional[str]
) -> None:
    """TODO(cicd-updater): write a denied or refused attempt into your audit log.

    Accepted actions are not passed here: the sidecar journals them itself; copy its
    journal exactly once (docs/app-integration.md, section 2).
    """


class UpdaterUnavailable(Exception):
    """No sidecar answered: not configured, no token, unreachable, or the token was refused."""


class UpdaterProblem(Exception):
    """The sidecar answered with an RFC 9457 problem document."""

    def __init__(self, status: int, problem: dict[str, Any]):
        super().__init__(problem.get("code", "unknown"))
        self.status = status
        self.code = str(problem.get("code", "unknown"))
        self.problem = problem


def updater_token() -> Optional[str]:
    # Read on every call: a reset volume gives the sidecar a new token.
    try:
        return TOKEN_FILE.read_text().strip() or None
    except OSError:
        return None


async def sidecar(
    method: str, path: str, body: Optional[dict[str, Any]] = None, timeout: float = 5.0
) -> Any:
    token = updater_token()
    if not UPDATER_URL or not token:
        raise UpdaterUnavailable()
    try:
        # The token goes only to the sidecar and never follows a redirect.
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            response = await client.request(
                method,
                f"{UPDATER_URL}{path}",
                json=body,
                headers={"authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as error:
        raise UpdaterUnavailable() from error
    if response.is_success:
        return response.json()
    if response.status_code != 401 and response.headers.get("content-type", "").startswith(
        "application/problem+json"
    ):
        raise UpdaterProblem(response.status_code, response.json())
    raise UpdaterUnavailable()


async def state_or_none() -> Optional[dict[str, Any]]:
    try:
        return await sidecar("GET", "/v1/state")
    except (UpdaterUnavailable, UpdaterProblem):
        return None


def requested_by(actor: Actor) -> dict[str, str]:
    return {"id": actor.id[:200], "label": actor.label[:200]}


def denial(actor: Optional[Actor], step_up: bool) -> Optional[HTTPException]:
    """None: allowed. TODO(cicd-updater): adapt to your roles if Actor does not fit."""
    if actor is None:
        return HTTPException(status_code=401, detail="unauthorized")
    if not actor.is_installation_admin or actor.impersonated:
        return HTTPException(status_code=403, detail="forbidden")
    if step_up:
        at = actor.strong_auth_at
        if at is None or datetime.now(timezone.utc) - at > STEP_UP:
            # Your UI turns this into a "confirm it is you" dialog and retries.
            return HTTPException(status_code=403, detail="step_up_required")
    return None


async def require_admin(
    action: str, actor: Optional[Actor], target: Optional[str], step_up: bool = False
) -> Actor:
    refused = denial(actor, step_up)
    if refused is not None or actor is None:
        error = refused or HTTPException(status_code=401, detail="unauthorized")
        await audit(action, "denied", str(error.detail), actor, target)
        raise error
    return actor


async def act(
    action: str, actor: Actor, target: Optional[str], method: str, path: str, body: dict[str, Any]
) -> Any:
    """An admin action: audit what the sidecar refused, or that no sidecar answered."""
    try:
        return await sidecar(method, path, body, timeout=SLOW)
    except UpdaterProblem as error:
        await audit(action, "refused", error.code, actor, target)
        raise
    except UpdaterUnavailable:
        await audit(action, "failed", "updater_unavailable", actor, target)
        raise


async def json_body(request: Request) -> dict[str, Any]:
    # JSON only: a cross-site HTML form cannot send it without a CORS preflight.
    if not request.headers.get("content-type", "").lower().startswith("application/json"):
        raise HTTPException(status_code=415, detail="unsupported_media_type")
    raw = await request.body()
    if len(raw) > 16_384:
        raise HTTPException(status_code=413, detail="payload_too_large")
    try:
        value = await request.json() if raw else {}
    except ValueError:
        value = None
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="invalid_request")
    return value


def maintenance_view(state: Optional[dict[str, Any]]) -> dict[str, Any]:
    """The public status shape plus the versions, as the SDK's maintenanceViewOf builds it."""
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    run = state.get("run") if state else None
    if not state or not run or state["phase"] == "idle":
        return {
            "phase": "idle", "runId": None, "outcome": None, "startsAt": None, "startedAt": None,
            "finishedAt": None, "step": None, "steps": [], "progress": 0, "message": None,
            "failureCode": None, "serverTime": now,
        }
    return {
        "phase": state["phase"],
        "runId": run["id"],
        "outcome": run["outcome"],
        "startsAt": run["startsAt"],
        "startedAt": run["startedAt"],
        "finishedAt": run["finishedAt"],
        "step": run["step"],
        "steps": [{"id": step["id"], "status": step["status"]} for step in run["steps"]],
        "progress": run["progress"],
        "message": run["message"],
        "failureCode": (run.get("failure") or {}).get("code"),
        "targetVersion": run["targetVersion"],
        "fromVersion": run["fromVersion"],
        "serverTime": now,
    }


router = APIRouter(prefix="/api")


@router.get("/maintenance")
async def maintenance(actor: Optional[Actor] = Depends(current_actor)) -> JSONResponse:
    # Every signed-in user. Never the full state: it holds image references, paths and
    # the run log, which are for admins.
    if actor is None:
        raise HTTPException(status_code=401, detail="unauthorized")
    view = maintenance_view(await state_or_none())
    return JSONResponse(view, headers={"cache-control": "no-store"})


@router.get("/admin/updates")
async def admin_state(actor: Optional[Actor] = Depends(current_actor)) -> JSONResponse:
    await require_admin("updates.read", actor, None)
    try:
        state = await sidecar("GET", "/v1/state")
    except UpdaterUnavailable:
        state = None  # no sidecar on this installation: the page shows the manual steps
    body = {
        "state": state,
        "leadTimes": LEAD_TIMES,
        "stepUpMaxAgeSeconds": int(STEP_UP.total_seconds()),
    }
    return JSONResponse(body, headers={"cache-control": "no-store"})


@router.get("/admin/updates/releases")
async def admin_releases(
    request: Request, actor: Optional[Actor] = Depends(current_actor)
) -> JSONResponse:
    await require_admin("updates.releases", actor, None)
    refresh = "?refresh=true" if request.query_params.get("refresh") == "1" else ""
    view = await sidecar("GET", f"/v1/releases{refresh}", timeout=SLOW)
    return JSONResponse(view, headers={"cache-control": "no-store"})


@router.post("/admin/updates", status_code=202)
async def schedule(
    request: Request, actor: Optional[Actor] = Depends(current_actor)
) -> JSONResponse:
    admin = await require_admin("updates.schedule", actor, None, step_up=True)
    body = await json_body(request)
    version = body.get("version")
    lead_seconds = body.get("leadSeconds")
    release_sha256 = body.get("releaseSha256")
    if not isinstance(version, str) or not PLAIN_VERSION.match(version):
        raise HTTPException(status_code=422, detail="invalid_request")
    if not isinstance(lead_seconds, int) or isinstance(lead_seconds, bool) or lead_seconds < 0:
        raise HTTPException(status_code=422, detail="invalid_request")
    # The hash of the release.json the admin was shown: what they saw is what gets installed.
    if not isinstance(release_sha256, str) or not SHA256.match(release_sha256):
        raise HTTPException(status_code=422, detail="invalid_request")
    request_body = {
        "version": version,
        "leadSeconds": lead_seconds,  # the sidecar enforces schedule.maxLeadSeconds
        "requestedBy": requested_by(admin),
        "expect": {"releaseSha256": release_sha256},
    }
    state = await act("updates.schedule", admin, version, "POST", "/v1/runs", request_body)
    return JSONResponse(state, status_code=202, headers={"cache-control": "no-store"})


@router.post("/admin/updates/{run_id}/{action}")
async def run_action(
    run_id: str, action: str, request: Request, actor: Optional[Actor] = Depends(current_actor)
) -> JSONResponse:
    if action not in ("cancel", "acknowledge"):
        raise HTTPException(status_code=404, detail="not_found")
    name = f"updates.{action}"
    admin = await require_admin(name, actor, run_id[:64])
    await json_body(request)  # no fields; JSON only, as for every POST
    if not RUN_ID.match(run_id):
        raise HTTPException(status_code=404, detail="not_found")
    # cancel: a scheduled run is cancelled; a running one gets run.abortRequestedAt and stops
    # at its next check point, or the sidecar answers 409 point_of_no_return.
    body = {"requestedBy": requested_by(admin)}
    state = await act(name, admin, run_id, "POST", f"/v1/runs/{run_id}/{action}", body)
    return JSONResponse(state, headers={"cache-control": "no-store"})


def install(app: FastAPI) -> None:
    """Add the routes and answer errors as {code, ...}, like the TypeScript version.

    TODO(cicd-updater): if your app registers its own HTTPException handler, merge it with
    `http_error` below (the last registration wins).
    """
    app.include_router(router)

    @app.exception_handler(UpdaterProblem)
    async def updater_problem(_: Request, error: UpdaterProblem) -> JSONResponse:
        # Sidecar problems keep their status and code (a 409 blocked stays 409 with its blockers).
        keep = ("blockers", "reasons", "errors", "feedError")
        extensions = {key: error.problem[key] for key in keep if key in error.problem}
        body = {"code": error.code, **extensions}
        return JSONResponse(body, status_code=error.status, headers={"cache-control": "no-store"})

    @app.exception_handler(UpdaterUnavailable)
    async def updater_unavailable(_: Request, __: UpdaterUnavailable) -> JSONResponse:
        return JSONResponse({"code": "updater_unavailable"}, status_code=503)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, error: HTTPException) -> Any:
        # {code} instead of FastAPI's {detail} on these routes only, so the frontends read
        # one shape; every other route of your app keeps FastAPI's default answer.
        path = request.url.path
        if path == "/api/maintenance" or path.startswith("/api/admin/updates"):
            return JSONResponse({"code": str(error.detail)}, status_code=error.status_code)
        return await http_exception_handler(request, error)
