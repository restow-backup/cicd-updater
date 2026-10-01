/**
 * The feed check for apps (design 7.3): which releases exist and which one is
 * next, read over an SSRF-guarded connection. Node.js only.
 */
export {
  checkFeed,
  type FeedCheckOptions,
  type FeedCheckResult,
  FeedError,
  type FeedRefusal,
  type FeedRelease,
} from "@cicd-updater/feed";
