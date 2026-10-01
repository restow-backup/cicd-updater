import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Publishing the release (design 2.2, 10.6 `release-json`): a draft release
 * gets its assets (release.json, its bundle, checksums, ...) and is published
 * only then. A release that is already published is never changed again (a
 * correction is a new version).
 *
 *   github  REST API, drafts, uploads.github.com
 *   gitea   Forgejo/Gitea API (`/api/v1`), drafts, multipart attachments
 *   gitlab  generic package registry for the files, then the release with
 *           asset links (GitLab has no drafts: the release appears last)
 */

export type ReleaseHostType = "github" | "gitea" | "gitlab";

export interface PublishInput {
  host: ReleaseHostType;
  /** API base: `https://api.github.com`, `https://git.example.com/api/v1`, `https://gitlab.example.com/api/v4`. */
  apiUrl: string;
  /** `owner/repo`, or the GitLab project path. */
  repository: string;
  token: string;
  tag: string;
  name: string;
  notes: string | null;
  prerelease: boolean;
  files: readonly string[];
  /** Publish the release (false: leave the draft for a later step). */
  publish: boolean;
  /** GitLab: send the token as JOB-TOKEN (CI_JOB_TOKEN) instead of PRIVATE-TOKEN. */
  jobToken?: boolean;
  fetch?: typeof fetch;
}

export interface PublishResult {
  url: string | null;
  uploaded: string[];
}

function contentType(file: string): string {
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".tgz") || file.endsWith(".tar.gz")) return "application/gzip";
  if (file.endsWith(".yaml") || file.endsWith(".yml")) return "application/yaml";
  return "application/octet-stream";
}

class Http {
  constructor(
    private readonly fetcher: typeof fetch,
    private readonly headers: Record<string, string>,
  ) {}

