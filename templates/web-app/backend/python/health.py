"""cicd-updater: the health endpoint the sidecar polls after an update (FastAPI).

- Readiness for everyone: 200 when ready, 503 while starting.
- The version only for the sidecar: it sends "Authorization: Bearer <shared token>"
  (hooks.health.http.sendToken: true, the default). A public version number tells an
  attacker which known vulnerability is still open.

updater.yaml:  hooks.health.http.url: http://api:8000/healthz
               hooks.health.http.versionJsonPath: $.version

The version is baked into the image at build time. The release side's build action passes
the plain version as the build argument VERSION; your Dockerfile turns it into a variable:

    ARG VERSION=0.0.0-dev
    ENV APP_VERSION=${VERSION}

    from health import router as health_router
    app.include_router(health_router)
"""

from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

APP_VERSION = os.environ.get("APP_VERSION", "0.0.0-dev").removeprefix("v")
TOKEN_FILE = Path(os.environ.get("UPDATER_TOKEN_FILE", "/run/cicd-updater/token"))

router = APIRouter()


def updater_token() -> Optional[str]:
    try:
        return TOKEN_FILE.read_text().strip() or None
    except OSError:
        return None  # no sidecar: nobody gets the version


def is_updater(authorization: Optional[str]) -> bool:
    token = updater_token()
    scheme, _, given = (authorization or "").partition(" ")
    # Hash both sides, so the comparison takes the same time whatever was sent.
    expected = hashlib.sha256((token or "").encode()).digest()
    provided = hashlib.sha256(given.strip().encode()).digest()
    matches = hmac.compare_digest(expected, provided)
    return token is not None and scheme.lower() == "bearer" and matches


async def ready() -> bool:
    """TODO(cicd-updater): what "ready" means for your app, for example a database ping.

    Check only what the first start group provides (docs/hooks.md, health).
    """
    return True


@router.get("/healthz")
async def health(request: Request) -> JSONResponse:
    try:
        ok = await ready()
    except Exception:  # noqa: BLE001 - not ready, whatever the reason
        ok = False
    body: dict[str, str] = {"status": "ok" if ok else "starting"}
    if is_updater(request.headers.get("authorization")):
        body["version"] = APP_VERSION
    return JSONResponse(body, status_code=200 if ok else 503, headers={"cache-control": "no-store"})
