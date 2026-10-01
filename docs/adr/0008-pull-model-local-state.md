# 0008. Pull model, local durable state

| | |
| --- | --- |
| Status | Accepted |
| Scope | cicd-updater 1.0 ([design](../design.md), decision 8 of section 0) |

## Context

During an update the app is stopped and replaced. It cannot reliably receive a report about
the update that is replacing it, and the sidecar itself may be restarted in the middle of a
run (host reboot, operator action, crash). The app still needs a complete audit trail, and
users need to see progress while the app is down.

## Decision

- The run's state lives in `status.json` in the sidecar's own state volume. It is written
  atomically (temporary file, fsync, rename, directory fsync) **before** the side effect
  that follows each change.
- The app **pulls**: it polls `GET /v1/state` and reads journal events with a cursor
  (`GET /v1/events?after=<cursor>`), writing each event and the cursor in one transaction.
  This gives exactly-once ingestion.
- Anonymous visitors see `GET /public/v1/status` through the edge while the app is down.
- After a restart the sidecar resolves the run by a fixed table: re-arm a future start,
  start a late one within a tolerance, fail a missed one (`missed_start`), end an
  interrupted run `unchanged` before the point of no return or `needs_attention` after it.
  It never starts or stops application services on its own beyond that table.

## Consequences

- Nothing depends on a final report reaching the app. Events recorded while the app was
  down are ingested when it is back.
- The state survives restarts of the sidecar and of the app.
- The app has to poll: every 30 seconds while idle and every 3 seconds during a run for
  the journal; the browser polls the app every 30 or 2 seconds.
- The journal is bounded (`state.eventLimit`, default 500). An app that falls further
  behind is told so (`gap: true`) and records the gap.
- `status.json` is internal and migrated forward automatically; clients read only the API
  views, which are the contract.

## Alternatives considered

- **Webhooks or callbacks to the app.** Rejected: lost while the app is down, they need a
  retry queue and outbound credentials, and ordering across restarts is hard.
- **A shared database.** Rejected: the sidecar holds no application credentials by design.
- **Only a final report at the end of the run.** Rejected: it would be sent exactly when
  the app is least able to receive it.
