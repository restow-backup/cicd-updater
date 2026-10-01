# Feeds

A feed tells the sidecar (and the app, through the SDK) which releases exist and where
their `release.json` and bundle are. The feed is not trusted: everything that matters is
in the signed `release.json` ([release-json.md](release-json.md)). The feed only has to be
reachable, and it must not become a tool to probe the network it runs in.

| Provider | Release list | Assets | Used by |
| --- | --- | --- | --- |
| `github` | GitHub releases API | release assets | sidecar, SDK, smoke |
| `gitea` | Forgejo and Gitea releases API (`/api/v1`) | release attachments | sidecar, SDK, smoke |
| `gitlab` | GitLab releases API (`/api/v4`) | release asset links | sidecar, SDK, smoke |
| `static` | a feed index at any https URL | URLs in the index | sidecar, SDK, smoke |
| `file` | `index.json` in a directory mounted into the sidecar | files in that directory | sidecar only |

Status: every provider and the address guard are unit-tested against fake servers and a
fake resolver. Reading the real services is to be verified in the end-to-end run
([compatibility.md](compatibility.md)).

## Configuration

In `updater.yaml` ([configuration.md](configuration.md)):

```yaml
release:
  feed:
    type: github                         # github | gitea | gitlab | static | file
    url: https://github.com/acme/notes   # not with file
    # path: /srv/notes-feed              # file only
    # tokenFile: /run/secrets/feed-token # private repositories
    # allowPrivateNetwork: false         # true: the feed host may be on a private network
  channel: stable                        # stable | beta (beta includes pre-releases)
  tagPattern: v{version}
  cacheSeconds: 300                      # reuse of the list and the documents
  checkIntervalHours: 0                  # 0: read the feed only on request
```

In the SDK, `checkFeed({ feed: { type, url }, token, channel, running, tagPattern,
allowPrivateHosts })` reads the same providers except `file` ([sdk.md](sdk.md)).

`checkIntervalHours` only refreshes the cached list. The sidecar never schedules or
installs anything on its own.

## Rules for every provider

- **Drafts are ignored.** GitLab entries with `upcoming_release: true` are ignored too.
- **The tag decides the version.** An entry whose tag does not render from a plain SemVer
  version through `release.tagPattern` is ignored. Duplicates are removed and the list is
  sorted newest first.
- **Only the first page is read**: 30 releases, in the host's own order.
- **The pre-release flag only pre-filters.** On the `stable` channel, entries flagged as
  pre-release (or with a pre-release version) are left out. The `channel` of the signed
  `release.json` is what counts.
- **At most 10 releases** of the channel are listed (`GET /v1/releases`, SDK `checkFeed`),
  and `release.json` is read only for releases newer than the running version.
- **No `release.json`, no install in image mode.** Such entries are listed with the refusal
  `no_release_document`; scheduling them fails with `release_not_found`. Source mode
  builds from the tag and does not need one ([security.md](security.md)).
- **Nothing about the installation is sent**: no version in the URL, a fixed
  `User-Agent: cicd-updater-feed/1`.

## Providers

### `github`

| | |
| --- | --- |
| `url` | `https://github.com/<owner>/<repo>` (the host must be exactly `github.com`; GitHub Enterprise Server is not supported by this provider) |
| Release list | `GET https://api.github.com/repos/<owner>/<repo>/releases?per_page=30` |
| Assets | the assets named `release.json` and `release.json.sigstore.json`. Without a token: their `browser_download_url`. With a token: the API asset URL (`assets[].url`) with `Accept: application/octet-stream` |
| Token | `Authorization: Bearer <token>`, sent to `https://api.github.com` only |
| `project` compared with | `github.com/<owner>/<repo>` |
| Release time, notes | `published_at` (or `created_at`), `html_url` |

The API answers an asset request with a redirect to a download host on another origin.
The redirect is followed and the token is dropped at that point. Without a token the
unauthenticated API rate limit applies; the error is `rate_limited` with the time it ends.

### `gitea` (Forgejo and Gitea)

| | |
| --- | --- |
| `url` | `https://<host>[/<prefix>]/<owner>/<repo>`; a path prefix is supported |
| Release list | `GET https://<host>[/<prefix>]/api/v1/repos/<owner>/<repo>/releases?limit=30` |
| Assets | the attachments named `release.json` and `release.json.sigstore.json`, by their `browser_download_url` |
| Token | `Authorization: token <token>`, sent to the origin of `url` only |
| `project` compared with | `<host>[/<prefix>]/<owner>/<repo>`; a document `project` without the prefix is accepted |
| Release time, notes | `published_at` (or `created_at`), `html_url` |

