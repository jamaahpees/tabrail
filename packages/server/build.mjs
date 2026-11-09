import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  banner: { js: "#!/usr/bin/env node" },
});

await build({
  ...shared,
  entryPoints: ["src/bridge.ts"],
  outfile: "dist/bridge.js",
  banner: { js: "#!/usr/bin/env node" },
});
