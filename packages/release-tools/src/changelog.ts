import { isPlainVersion } from "@cicd-updater/protocol";

/**
 * Release tag checks (design 10.4): the tag is `v<version>`, CHANGELOG.md has
 * a dated section for the version (Keep a Changelog), and every package
 * version equals the tag.
 */

export interface TagCheck {
  ok: boolean;
  version: string | null;
  problems: string[];
}

/** `## [1.0.0] - 2026-11-02` (Keep a Changelog). */
export function changelogSection(
  changelog: string,
  version: string,
): { date: string | null } | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^##\\s*\\[?${escaped}\\]?\\s*(?:[-–]\\s*(\\d{4}-\\d{2}-\\d{2}))?\\s*$`,
    "m",
  ).exec(changelog);
  if (!match) {
    return null;
  }
  return { date: match[1] ?? null };
}

export function checkTag(input: {
  tag: string;
  changelog: string;
  packageVersions: Record<string, string>;
}): TagCheck {
  const problems: string[] = [];
  const version = input.tag.startsWith("v") ? input.tag.slice(1) : null;
  if (!version || !isPlainVersion(version)) {
    problems.push(`${input.tag} is not v<version> with a plain semantic version.`);
    return { ok: false, version: null, problems };
  }
  const section = changelogSection(input.changelog, version);
  if (!section) {
    problems.push(`CHANGELOG.md has no section for ${version}.`);
  } else if (!section.date) {
    problems.push(
      `The CHANGELOG.md section for ${version} has no date (## [${version}] - YYYY-MM-DD).`,
    );
  }
  for (const [file, packageVersion] of Object.entries(input.packageVersions)) {
    if (packageVersion !== version) {
      problems.push(`${file} has version ${packageVersion}, the tag says ${version}.`);
    }
  }
  return { ok: problems.length === 0, version, problems };
}
