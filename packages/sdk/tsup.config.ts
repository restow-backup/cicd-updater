import { copyFileSync } from "node:fs";
import { defineConfig } from "tsup";

/**
 * The published package bundles the repository's internal packages (protocol,
 * feed) so it has no runtime dependency on them; only zod is a dependency and
 * React an optional peer (design 7.1, 10.2).
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    feed: "src/feed.ts",
    auth: "src/auth.ts",
    protocol: "src/protocol.ts",
    semver: "src/semver.ts",
    messages: "src/messages.ts",
    maintenance: "src/maintenance.ts",
    react: "src/react.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "neutral",
  // tsup sets baseUrl for the declaration build, which TypeScript 6 deprecates.
  // The internal packages are inlined into the declarations through `paths`.
  tsconfig: "tsconfig.build.json",
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  splitting: true,
  sourcemap: false,
  treeshake: true,
  removeNodeProtocol: false,
  noExternal: [/^@cicd-updater\//],
  external: ["zod", "react", /^node:/],
  onSuccess: async () => {
    copyFileSync("../../LICENSE", "LICENSE");
    copyFileSync("../../NOTICE", "NOTICE");
  },
});
