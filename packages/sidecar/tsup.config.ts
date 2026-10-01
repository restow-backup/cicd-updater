import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

/**
 * The `cicd-updater` executable of the sidecar image (docker/Dockerfile): one
 * self-contained ES module with every dependency bundled, so the runtime image
 * needs no node_modules. The version comes from package.json.
 */
export default defineConfig({
  entry: { "cicd-updater": "src/bin.ts" },
  outDir: "dist",
  outExtension: () => ({ js: ".mjs" }),
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  treeshake: true,
  minify: false,
  sourcemap: false,
  clean: true,
  dts: false,
  removeNodeProtocol: false,
  define: { __CICD_UPDATER_VERSION__: JSON.stringify(version) },
  // yaml resolves to its CommonJS build on Node; give it a require().
  banner: {
    js: [
      "// cicd-updater sidecar. Copyright IT Systeme Flores UG (haftungsbeschränkt), Apache-2.0.",
      'import { createRequire as __cicdCreateRequire } from "node:module";',
      "const require = __cicdCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