An internal Forgejo on a private address needs `allowPrivateNetwork: true` (see
[Address rules](#address-rules-ssrf-protection)).

### `gitlab`

| | |
| --- | --- |
| `url` | `https://<host>/<group>[/<subgroup>...]/<project>` (2 to 8 path segments); GitLab installed under a path prefix is not supported |
| Release list | `GET https://<host>/api/v4/projects/<url-encoded path>/releases?per_page=30` |
| Assets | the entries of `assets.links[]` whose `name` is `release.json` or `release.json.sigstore.json`; their `direct_asset_url`, else their `url` (https only) |
| Token | `Authorization: Bearer <token>`, sent to the origin of `url` only |
| `project` compared with | `<host>/<group>/.../<project>` |
| Pre-releases | GitLab has no pre-release flag; a pre-release version counts as pre-release |
| Release time, notes | `released_at` (or `created_at`), `_links.self` |

The release tools upload the files to the project's generic package registry and add
asset links named after the files ([release-side.md](release-side.md)).

### `static`

| | |
| --- | --- |
| `url` | the https URL of a feed index ([release-json.md](release-json.md#the-feed-index-static-and-file-feeds)) on any host: object storage, a Pages site, a web server |
| Release list | `GET <url>`; the body must match `schemas/feed-index.schema.json` |
| Assets | the `releaseJson` and `bundle` URLs of each entry; values that are not https URLs count as absent |
| Token | `Authorization: Bearer <token>`, sent to the origin of the index only |
| `project` | none; the document's `project` is not compared, and source mode is not available |

### `file`

| | |
| --- | --- |
| `path` | an absolute directory mounted into the sidecar (read-only is enough); `url` must not be set |
| Release list | `<path>/index.json`, a feed index of at most 8 MiB |
| Assets | plain file names in the same directory (`^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$`, regular files only) |
| Token, network | none |
| `project` | none; the document's `project` is not compared, and source mode is not available |

Use it for air-gapped hosts: copy `release.json`, its bundle and an `index.json` onto the
host, and keep the signatures. The release smoke test uses it too, to update through the
sidecar before anything is published ([release-side.md](release-side.md)). In `keyless`
mode an air-gapped host also needs `trust.keyless.trustedRootFile`
([trust-modes.md](trust-modes.md)).

## Private repositories and tokens

| Where | Setting |
| --- | --- |
| Sidecar | `release.feed.tokenFile`: a file with the token (trimmed). Read when the feed is accessed, registered with the redactor, never logged or returned. |
| SDK | `token` option of `checkFeed`. Store it in the app's secret store, bound to the origin it was issued for ([app-integration.md](app-integration.md)). |
| Smoke (`upgrade-from`) | input `token` of the `smoke` action; `RELEASE_TOKEN` or `GITHUB_TOKEN` for the CLI |

The token:

- travels only as the `Authorization` header (`token` scheme for Forgejo/Gitea, `Bearer`
  otherwise), never in a URL;
- is sent only to the feed's own origin (`https://api.github.com` for `github`, the origin
  of `url` for the others);
- is dropped at the first redirect to another origin and never added again, even when a
  later redirect returns to the feed origin;
- is not sent at all to an asset URL that is on another origin from the start.

Give the token read access only. As a guide: on GitHub a fine-grained token with read
access to the repository contents; on GitLab `read_api`; on Forgejo and Gitea
`read:repository`. A `not_found` answer for a private repository usually means the token
has no access to it.

Source mode uses `source.tokenFile` (default: the feed token) for the archive download
with the same origin rules.

## Size caps and timeouts

| What | Cap | Time limit |
| --- | --- | --- |
| Release list, feed index | 8 MiB | 10 s |
| `release.json` | 64 KiB | 15 s |
| `release.json.sigstore.json` | 256 KiB | 15 s |
| Source archive (source mode) | `source.maxArchiveMb` (200 MiB) | 15 min |

Bodies are read as streams and abandoned as soon as they pass the cap; a declared
`Content-Length` above the cap is refused before reading. A time limit covers the whole
request including its redirects. The list and the documents are cached for
`release.cacheSeconds`; `?refresh=true` on `GET /v1/releases` reads the feed again.

## Address rules (SSRF protection)

A feed URL can come from an admin through the app, so a feed request must not be able to
reach the internal network, the Docker host or a cloud metadata service and report back
what it found. The rules apply to the sidecar, to the SDK's feed check and to the release
tools' `upgrade-from`:

1. **https only**, no credentials in URLs.
2. **Every address must be public.** The host is resolved inside the socket's own lookup,
   and the connection is refused unless **every** address the name resolves to is public.
   Literal IP addresses are checked without a lookup. Unless the host is on the allowlist
   described below, names that only exist on local networks are refused before any
   lookup: `localhost`, names without a dot, and names ending in `.localhost`, `.local`,
   `.internal`, `.intranet`, `.lan`, `.home`, `.home.arpa` or `.localdomain`.
3. **No connection pooling.** Every connection runs the guarded lookup, so a name that
   resolves to another address a moment later (DNS rebinding) gains nothing.
4. **Redirects by hand**: at most 3, https only. The release list follows redirects within
   the same origin only. Asset downloads may follow a redirect to another origin (GitHub
   serves assets from a CDN), with the token dropped as described above; the new host must
   pass rule 2.

Refused address ranges:

| Class | IPv4 | IPv6 |
| --- | --- | --- |
| unspecified | `0.0.0.0/8` | `::` |
| loopback | `127.0.0.0/8` | `::1` |
| private | `10.0.0.0/8`, `100.64.0.0/10`, `172.16.0.0/12`, `192.168.0.0/16` | `fc00::/7`, `fec0::/10` |
| link-local (cloud metadata) | `169.254.0.0/16` | `fe80::/10` |
| multicast | `224.0.0.0/4` | `ff00::/8` |
| reserved, documentation, benchmarking | `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `240.0.0.0/4` (includes `255.255.255.255`) | `2001::/32` (Teredo), `2001:db8::/32`, everything outside `2000::/3` |
| embedded IPv4 | | `::ffff:0:0/96` (mapped), `::/96` (compatible), `64:ff9b::/96` (NAT64) and `2002::/16` (6to4) are judged by the IPv4 address they carry |

**Private hosts the operator allows.** A host on the allowlist may resolve to `private`
and `loopback` addresses, never to link-local, multicast, reserved or unspecified ones. The
match is on the exact host name, lowercase.

| Component | Setting |
| --- | --- |
| Sidecar | `release.feed.allowPrivateNetwork: true` puts the host of `release.feed.url` on the allowlist. Nothing else: a redirect or an asset URL to another private host is still refused. |
| SDK | `allowPrivateHosts: ["git.internal.example"]` |
| Release tools (`upgrade-from` of the smoke) | input `feed-allow-private-host` of the `smoke` action, or `--feed-allow-private-host <host>` (repeatable) of `cicd-updater release smoke` |

**Failures say nothing about the network.** A refused address, a DNS failure and a failed
connection all produce `network` without detail. Only a TLS error of a host that was
allowed and answered is named (for example `CERT_HAS_EXPIRED`).

## Errors

| Code | When |
| --- | --- |
| `unauthorized` | HTTP 401 |
| `forbidden` | HTTP 403 that is not a rate limit |
| `rate_limited` | HTTP 429, or 403 with `X-RateLimit-Remaining: 0`; `retryAt` from `Retry-After` (seconds or a date) or `X-RateLimit-Reset` |
| `not_found` | HTTP 404 (for a private repository usually a token without access); a missing file in a `file` feed |
| `server_error` | HTTP 5xx |
| `network` | DNS failure, refused address, connection failure; detail only for TLS errors of an allowed host |
| `timeout` | the time limit passed |
| `invalid_response` | another non-success status (detail `status`), a body that is not JSON (`not_json`), over the cap (`too_large`), a list or index that does not match (`schema`), a URL that cannot be parsed (`url`) |
| `redirect` | a redirect that is not followed: more than 3, to http or to a URL with credentials, a list redirect to another origin, a missing `Location`; also a feed URL that is not https (`not_https`) |
| `no_release` | the feed lists no release whose tag renders a version |

Where they appear:

- Sidecar API: `502` problem `feed_unavailable` with the extension `feedError: "<code>"`.
  A version that is not in the feed is `404 release_not_found`, and so is a release
  without `release.json` in image mode ([http-api.md](http-api.md)).
- SDK: `checkFeed` returns `{ ok: false, error }` with a `FeedError` (`code`, `status`,
  `retryAt`, `detail`).
- Release tools: the error message names the code; the step fails.

[troubleshooting.md](troubleshooting.md) lists remedies.
