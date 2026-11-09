import { copyFile, mkdir, readdir } from "node:fs/promises";
import { build } from "esbuild";

const outDir = "dist";
await mkdir(outDir, { recursive: true });

const shared = {
  bundle: true,
  platform: "browser",
  target: "chrome116",
  format: "iife",
  sourcemap: true,
  logLevel: "info",
};

await build({ ...shared, entryPoints: ["src/background.ts"], outfile: `${outDir}/background.js` });
await build({ ...shared, entryPoints: ["src/content.ts"], outfile: `${outDir}/content.js` });
await build({ ...shared, entryPoints: ["src/popup.ts"], outfile: `${outDir}/popup.js` });
await build({ ...shared, entryPoints: ["src/options.ts"], outfile: `${outDir}/options.js` });

for (const file of ["manifest.json", "popup.html", "options.html", "ui.css"]) {
  await copyFile(`src/${file}`, `${outDir}/${file}`);
}

await mkdir(`${outDir}/icons`, { recursive: true });
for (const file of await readdir("src/icons")) {
  await copyFile(`src/icons/${file}`, `${outDir}/icons/${file}`);
}
