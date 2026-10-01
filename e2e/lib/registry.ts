import { q } from "./exec.js";
import { REGISTRY, sh, UPDATER, WORK } from "./host.js";

/**
 * Direct registry API calls (distribution/registry v3 over TLS with the test CA), for
 * scenarios that change what the registry holds after a release was published.
 */

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** Run a script in the sidecar image's node; E2E_AUTH (user:password) for the auth registry. */
async function node(script: string, args: string[]): Promise<string> {
  return (
    await sh(
      `AUTH=$(sed -n 's/.*"auth":"\\([^"]*\\)".*/\\1/p' ${WORK}/pki/registry-auth.json)
docker run --rm --network host -e NODE_EXTRA_CA_CERTS=${WORK}/pki/ca.crt -e AUTH="$AUTH" -v ${WORK}/pki:${WORK}/pki:ro --entrypoint node ${UPDATER} --input-type=module -e ${q(script)} ${args.map(q).join(" ")}`,
    )
  ).stdout.trim();
}

/** Delete a manifest by tag or digest (`name` without the registry); returns the deleted digest. */
export async function deleteManifest(
  name: string,
  reference: string,
  registry = REGISTRY,
): Promise<string> {
  return node(
    `
const [base, reference, accept] = process.argv.slice(1);
const auth = base.includes(":5444/") ? { authorization: "Basic " + process.env.AUTH } : {};
const head = await fetch(base + "/manifests/" + reference, { method: "HEAD", headers: { accept, ...auth } });
if (!head.ok) throw new Error("HEAD " + reference + ": " + head.status);
const digest = head.headers.get("docker-content-digest");
const removed = await fetch(base + "/manifests/" + digest, { method: "DELETE", headers: auth });
if (removed.status !== 202) throw new Error("DELETE " + digest + ": " + removed.status);
process.stdout.write(digest);
`,
    [`https://${registry}/v2/${name}`, reference, ACCEPT],
  );
}

/** The tags of a repository. */
export async function tags(name: string, registry = REGISTRY): Promise<string[]> {
  const text = await node(
    `
const response = await fetch(process.argv[1]);
process.stdout.write(response.ok ? JSON.stringify((await response.json()).tags ?? []) : "[]");
`,
    [`https://${registry}/v2/${name}/tags/list`],
  );
  return JSON.parse(text) as string[];
}
