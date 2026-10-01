# `release.json`

`release.json` is the contract between the release side and the sidecar. It says which
version a release is, which image digests belong to it, which running versions may update
to it, and what it requires. The release side generates it from the digests it actually
pushed ([release-side.md](release-side.md)); the sidecar installs nothing that the document
and the signatures do not allow.

| | |
| --- | --- |
| Asset name | exactly `release.json` |
| Signature | `release.json.sigstore.json` (a Sigstore bundle), in `keyless` and `key` mode |
| Encoding | UTF-8 JSON, no byte order mark |
| Size | at most 64 KiB (65536 bytes); the bundle at most 256 KiB |
| JSON Schema | `schemas/release.schema.json` (`$id` `https://raw.githubusercontent.com/restow-backup/cicd-updater/main/schemas/release.schema.json`) |
| Schema version | `1` |

## Example

```json
{
  "schemaVersion": 1,
  "project": "github.com/acme/notes",
  "version": "1.4.0",
  "tag": "v1.4.0",
  "channel": "stable",
  "commit": "4f1c0b6e2a9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b",
  "createdAt": "2026-11-02T18:04:11Z",
  "notesUrl": "https://github.com/acme/notes/releases/tag/v1.4.0",
  "images": {
    "app": {
      "repository": "ghcr.io/acme/notes",
      "tag": "1.4.0",
      "digest": "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
      "platforms": ["linux/amd64", "linux/arm64"]
    },
    "web": {
      "repository": "ghcr.io/acme/notes-web",
      "tag": "1.4.0",
      "digest": "sha256:1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
      "platforms": ["linux/amd64", "linux/arm64"]
    }
  },
  "upgrade": {
    "minimumFromVersion": "1.2.0",
    "manualSteps": {
      "required": false,
      "summary": null,
      "url": null
    }
  },
  "requires": {
    "updater": ">=1.0.0",
    "env": ["NOTES_SEARCH_URL"]
  },
  "signing": {
    "mode": "keyless",
    "tool": "cosign",
    "toolVersion": "3.1.3"
  }
}
```

The release tools write the fields in this order, indented with two spaces, with a final
newline. Readers must not depend on order or formatting; the SHA-256 is computed over the
exact bytes.

## Fields

| Field | Required | Type and limits | Meaning | Enforced by |
| --- | --- | --- | --- | --- |
| `schemaVersion` | yes | `1` | Schema version. Readers reject numbers they do not know (`release.unsupported_schema`). | sidecar, SDK |
| `project` | yes | `host[:port]/segment/...` with 2 to 6 path segments (`[A-Za-z0-9_.-]{1,100}` each), lowercase host, at most 300 characters | The source repository, for example `github.com/acme/notes` or `gitlab.com/group/sub/project`. | sidecar (compared with the feed repository) |
| `version` | yes | plain SemVer `MAJOR.MINOR.PATCH[-pre]`, no `v`, no build metadata, at most 64 characters | The release version. | sidecar, SDK |
| `tag` | yes | `^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$` | The Git tag; equals `release.tagPattern` rendered with `version`. | sidecar, release tools |
| `channel` | yes | `stable` or `beta` | `beta` if and only if `version` has a pre-release part. | sidecar, SDK |
| `commit` | no | 40 or 64 lowercase hex characters, or `null` | The commit the release was built from. | informational |
| `createdAt` | yes | RFC 3339 date-time with offset (the release tools write UTC with `Z`) | When the document was generated. | informational |
| `notesUrl` | no | `https://` URL, at most 2000 characters, or `null` | Human release notes. | SDK, UI |
| `images` | yes | 1 to 32 entries, keys `^[a-z][a-z0-9-]{0,31}$` | One entry per published image. The key is what `updater.yaml` maps services to (`services[].image`). | sidecar |
| `images.<key>.repository` | yes | lowercase repository without tag, at most 255 characters | Where the image was published. A mirror can replace it on the host (`images.<key>.repository` in `updater.yaml`, [registries.md](registries.md)). | sidecar |
| `images.<key>.tag` | yes | `^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`; must equal `version` | The image tag (the version without `v`). | sidecar, release tools |
| `images.<key>.digest` | yes | `sha256:` and 64 lowercase hex characters | Digest of the multi-arch index (of the single manifest for one platform). This is what is verified, pulled and written. | sidecar |
| `images.<key>.platforms` | yes | non-empty, unique, from `linux/amd64`, `linux/arm64` | Platforms in the index; the host platform must be listed (`platform_unsupported`). | sidecar |
| `upgrade.minimumFromVersion` | yes | plain SemVer or `null`; lower than `version` | Lowest running version this release may be installed over; `null` means any. | sidecar (refusal `below_minimum_version`), SDK |
| `upgrade.manualSteps.required` | yes | boolean | `true`: the operator must act by hand (for example Compose file changes); the sidecar refuses to install it (`manual_steps_required`). | sidecar, UI |
| `upgrade.manualSteps.summary` | no | plain text, at most 2000 characters, or `null` | What the operator must do. | UI |
| `upgrade.manualSteps.url` | no | `https://` URL, at most 2000 characters, or `null` | Where the steps are explained. | UI |
| `requires` | no | object | Requirements of the release. | |
| `requires.updater` | no | `X.Y.Z`, `>=X.Y.Z` or `^X.Y.Z`, at most 64 characters | The sidecar refuses when its own version does not satisfy it (`updater_too_old`). `^` excludes the next breaking version (`^1.2.0` allows `1.x` from `1.2.0`; `^0.3.0` allows `0.3.x`). | sidecar |
| `requires.env` | no | up to 64 unique names `^[A-Za-z_][A-Za-z0-9_]{0,127}$` | Env keys that must be present and non-empty in the env file before this version can start (`env_missing`). Only the names are ever reported, never values. | sidecar |
| `signing.mode` | yes | `keyless`, `key` or `none` | How the release side signed. Informational: it never changes the sidecar's trust policy. | display |
| `signing.tool` | no | `cosign` | The signing tool. | display |
| `signing.toolVersion` | no | at most 32 characters | The cosign version the release side used (omitted in mode `none`). | display |

