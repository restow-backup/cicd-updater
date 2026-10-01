import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { q, type Result, type RunOptions, run, waitFor } from "./exec.js";

/**
 * The e2e "host": a Docker-in-Docker container with its own daemon. Everything a
 * scenario does (registries, the app, the sidecar, the verifier, builds) runs inside
 * it, so the tests change nothing on the machine that runs them: the registries' test
 * CA is trusted by the inner daemon only (/etc/docker/certs.d in the host container)
 * and by a derived sidecar image (`cicd-updater:e2e-ca`), the cosign keys exist only
 * inside the host container and disappear with it. The inner daemon runs the classic
 * image store or the containerd image store (E2E_IMAGE_STORE).
 *
 * Inside the host:
 *   10.213.0.1:5443   distribution/registry v3, TLS, open          (REGISTRY)
 *   10.213.0.1:5444   distribution/registry v3, TLS, htpasswd       (AUTH_REGISTRY)
 *   /srv/e2e/pki      test CA and the registry certificate
 *   /srv/e2e/keys     cosign key pairs "main" and "other" (generated per run)
 *   /srv/e2e/projects one Compose project per scenario
 *   /repo             this repository, read-only
 */

export const REPO = path.resolve(import.meta.dirname, "..", "..");
export const STORE: "classic" | "containerd" =
  process.env.E2E_IMAGE_STORE === "containerd" ? "containerd" : "classic";
export const HOST = process.env.E2E_HOST ?? `cicd-updater-e2e-${STORE}`;
/** Docker 29.8.2, the Docker CLI version of the sidecar image. */
export const DIND_IMAGE =
  "docker:29.8.2-dind@sha256:7dcdfc4a20246236f558175182ccace1eb15a41bd3eb119dd2284f393498b7c1";
/** The sidecar image under test, built outside (docker/Dockerfile). */
export const SIDECAR_IMAGE = process.env.E2E_SIDECAR_IMAGE ?? "cicd-updater:e2e";
/** Inside the host: the sidecar image plus the test CA. */
export const UPDATER = "cicd-updater:e2e-ca";
export const BRIDGE = "10.213.0.1";
export const REGISTRY = `${BRIDGE}:5443`;
export const AUTH_REGISTRY = `${BRIDGE}:5444`;
export const WORK = "/srv/e2e";
export const KEYS = `${WORK}/keys`;
export const PROJECTS = `${WORK}/projects`;

/** Third-party images the scenarios use (pulled once into the host's image cache). */
export const IMAGES = {
  registry: "registry:3.0.0",
  postgres: "postgres:17-alpine",
  mariadb: "mariadb:11.8",
  mysql: "mysql:8.4",
  node: "node:24-alpine",
  alpine: "alpine:3.22",
  python: "python:3.13-slim",
  nginx: "nginx:1.29-alpine",
  caddy: "caddy:2-alpine",
  buildkit: "moby/buildkit:buildx-stable-1",
} as const;
/** DOCKER_CONFIG of the release CLI containers: the registry login and the buildx builder. */
export const DOCKER_CONFIG = `${WORK}/docker`;

export interface ShOptions extends RunOptions {
  /** Extra environment for the shell inside the host (not visible in argv). */
  shellEnv?: Record<string, string>;
}

/** Run a shell script inside the host (`set -eu`, pipefail). */
export async function sh(script: string, options: ShOptions = {}): Promise<Result> {
  const envArgs = Object.keys(options.shellEnv ?? {}).flatMap((name) => ["-e", name]);
  return run(
    ["docker", "exec", "-i", ...envArgs, HOST, "sh", "-c", `set -eu\nset -o pipefail\n${script}`],
    { ...options, env: { ...process.env, ...(options.shellEnv ?? {}) } },
  );
}

/** `docker <args>` inside the host. */
export function docker(args: readonly string[], options: ShOptions = {}): Promise<Result> {
  return sh(`docker ${args.map(q).join(" ")}`, options);
}

export async function writeFile(file: string, content: string, mode = "644"): Promise<void> {
  await sh(
    `mkdir -p ${q(path.posix.dirname(file))} && cat > ${q(file)} && chmod ${mode} ${q(file)}`,
    {
      input: content,
    },
  );
}

export async function readFile(file: string): Promise<string> {
  return (await sh(`cat ${q(file)}`)).stdout;
}

export async function exists(file: string): Promise<boolean> {
  return (await sh(`test -e ${q(file)}`, { allowFail: true })).code === 0;
}

let platformCache: string | null = null;
/** `linux/amd64` or `linux/arm64`: the host's platform. */
export async function platform(): Promise<string> {
  if (!platformCache) {
    const machine = (await sh("uname -m")).stdout.trim();
    platformCache = machine === "aarch64" || machine === "arm64" ? "linux/arm64" : "linux/amd64";
  }
  return platformCache;
}

