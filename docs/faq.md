# FAQ

## Why not automatic updates like Watchtower?

Tools of that kind watch a registry and replace a container when its tag points at a new
image. That fits stateless services. It does not fit an app with a database, for four
reasons:

- **A tag is not a release.** A moved tag says nothing about who built the image. cicd-updater
  installs only digests named in a signed `release.json`, verifies their signatures, pulls
  exactly those digests and writes digest-pinned references.
- **An update needs a plan.** Before anything is replaced, the sidecar checks the minimum
  version, manual steps, required env keys and the platform, takes a backup and verifies
  it, and records the schema state with a migration probe.
- **Failure needs a rule.** After a failed update the sidecar rolls back only when it is
  certain that the new version did not change the data; otherwise it stops the app, keeps
  the backup and tells the operator exactly what to do. Replacing a container and hoping
  is not an option once a migration ran.
- **People need to know.** An admin schedules the update for a time with a lead time,
  every signed-in user sees the countdown and the maintenance page, and the result goes
  into the app's audit log.

The sidecar never installs on its own. `release.checkIntervalHours` only refreshes the
list of releases; an update always starts from a request through the API or the CLI.

## Why no Kubernetes?

Kubernetes has its own lifecycle model: rollouts, readiness gates, operators, GitOps
controllers. cicd-updater solves the problem of a single host that runs an app with
Docker Compose and has none of that. Supporting both would mean two different engines.
Kubernetes, Docker Swarm, Nomad and remote Docker hosts are not supported in 1.0
([compatibility.md](compatibility.md)).

## Why does the sidecar hold the Docker socket, and what does that mean?

To update the app it must stop, pull, recreate and inspect containers, and run backup and
probe commands inside the database container. All of that goes through the Docker API,
and access to the Docker API is root on the host. There is no smaller permission that
would do the job.

So the design starts from that fact ([security.md](security.md)): the sidecar is opt-in
(its own Compose profile), listens only on the internal network with no published port,
requires a bearer token, offers no endpoint that runs a command or chooses an image,
installs only signed releases from the configured feed, verifies signatures in an
isolated container without the socket, holds no application credentials, and is pinned by
the operator and never updated by itself. Running it as a non-root user in the socket's
group would not change what it can do, so the documentation does not pretend it would.

## Why does the sidecar not update itself?

The container that holds the Docker socket is the most powerful component on the host. If
it could replace itself, whoever controls its release feed could replace it too. So it
changes only by an operator's action: verify the new image with cosign, pin its digest,
recreate the service ([upgrading-the-updater.md](upgrading-the-updater.md)).

The sidecar also refuses to run an update while its own service would take its image from
a key it rewrites (blocker `updater_image_unpinned`), so it can never install itself by
accident. With `selfCheck.enabled: true` it reads the cicd-updater feed once a day and
reports a newer version in `GET /v1/state` (`updater.latestAvailable`); it never installs
it.

## Why sign `release.json` in addition to the images?

Image signatures prove that each digest was built by the release workflow. They do not
prove which digest belongs to which service, or which constraints belong to the release.
With image signatures alone, someone who can edit release assets but cannot run the
workflow could:

- swap the digests of two images of the same release (both validly signed);
- lower `minimumFromVersion`, so that an installation skips a required intermediate
  release;
- drop `manualSteps.required`, so that the sidecar installs a release that needs a manual
  change first;
- remove a `requires.env` entry.

The signed document binds version, tag, the digest of each image key, the minimum version,
manual steps and requirements together, with the same identity or key as the images. The
sidecar verifies it before it reads any field ([release-json.md](release-json.md)).

## Why not attach `release.json` as an attestation to the images?

That was considered and rejected for 1.0:

- an attestation belongs to one image, but a release has several;
- it needs registry support for attestations, which varies, especially on self-hosted
  registries ([registries.md](registries.md));
- the sidecar needs the document **before** it knows which images to look at; a release
  asset next to the release is fetched with the feed and verified with
  `cosign verify-blob`.

The release side does attach SPDX SBOMs to the platform images as attestations. The
sidecar does not evaluate them.

## How do I use a private repository?

Two settings, both read-only tokens:

- the feed: `release.feed.tokenFile` with a token that can read the releases
  ([feeds.md](feeds.md)). It is sent only to the feed's own origin and dropped on a
  redirect to another origin;
- the images: `docker.registryAuthFile`, a Docker `config.json` with an `auths` object
  only ([registries.md](registries.md)).

For source mode, `source.tokenFile` defaults to the feed token. Run
`cicd-updater doctor`: it reads the feed with the token and the manifest of each running
image with the registry credentials.

## Can I use it on an air-gapped host?

Yes, with these parts (to be verified in the end-to-end run):

- **Feed**: the `file` feed. Copy `index.json`, each `release.json` and its bundle into a
  directory mounted into the sidecar ([feeds.md](feeds.md#file)).
- **Images**: a registry the host can reach. Copy the images with their signatures, for
  example with `cosign copy`, and point each image key at it with
  `images.<key>.repository` ([registries.md](registries.md#mirrors-imageskeyrepository)).
- **Trust**: `key` mode with `transparencyLog: false` needs nothing but the registry. In
  `keyless` mode, set `trust.keyless.trustedRootFile` to a Sigstore trusted root file that
  you copy onto the host and keep current ([trust-modes.md](trust-modes.md)).

## My repository builds several images. How do I release them?

One release covers all of them: one tag, one version, one `release.json` with one entry per
image key (up to 32). Build each image with its own `build` step, pass all of them to
`publish` in one `images` JSON, and map the Compose services to the keys in `updater.yaml`:

```yaml
services:
  - { name: api,    image: app, imageVar: APP_IMAGE, startOrder: 1 }
  - { name: worker, image: app, imageVar: APP_IMAGE, startOrder: 2 }
  - { name: web,    image: web, imageVar: WEB_IMAGE, startOrder: 3 }
```

A service whose image may be missing from a release can be marked `optional: true`; it
then keeps its current image.

## My repository holds several apps with their own versions.

Give each app its own tag pattern, for example `notes-v{version}` and `admin-v{version}`
(`tag-pattern` on the release side, `release.tagPattern` on the hosts). Each sidecar
ignores the tags that do not render from its pattern, so it sees only its app's releases.
The keyless identity contains the tag, so a signature for one app's tag does not verify
for another. Note that the feed reads only the 30 newest releases of the repository, which
are shared by all apps.

## What happens without the sidecar?

Nothing changes for the app. The sidecar is optional:

- The app runs as before. If it uses the SDK, `client.state()` resolves `null` when no
  sidecar answers, and the app can show manual update steps instead.
- The app can still check the feed and notify admins of new releases with the SDK's
  `checkFeed` ([sdk.md](sdk.md)).
- Updating by hand stays supported: take the digest-pinned references from
  `release.json` (`<repository>:<tag>@<digest>`), write them into the env file, then
  `docker compose pull` and `docker compose up -d`. Verify the images with cosign first
  ([ci/github.md](ci/github.md#verify-a-release-by-hand)).

## Can I go back to an older version?

Not through the sidecar. It installs only versions strictly newer than the running one; a
downgrade could start old code on a schema a newer version changed. Within a run it rolls
back only when that is certain ([state-machine.md](state-machine.md)). Going back by hand
means restoring a backup and the previous env lines; `cicd-updater recover show` prints the
commands for a run that ended in `needs_attention`
([backups-and-recovery.md](backups-and-recovery.md)).