  async json<T>(
    method: string,
    url: string,
    body?: unknown,
    okStatuses: number[] = [200, 201],
  ): Promise<{ status: number; body: T }> {
    const response = await this.fetcher(url, {
      method,
      headers: {
        ...this.headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
    });
    const text = await response.text();
    if (!okStatuses.includes(response.status)) {
      throw new Error(
        `${method} ${new URL(url).pathname} answered HTTP ${response.status}: ${text.slice(0, 300)}`,
      );
    }
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  }

  async raw(
    method: string,
    url: string,
    body: Uint8Array | FormData,
    headers: Record<string, string>,
    okStatuses: number[] = [200, 201],
  ): Promise<void> {
    const response = await this.fetcher(url, {
      method,
      headers: { ...this.headers, ...headers },
      body,
      redirect: "error",
    });
    if (!okStatuses.includes(response.status)) {
      throw new Error(
        `${method} ${new URL(url).pathname} answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }
    await response.body?.cancel().catch(() => undefined);
  }
}

interface HostedRelease {
  id: number;
  draft?: boolean;
  html_url?: string;
  upload_url?: string;
  tag_name?: string;
  assets?: { id: number; name: string }[];
}

async function github(input: PublishInput, http: Http): Promise<PublishResult> {
  const api = `${input.apiUrl.replace(/\/+$/, "")}/repos/${input.repository}`;
  const { body: releases } = await http.json<HostedRelease[]>(
    "GET",
    `${api}/releases?per_page=100`,
  );
  let release = releases.find((candidate) => candidate.tag_name === input.tag) ?? null;
  if (release && !release.draft) {
    throw new Error(
      `The release ${input.tag} is already published; a published release is not changed (make a new version).`,
    );
  }
  if (!release) {
    release = (
      await http.json<HostedRelease>("POST", `${api}/releases`, {
        tag_name: input.tag,
        name: input.name,
        body: input.notes ?? "",
        draft: true,
        prerelease: input.prerelease,
      })
    ).body;
  }
  const uploads = (
    release.upload_url ??
    `https://uploads.github.com/repos/${input.repository}/releases/${release.id}/assets{?name,label}`
  ).replace(/\{.*\}$/, "");
  const uploaded: string[] = [];
  for (const file of input.files) {
    const name = path.basename(file);
    const existing = release.assets?.find((asset) => asset.name === name);
    if (existing) {
      await http.json("DELETE", `${api}/releases/assets/${existing.id}`, undefined, [204]);
    }
    await http.raw("POST", `${uploads}?name=${encodeURIComponent(name)}`, await fs.readFile(file), {
      "content-type": contentType(name),
    });
    uploaded.push(name);
  }
  if (input.publish) {
    const { body } = await http.json<HostedRelease>("PATCH", `${api}/releases/${release.id}`, {
      draft: false,
      prerelease: input.prerelease,
      ...(input.notes ? { body: input.notes } : {}),
    });
    return { url: body.html_url ?? null, uploaded };
  }
  return { url: release.html_url ?? null, uploaded };
}

async function gitea(input: PublishInput, http: Http): Promise<PublishResult> {
  const api = `${input.apiUrl.replace(/\/+$/, "")}/repos/${input.repository}`;
  const { body: releases } = await http.json<HostedRelease[]>(
    "GET",
    `${api}/releases?draft=true&limit=50`,
  );
  let release = releases.find((candidate) => candidate.tag_name === input.tag) ?? null;
  if (release && !release.draft) {
    throw new Error(
      `The release ${input.tag} is already published; a published release is not changed (make a new version).`,
    );
  }
  if (!release) {
    release = (
      await http.json<HostedRelease>("POST", `${api}/releases`, {
        tag_name: input.tag,
        name: input.name,
        body: input.notes ?? "",
        draft: true,
        prerelease: input.prerelease,
      })
    ).body;
  }
  const uploaded: string[] = [];
  for (const file of input.files) {
    const name = path.basename(file);
    const existing = release.assets?.find((asset) => asset.name === name);
    if (existing) {
      await http.json(
        "DELETE",
        `${api}/releases/${release.id}/assets/${existing.id}`,
        undefined,
        [204],
      );
    }
    const form = new FormData();
    form.append(
      "attachment",
      new Blob([await fs.readFile(file)], { type: contentType(name) }),
      name,
    );
    await http.raw(
      "POST",
      `${api}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      form,
      {},
    );
    uploaded.push(name);
  }
  if (input.publish) {
    const { body } = await http.json<HostedRelease>("PATCH", `${api}/releases/${release.id}`, {
      draft: false,
      prerelease: input.prerelease,
    });
    return { url: body.html_url ?? null, uploaded };
  }
  return { url: release.html_url ?? null, uploaded };
}

async function gitlab(input: PublishInput, http: Http): Promise<PublishResult> {
  const project = encodeURIComponent(input.repository);
  const api = `${input.apiUrl.replace(/\/+$/, "")}/projects/${project}`;
  const existing = await http.json<unknown>(
    "GET",
    `${api}/releases/${encodeURIComponent(input.tag)}`,
    undefined,
    [200, 404],
  );
  if (existing.status === 200) {
    throw new Error(
      `The release ${input.tag} already exists; a published release is not changed (make a new version).`,
    );
  }
  const version = input.tag.replace(/[^0-9A-Za-z._-]/g, "_");
  const links: { name: string; url: string; link_type: string; direct_asset_path: string }[] = [];
  const uploaded: string[] = [];
  for (const file of input.files) {
    const name = path.basename(file);
    const url = `${api}/packages/generic/release-assets/${version}/${encodeURIComponent(name)}`;
    await http.raw("PUT", url, await fs.readFile(file), { "content-type": contentType(name) });
    links.push({ name, url, link_type: "other", direct_asset_path: `/${name}` });
    uploaded.push(name);
  }
  if (!input.publish) {
    return { url: null, uploaded };
  }
  const { body } = await http.json<{ _links?: { self?: string } }>("POST", `${api}/releases`, {
    tag_name: input.tag,
    name: input.name,
    description: input.notes ?? "",
    assets: { links },
  });
  return { url: body._links?.self ?? null, uploaded };
}

export async function publishRelease(input: PublishInput): Promise<PublishResult> {
  const fetcher = input.fetch ?? fetch;
  const headers: Record<string, string> =
    input.host === "github"
      ? {
          authorization: `Bearer ${input.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "cicd-updater-release",
        }
      : input.host === "gitea"
        ? {
            authorization: `token ${input.token}`,
            accept: "application/json",
            "user-agent": "cicd-updater-release",
          }
        : {
            [input.jobToken ? "job-token" : "private-token"]: input.token,
            accept: "application/json",
            "user-agent": "cicd-updater-release",
          };
  const http = new Http(fetcher, headers);
  switch (input.host) {
    case "github":
      return await github(input, http);
    case "gitea":
      return await gitea(input, http);
    case "gitlab":
      return await gitlab(input, http);
  }
}
