# 0009. What does not start is not published

| | |
| --- | --- |
| Status | Accepted |
| Scope | cicd-updater 1.0 ([design](../design.md), decision 9 of section 0) |

## Context

An image can build and pass unit tests and still not start in production: a variable the
Compose file references is missing from `.env.example`, an optional variable left empty
crashes the app, or the migration from the previous release fails. Once such a release is
tagged, signed and published, it appears in the feed, and every installation may try it.
Published tags and versions are immutable, so the version number is lost.

## Decision

The release actions run in this order, and nothing is public before the smoke test passed:

1. Build the images for every platform and push them **by digest, without tags**.
2. Smoke-test exactly those digests:
   - every `${VAR}` referenced in the Compose files appears in `.env.example` (commented
     lines count);
   - start the project with the production Compose files, an env file derived from
     `.env.example` **as written** (empty optional values stay empty, because that is what
     production gets) plus the image variables, a scratch database, and no restart
     policies, so a crash stays visible;
   - wait for the health URL (and the version);
   - optionally start the previous release first and update it to the new digests,
     through the sidecar itself (in `none` mode with a generated `release.json` from a
     `file` feed, because the images are signed only after the smoke test);
   - tear everything down, also on failure.
3. Only then create the multi-arch index, tag it, sign it, and create, sign and publish
   `release.json` and the release.

## Consequences

- A release that does not start never reaches the feed. A failed run leaves untagged
  digests and a draft release, nothing public.
- The upgrade path from the previous release is tested with the same engine the hosts use.
- The release pipeline takes longer and needs a health URL and Compose files that run in
  CI.
- Untagged digests from failed runs stay in the registry until its cleanup policy removes
  them.

## Alternatives considered

- **Publish, then test.** Rejected: a broken version becomes visible and installable, and
  its number is burnt.
- **Test separately built images.** Rejected: what was tested would not be what is
  published (different digests).
- **Rely on the sidecar's rollback in production.** Rejected: it moves the failure to every
  installation, and a rollback is not always possible
  ([0006](0006-rollback-only-when-certain.md)).
