# 0005. Pull by digest, write `repo:tag@sha256:...`

| | |
| --- | --- |
| Status | Accepted |
| Scope | cicd-updater 1.0 ([design](../design.md), decision 5 of section 0) |

## Context

An image tag is a movable pointer. If the sidecar verified a tag and pulled it afterwards,
the tag could move in between (time of check to time of use). If it wrote a plain tag into
the env file, a later `docker compose pull` or a restart could run something else than what
was verified.

## Decision

For every image of the plan:

1. Verify the signature of `<repository>@<digest>` (the digest from the verified
   `release.json`, with a configured mirror repository applied).
2. `docker pull` exactly that digest.
3. Check that the local image is known by that digest (on the classic and the containerd
   image store); otherwise fail with `fetch.digest_mismatch`. If the image carries the OCI
   label `org.opencontainers.image.version`, it must equal the target version.
4. Write `<repository>:<tag>@<digest>` into the env file and start with
   `docker compose up --pull never`. The tag is for people reading the file; Docker and
   Compose resolve the digest.

If an image store turns out not to resolve `repo:tag@digest` to the pulled image, the
reference written becomes `<repository>@<digest>`; the end-to-end result is recorded in
[compatibility](../compatibility.md).

## Consequences

- There is no window in which a moved tag can change what runs.
- The env file stays readable: the version is visible in the tag.
- Mirrors must carry the same digests and the signatures (`cosign copy`).
- Values written into the env file must match the image reference grammar (no quotes, no
  `$`, no whitespace), which also prevents env file injection.

## Alternatives considered

- **Pull by tag, then compare the digest.** Rejected: a window between check and use, and
  an extra pull of possibly unwanted content.
- **Write only `<repository>@<digest>`.** Kept as the fallback; less readable for operators.
- **Verify the tag's signature.** Rejected: tags move; signatures are bound to digests.
