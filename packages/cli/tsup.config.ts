import { defineConfig } from "tsup";

export default defineConfig({
  entry: { upstream: "src/main.ts" },
  outDir: "plugin/dist",
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  clean: true,
  outExtension: () => ({ js: ".mjs" }),
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __upstreamRequire } from 'node:module'; const require = __upstreamRequire(import.meta.url);",
  },
});
