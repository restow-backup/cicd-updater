import { z } from "zod";
import { RELEASE_TAG_PATTERN } from "./release.js";
import { PLAIN_VERSION_PATTERN } from "./semver.js";

/**
 * The feed index of the `static` and `file` feed providers
 * (`schemas/feed-index.schema.json`, design 3.3). For `static`, the URLs are
 * absolute https URLs; for `file`, they are plain file names relative to the
 * feed directory.
 */

export const FEED_INDEX_SCHEMA_VERSION = 1;
export const FEED_INDEX_MAX_BYTES = 8 * 1024 * 1024;

const location = z
  .string()
  .min(1)
  .max(2000)
  .meta({ description: "https URL (static feed) or plain file name (file feed)" });

export const feedIndexEntrySchema = z.object({
  version: z.string().max(64).regex(PLAIN_VERSION_PATTERN),
  tag: z.string().max(128).regex(RELEASE_TAG_PATTERN),
  prerelease: z.boolean(),
  publishedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  releaseJson: location.nullable().optional(),
  bundle: location.nullable().optional(),
  notesUrl: z
    .string()
    .max(2000)
    .regex(/^https:\/\//)
    .nullable()
    .optional(),
});
export type FeedIndexEntry = z.infer<typeof feedIndexEntrySchema>;

export const feedIndexSchema = z
  .object({
    schemaVersion: z.literal(FEED_INDEX_SCHEMA_VERSION),
    releases: z.array(feedIndexEntrySchema).max(1000),
  })
  .meta({ title: "cicd-updater feed index" });
export type FeedIndex = z.infer<typeof feedIndexSchema>;

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/** A file feed entry names a plain file in the feed directory. */
export function isPlainFileName(value: string): boolean {
  return FILE_NAME.test(value) && value !== "." && value !== "..";
}