Unknown fields are ignored by readers, so new optional fields can be added within schema
version 1.

## Validation rules

A reader (the sidecar, the SDK, `cicd-updater release json validate`) checks a document in
this order and reports the first problem:

| Step | Code | Condition |
| --- | --- | --- |
| 1 | `release.too_large` | more than 65536 bytes |
| 2 | `release.bom` | the bytes start with a UTF-8 byte order mark (`EF BB BF`) |
| 3 | `release.not_json` | not valid UTF-8 (strict decoding), or not JSON |
| 4 | `release.schema` | not a JSON object |
| 5 | `release.unsupported_schema` | `schemaVersion` is a number other than `1` |
| 6 | `release.schema` | the schema does not match (the detail names the first path) |
| 7 | additional rules | below |

The additional rules are the ones the JSON Schema cannot express (`releaseRuleViolations`
in `packages/protocol/src/release.ts`):

| Code | Rule |
| --- | --- |
| `release.channel_mismatch` | `channel` is `beta` if and only if `version` contains a pre-release part. |
| `release.tag_mismatch` | Sidecar side: `tag` equals `release.tagPattern` rendered with `version` (an invalid pattern fails too). Release side: `tag` equals the Git tag the action ran for (`json validate --tag`). |
| `release.image_tag_mismatch` | Every `images.<key>.tag` equals `version`. |
| `release.minimum_not_lower` | `upgrade.minimumFromVersion`, when set, is strictly lower than `version` (SemVer precedence). |

The sidecar adds checks against its own configuration, reported as `release.mismatch`:

- `version` and `tag` equal the version that was requested and the tag the feed lists for
  it;
- `project` names the configured feed repository (case-insensitive). For a Forgejo or
  Gitea feed with a path prefix, a `project` without that prefix is accepted. Static and
  file feeds have no repository, so `project` is not compared there.

`release.json` validation runs on the release side before signing (`json create` validates
what it writes, and the action runs `json validate --tag` again), and on the host every
time a document is read.

### Validating by hand

```sh
docker run --rm -v "$PWD:/w:ro" ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:<digest> \
  release json validate --file /w/release.json --tag v1.4.0
```

prints `valid: <project> <version> (<image keys>)`, or the code and detail with exit code
`1`. The schema file `schemas/release.schema.json` can be used with any JSON Schema
2020-12 validator; it does not cover the additional rules.

## Schema versions

`schemaVersion: 1` is the only version 1.x knows. Within it, only new optional fields are
added; readers ignore what they do not know. A breaking change would be
`schemaVersion: 2`; a sidecar 1.x rejects it with `release.unsupported_schema`, so an old
sidecar never misreads a new document. See [versioning.md](versioning.md).

## The bundle

In `keyless` and `key` mode the release side signs the exact bytes of `release.json` with
`cosign sign-blob --bundle release.json.sigstore.json`, with the same identity or key as
the images, and publishes the bundle as a second asset. In `none` mode there is no bundle.

The bundle binds every field together: version, tag, the digest of each image key,
minimum version, manual steps and requirements. Someone who can edit release assets but
cannot run the release workflow cannot swap digests between two images of the same
release, lower `minimumFromVersion` or drop `manualSteps.required` without breaking the
signature. [faq.md](faq.md) explains why the document is signed in addition to the images.

