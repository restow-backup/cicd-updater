import { isPlainVersion } from "./semver.js";

/**
 * Release tags and the keyless signing identity (design 3.1, 4.6).
 *
 * `release.tagPattern` contains `{version}` exactly once (default `v{version}`).
 * The keyless certificate identity is computed per release and passed to cosign
 * as an exact identity, never as a regular expression.
 */

export const DEFAULT_TAG_PATTERN = "v{version}";
const TAG_PATTERN_TEXT = /^[A-Za-z0-9._/-]*\{version\}[A-Za-z0-9._/-]*$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** Whether a tag pattern is acceptable: `{version}` exactly once, otherwise `[A-Za-z0-9._/-]`. */
export function isValidTagPattern(pattern: string): boolean {
  return (
    typeof pattern === "string" &&
    pattern.length <= 128 &&
    TAG_PATTERN_TEXT.test(pattern) &&
    pattern.split("{version}").length === 2
  );
}

/** The tag of a plain version under a pattern; throws for an invalid pattern or version. */
export function renderTag(pattern: string, version: string): string {
  if (!isValidTagPattern(pattern)) {
    throw new TypeError(`invalid tag pattern: ${pattern}`);
  }
  if (!isPlainVersion(version)) {
    throw new TypeError(`not a plain version: ${version}`);
  }
  return pattern.replace("{version}", version);
}

/** The plain version a tag renders from under a pattern; null when it does not. */
export function versionFromTag(pattern: string, tag: string): string | null {
  if (!isValidTagPattern(pattern) || typeof tag !== "string" || !TAG.test(tag)) {
    return null;
  }
  const [prefix = "", suffix = ""] = pattern.split("{version}");
  if (
    !tag.startsWith(prefix) ||
    !tag.endsWith(suffix) ||
    tag.length <= prefix.length + suffix.length
  ) {
    return null;
  }
  const version = tag.slice(prefix.length, tag.length - suffix.length);
  return isPlainVersion(version) ? version : null;
}

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

export interface KeylessSettings {
  github?: { repository: string; workflow: string } | undefined;
  gitlab?: { host: string; project: string; ciConfigPath: string } | undefined;
  issuer?: string | undefined;
  identityTemplate?: string | undefined;
}

export interface KeylessIdentity {
  /** OIDC issuer as written into the certificate. */
  issuer: string;
  /** Exact certificate identity (SAN). */
  identity: string;
  /** GitHub-specific certificate extensions that are checked as well. */
  github: { repository: string; ref: string; trigger: "push" } | null;
}

const PRINTABLE_IDENTITY = /^[\x21-\x7e]{1,1024}$/;

/** The exact identity that must have signed the release with `tag` (and `version`). */
export function keylessIdentity(
  settings: KeylessSettings,
  tag: string,
  version: string,
): KeylessIdentity {
  if (!TAG.test(tag)) {
    throw new TypeError(`invalid tag: ${tag}`);
  }
  if (settings.github) {
    const { repository, workflow } = settings.github;
    return {
      issuer: GITHUB_ACTIONS_ISSUER,
      identity: `https://github.com/${repository}/${workflow}@refs/tags/${tag}`,
      github: { repository, ref: `refs/tags/${tag}`, trigger: "push" },
    };
  }
  if (settings.gitlab) {
    const { host, project, ciConfigPath } = settings.gitlab;
    return {
      issuer: `https://${host}`,
      identity: `https://${host}/${project}//${ciConfigPath}@refs/tags/${tag}`,
      github: null,
    };
  }
  if (settings.issuer && settings.identityTemplate) {
    const identity = settings.identityTemplate
      .split("{tag}")
      .join(tag)
      .split("{version}")
      .join(version);
    if (!PRINTABLE_IDENTITY.test(identity)) {
      throw new TypeError("the rendered identity is not printable ASCII without spaces");
    }
    return { issuer: settings.issuer, identity, github: null };
  }
  throw new TypeError("no keyless identity is configured");
}

/** A short description of the configured signer for `GET /v1/state` (`trust.identity`). */
export function describeKeyless(settings: KeylessSettings, tagPattern: string): string | null {
  const tag = tagPattern.replace("{version}", "<version>");
  if (settings.github) {
    return `https://github.com/${settings.github.repository}/${settings.github.workflow}@refs/tags/${tag}`;
  }
  if (settings.gitlab) {
    const { host, project, ciConfigPath } = settings.gitlab;
    return `https://${host}/${project}//${ciConfigPath}@refs/tags/${tag}`;
  }
  if (settings.identityTemplate) {
    return settings.identityTemplate.split("{tag}").join(tag).split("{version}").join("<version>");
  }
  return null;
}