/** Load an image from the outer daemon when it has it; otherwise pull it inside. */
async function ensureImage(ref: string): Promise<void> {
  if ((await docker(["image", "inspect", ref], { allowFail: true })).code === 0) {
    return;
  }
  const outer = await run(["docker", "image", "inspect", ref], { allowFail: true });
  if (outer.code === 0) {
    const saved = await run(
      ["sh", "-c", `docker save ${q(ref)} | docker exec -i ${q(HOST)} docker load -q`],
      {
        allowFail: true,
        timeoutMs: 600_000,
      },
    );
    if (saved.code === 0) {
      return;
    }
  }
  await docker(["pull", "-q", ref], { timeoutMs: 600_000 });
}

/** Start the host from scratch (keeps only the image cache volume). */
export async function startHost(): Promise<void> {
  await run(["docker", "rm", "-f", HOST], { allowFail: true });
  const daemon = {
    bip: `${BRIDGE}/24`,
    "default-address-pools": [{ base: "10.214.0.0/16", size: 24 }],
    features: { "containerd-snapshotter": STORE === "containerd" },
  };
  await run([
    "docker",
    "run",
    "-d",
    "--privileged",
    "--name",
    HOST,
    "--env",
    "DOCKER_TLS_CERTDIR=",
    "--env",
    `DAEMON_JSON=${JSON.stringify(daemon)}`,
    "--volume",
    `cicd-updater-e2e-${STORE}:/var/lib/docker`,
    "--volume",
    `${REPO}:/repo:ro`,
    "--entrypoint",
    "sh",
    DIND_IMAGE,
    "-c",
    'mkdir -p /etc/docker && printf "%s" "$DAEMON_JSON" > /etc/docker/daemon.json && exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock',
  ]);
  await waitFor(
    "the e2e Docker daemon",
    async () =>
      (await sh("docker info > /dev/null", { allowFail: true })).code === 0 ? true : undefined,
    { timeoutMs: 120_000 },
  );
  const info = (await docker(["info", "--format", "{{json .DriverStatus}}"])).stdout;
  const containerd = info.includes("io.containerd.snapshotter");
  if (containerd !== (STORE === "containerd")) {
    throw new Error(`the host runs the wrong image store: ${info.trim()}`);
  }

  // Leftovers of an earlier run in the cached /var/lib/docker.
  await sh(`
docker ps -aq | xargs -r docker rm -f > /dev/null
docker volume ls -q | xargs -r docker volume rm -f > /dev/null
docker network prune -f > /dev/null
rm -rf ${WORK} && mkdir -p ${WORK}/pki ${KEYS} ${PROJECTS}
`);

  // The test CA, the registry certificate and the inner daemon's trust for both registries.
  const registryPassword = randomBytes(12).toString("hex");
  await sh(
    `
cd ${WORK}/pki
apk add --no-cache apache2-utils > /dev/null
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.crt -days 2 -subj "/CN=cicd-updater e2e CA" 2> /dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout registry.key -out registry.csr -subj "/CN=${BRIDGE}" 2> /dev/null
printf 'subjectAltName=IP:${BRIDGE}\\nextendedKeyUsage=serverAuth\\n' > ext.cnf
openssl x509 -req -in registry.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out registry.crt -days 2 -extfile ext.cnf 2> /dev/null
chmod 644 registry.key
htpasswd -Bbn e2e "$REGISTRY_PASSWORD" > htpasswd
for registry in ${REGISTRY} ${AUTH_REGISTRY}; do
  mkdir -p /etc/docker/certs.d/$registry && cp ca.crt /etc/docker/certs.d/$registry/ca.crt
done
printf '{"auths":{"${AUTH_REGISTRY}":{"auth":"%s"}}}' "$(printf 'e2e:%s' "$REGISTRY_PASSWORD" | base64 -w0)" > registry-auth.json
`,
    { shellEnv: { REGISTRY_PASSWORD: registryPassword } },
  );

  for (const ref of Object.values(IMAGES)) {
    await ensureImage(ref);
  }
  await run(
    ["sh", "-c", `docker save ${q(SIDECAR_IMAGE)} | docker exec -i ${q(HOST)} docker load -q`],
    {
      timeoutMs: 600_000,
    },
  );
  await sh(`
cd ${WORK}/pki
docker tag ${q(SIDECAR_IMAGE)} cicd-updater:e2e
printf 'FROM cicd-updater:e2e\\nCOPY ca.crt /tmp/e2e-ca.crt\\nRUN cat /tmp/e2e-ca.crt >> /etc/ssl/certs/ca-certificates.crt && rm /tmp/e2e-ca.crt\\n' > Dockerfile.ca
docker build -q -t ${UPDATER} -f Dockerfile.ca . > /dev/null
`);

  const registryArgs = (name: string, port: number, auth: boolean) =>
    [
      "docker run -d --restart always",
      `--name ${name} -p ${port}:${port}`,
      `-v ${WORK}/pki:/pki:ro`,
      `-e REGISTRY_HTTP_ADDR=0.0.0.0:${port}`,
      "-e REGISTRY_HTTP_TLS_CERTIFICATE=/pki/registry.crt",
      "-e REGISTRY_HTTP_TLS_KEY=/pki/registry.key",
      "-e REGISTRY_STORAGE_DELETE_ENABLED=true",
      ...(auth
        ? [
            "-e REGISTRY_AUTH=htpasswd",
            "-e REGISTRY_AUTH_HTPASSWD_REALM=e2e",
            "-e REGISTRY_AUTH_HTPASSWD_PATH=/pki/htpasswd",
          ]
        : []),
      IMAGES.registry,
    ].join(" ");
  await sh(`
${registryArgs("e2e-registry", 5443, false)} > /dev/null
${registryArgs("e2e-auth-registry", 5444, true)} > /dev/null
`);
  await waitFor("the registries", async () => {
    const result = await sh(
      `wget -q -O /dev/null --no-check-certificate https://${REGISTRY}/v2/
{ wget -q -O /dev/null --no-check-certificate https://${AUTH_REGISTRY}/v2/ 2>&1 || true; } | grep -q 401`,
      { allowFail: true },
    );
    return result.code === 0 ? true : undefined;
  });
  await sh(`docker login -u e2e --password-stdin ${AUTH_REGISTRY} > /dev/null`, {
    input: registryPassword,
  });
  // Push by digest needs a BuildKit builder (the docker driver cannot); it trusts the test CA.
  await sh(`
mkdir -p ${DOCKER_CONFIG}
cp /root/.docker/config.json ${DOCKER_CONFIG}/config.json
printf '[registry."${REGISTRY}"]\n  ca = ["${WORK}/pki/ca.crt"]\n[registry."${AUTH_REGISTRY}"]\n  ca = ["${WORK}/pki/ca.crt"]\n' > ${WORK}/pki/buildkitd.toml
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v ${DOCKER_CONFIG}:/root/.docker -v ${WORK}/pki:${WORK}/pki:ro \
  --entrypoint docker ${UPDATER} buildx create --name e2e --driver docker-container \
  --driver-opt image=${IMAGES.buildkit} --driver-opt network=host \
  --buildkitd-config ${WORK}/pki/buildkitd.toml --use --bootstrap > /dev/null 2>&1
`);

  // The SDK tarball for the node-postgres example (its release asset does not exist yet).
  await sh(`mkdir -p ${WORK}/sdk`);
  const sdk = await sdkTarball();
  try {
    await run([
      "docker",
      "cp",
      sdk.file,
      `${HOST}:${WORK}/sdk/restow-backup-cicd-updater-1.0.0.tgz`,
    ]);
  } finally {
    await sdk.cleanup();
  }

  // Two cosign key pairs: "main" signs releases, "other" plays the attacker.
  await sh(
    `
for name in main other; do
  mkdir -p ${KEYS}/$name
  docker run --rm -v ${KEYS}/$name:/k -w /k -e COSIGN_PASSWORD -e HOME=/tmp --entrypoint cosign ${UPDATER} generate-key-pair > /dev/null 2>&1
  chmod 644 ${KEYS}/$name/cosign.pub
done
printf '%s' "$COSIGN_PASSWORD" > ${KEYS}/password
`,
    { shellEnv: { COSIGN_PASSWORD: randomBytes(16).toString("hex") } },
  );
}

/** E2E_SDK_TARBALL, or the SDK built and packed from this repository now. */
async function sdkTarball(): Promise<{ file: string; cleanup: () => Promise<void> }> {
  if (process.env.E2E_SDK_TARBALL) {
    return { file: process.env.E2E_SDK_TARBALL, cleanup: async () => undefined };
  }
  const out = await mkdtemp(path.join(tmpdir(), "cicd-updater-e2e-sdk-"));
  const cleanup = () => rm(out, { recursive: true, force: true });
  try {
    await run(["pnpm", "--filter", "@restow-backup/cicd-updater", "build"]);
    await run([
      "sh",
      "-c",
      `cd ${q(path.join(REPO, "packages", "sdk"))} && pnpm pack --pack-destination ${q(out)}`,
    ]);
    const [file] = (await readdir(out)).filter((name) => name.endsWith(".tgz"));
    if (!file) {
      throw new Error("pnpm pack wrote no tarball");
    }
    return { file: path.join(out, file), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Remove the host (and with it every key, project and registry content). */
export async function stopHost(): Promise<void> {
  if (process.env.E2E_KEEP_HOST === "1") {
    return;
  }
  await run(["docker", "rm", "-f", "-v", HOST], { allowFail: true });
}