## How the sidecar uses the document

The sidecar verifies the document **before it trusts any field of it**:

1. The release list of the feed gives the version, the tag and the asset locations. This
   list is not trusted; `GET /v1/releases` marks it `verified: false`.
2. The sidecar downloads `release.json` (at most 64 KiB) and the bundle (at most 256 KiB).
3. In `keyless` mode it computes the expected identity from `updater.yaml` and the tag of
   the feed entry, and runs `cosign verify-blob --bundle ... --certificate-identity ...
   --certificate-oidc-issuer ...` (plus the GitHub workflow checks). In `key` mode it runs
   `cosign verify-blob --bundle ... --key <public key>` for each configured key until one
   passes. A missing bundle is `signature_missing`. See [trust-modes.md](trust-modes.md).
4. Only then is the document parsed and validated (schema, additional rules, version, tag,
   project).
5. The refusals are evaluated: `not_newer`, `below_minimum_version`,
   `manual_steps_required`, `updater_too_old`, `env_missing`, `image_missing`,
   `platform_unsupported`, `running_version_unknown`.

This happens for the dry run (`POST /v1/releases/{version}/verification`) and again,
without cache, when a run is scheduled. The verified bytes and the bundle are stored in
`<state.dir>/releases/<version>/`. At the start of the run, the sidecar loads the stored
bytes (no refetch), checks that their SHA-256 equals the one recorded at scheduling
(`prepare.release_mismatch`), verifies the bundle again
(`prepare.release_signature_invalid`) and validates the document again. The `finish` step of a successful run keeps the stored
documents of the five newest versions and removes older ones.

In `none` mode, step 3 is skipped and the run records `release.document: "not_checked"`;
every other check still applies.

## `expect.releaseSha256`

The SHA-256 of the document bytes ties what an admin saw to what gets installed:

- the `release-json` action prints it (output `sha256`, and in the job summary);
- `GET /v1/releases` reports it per release (`releaseSha256`), and the SDK's feed check as
  `documentSha256`;
- a schedule request (`POST /v1/runs`) may carry `expect: { releaseSha256: "<64 hex>" }`.
  When the document the sidecar fetches and verifies has another SHA-256, the request is
  refused with `409 release_mismatch`.

An app that shows release details to an admin should pass the SHA-256 of the document it
showed. See [http-api.md](http-api.md) and [sdk.md](sdk.md).

## The feed index (`static` and `file` feeds)

Feeds without a release API list their releases in a feed index,
`schemas/feed-index.schema.json`:

```json
{
  "schemaVersion": 1,
  "releases": [
    {
      "version": "1.4.0",
      "tag": "v1.4.0",
      "prerelease": false,
      "publishedAt": "2026-11-02T18:20:00Z",
      "releaseJson": "https://downloads.example.com/notes/1.4.0/release.json",
      "bundle": "https://downloads.example.com/notes/1.4.0/release.json.sigstore.json",
      "notesUrl": "https://downloads.example.com/notes/1.4.0/NOTES.md"
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | `1` |
| `releases` | yes | up to 1000 entries, in any order (readers sort by version) |
| `releases[].version` | yes | plain SemVer |
| `releases[].tag` | yes | the Git tag; an entry whose tag does not render from `version` through `release.tagPattern` is ignored |
| `releases[].prerelease` | yes | pre-release flag; a pre-release version counts as pre-release anyway. Used only to pre-filter; the channel of the signed document decides. |
| `releases[].publishedAt` | no | RFC 3339 date-time or `null` |
| `releases[].releaseJson` | no | location of `release.json`; absent or `null`: the release has no document and cannot be installed by the sidecar in image mode |
| `releases[].bundle` | no | location of the bundle |
| `releases[].notesUrl` | no | `https://` URL or `null` |

Locations differ by feed:

| Feed | `releaseJson`, `bundle` | Index |
| --- | --- | --- |
| `static` | absolute `https://` URLs on any host; other values count as absent | fetched from `release.feed.url`, at most 8 MiB |
| `file` | plain file names in the feed directory, `^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$` (no paths) | `<release.feed.path>/index.json`, at most 8 MiB |

A file feed directory looks like this:

```
/srv/notes-feed/
├── index.json
├── release-1.4.0.json
└── release-1.4.0.json.sigstore.json
```

```json
{
  "schemaVersion": 1,
  "releases": [
    {
      "version": "1.4.0",
      "tag": "v1.4.0",
      "prerelease": false,
      "releaseJson": "release-1.4.0.json",
      "bundle": "release-1.4.0.json.sigstore.json"
    }
  ]
}
```

The documents keep their content and signature; only the file names change. How the
providers read the index: [feeds.md](feeds.md).
