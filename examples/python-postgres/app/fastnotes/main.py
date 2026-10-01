"""FastNotes: the app's side of cicd-updater in Python (integration level 2).

- /health answers readiness to everyone and adds the version only for the updater's
  token (constant-time compare against the shared token file).
- /admin/updates calls the sidecar's HTTP API with httpx (state, schedule, cancel,
  acknowledge); the token is read from the shared file and never follows a redirect.
- A background task copies the updater's journal into audit_log exactly once: each
  event and the cursor are written in one transaction.

The demo's admin check is a bearer token from ADMIN_TOKEN; a real app uses its own
sign-in, allows only an installation admin and asks for a recent strong sign-in.
"""

import asyncio
import hmac
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import create_engine, text

APP_VERSION = os.environ.get("APP_VERSION", "0.0.0-dev").removeprefix("v")
UPDATER_URL = os.environ.get("UPDATER_URL", "").rstrip("/")
TOKEN_FILE = Path(os.environ.get("UPDATER_TOKEN_FILE", "/run/cicd-updater/token"))
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

engine = create_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)


def updater_token() -> str | None:
    try:
        return TOKEN_FILE.read_text().strip() or None
    except OSError:
        return None


def is_updater(authorization: str | None) -> bool:
    token = updater_token()
    given = (authorization or "").removeprefix("Bearer ").strip()
    return token is not None and hmac.compare_digest(given.encode(), token.encode())


def require_admin(authorization: str | None = Header(default=None)) -> None:
    given = (authorization or "").removeprefix("Bearer ").strip()
    if len(ADMIN_TOKEN) < 16 or not hmac.compare_digest(given.encode(), ADMIN_TOKEN.encode()):
        raise HTTPException(status_code=401, detail="unauthorized")


async def sidecar(method: str, path: str, body: dict | None = None) -> httpx.Response:
    token = updater_token()
    if not UPDATER_URL or not token:
        raise HTTPException(status_code=503, detail="updater_unavailable")
    async with httpx.AsyncClient(timeout=120, follow_redirects=False) as client:
        try:
            response = await client.request(
                method,
                f"{UPDATER_URL}{path}",
                json=body,
                headers={"authorization": f"Bearer {token}"},
            )
        except httpx.HTTPError as error:
            raise HTTPException(status_code=503, detail="updater_unavailable") from error
    if response.status_code >= 400:
        problem = response.json() if response.headers.get("content-type", "").endswith("json") else {}
        raise HTTPException(status_code=response.status_code, detail=problem.get("code", "refused"))
    return response


def ingest_journal_once() -> int:
    """Synchronously copy new journal events (called from a thread)."""
    token = updater_token()
    if not UPDATER_URL or not token:
        return 0
    ingested = 0
    with httpx.Client(timeout=30, follow_redirects=False) as client:
        while True:
            with engine.connect() as connection:
                cursor = connection.execute(
                    text("SELECT last_id FROM updater_journal_cursor WHERE id = 1")
                ).scalar()
            params = {"limit": 100, **({"after": cursor} if cursor else {})}
            response = client.get(
                f"{UPDATER_URL}/v1/events",
                params=params,
                headers={"authorization": f"Bearer {token}"},
            )
            response.raise_for_status()
            events = response.json()["events"]
            for event in events:
                if cursor and event["id"] <= cursor:
                    continue
                with engine.begin() as connection:  # one transaction per event
                    connection.execute(
                        text(
                            "INSERT INTO audit_log (source, event_id, action, actor, detail, created_at) "
                            "VALUES ('updater', :id, :action, :actor, CAST(:detail AS json), :at) "
                            "ON CONFLICT (source, event_id) DO NOTHING"
                        ),
                        {
                            "id": event["id"],
                            "action": event["action"],
                            "actor": event["actor"]["label"],
                            "detail": json.dumps(event),
                            "at": event["at"],
                        },
                    )
                    connection.execute(
                        text(
                            "INSERT INTO updater_journal_cursor (id, last_id) VALUES (1, :id) "
                            "ON CONFLICT (id) DO UPDATE SET last_id = :id"
                        ),
                        {"id": event["id"]},
                    )
                ingested += 1
            if len(events) < 100:
                return ingested


async def journal_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(ingest_journal_once)
        except Exception as error:  # noqa: BLE001 - keep the loop alive, log the reason
            print(f"journal sync: {error}")
        await asyncio.sleep(30)


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(journal_loop())
    yield
    task.cancel()


app = FastAPI(title="FastNotes", lifespan=lifespan)


@app.get("/health")
def health(request: Request) -> dict:
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        database = "ok"
    except Exception:  # noqa: BLE001
        database = "unavailable"
    body: dict = {"status": "ok", "database": database}
    if is_updater(request.headers.get("authorization")):
        body["version"] = APP_VERSION
    return body


@app.get("/api/notes")
def list_notes() -> list[dict]:
    with engine.connect() as connection:
        rows = connection.execute(text("SELECT id, title FROM notes ORDER BY id DESC LIMIT 50"))
        return [{"id": row.id, "title": row.title} for row in rows]


class Schedule(BaseModel):
    version: str
    leadSeconds: int = 300
    releaseSha256: str | None = None


@app.get("/admin/updates", dependencies=[Depends(require_admin)])
async def update_state() -> dict:
    return (await sidecar("GET", "/v1/state")).json()


@app.post("/admin/updates", status_code=202, dependencies=[Depends(require_admin)])
async def schedule_update(request: Schedule) -> dict:
    body: dict = {
        "version": request.version,
        "leadSeconds": request.leadSeconds,
        "requestedBy": {"id": "admin", "label": "FastNotes admin"},
    }
    if request.releaseSha256:
        body["expect"] = {"releaseSha256": request.releaseSha256}
    return (await sidecar("POST", "/v1/runs", body)).json()


@app.post("/admin/updates/{run_id}/{action}", dependencies=[Depends(require_admin)])
async def act_on_run(run_id: str, action: str) -> dict:
    if action not in ("cancel", "acknowledge") or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", run_id):
        raise HTTPException(status_code=404, detail="not_found")
    actor = {"requestedBy": {"id": "admin", "label": "FastNotes admin"}}
    return (await sidecar("POST", f"/v1/runs/{run_id}/{action}", actor)).json()
