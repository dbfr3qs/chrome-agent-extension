import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({
  entryPoints: { background: "src/background.ts", options: "src/options.ts", sidepanel: "src/sidepanel.ts" },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome120",
});
await build({ entryPoints: { content: "src/content/index.ts" }, outdir: "dist", bundle: true, format: "iife", target: "chrome120" });
const manifest = JSON.parse(readFileSync("manifest.template.json", "utf8"));
manifest.key = readFileSync("keys/public-key.txt", "utf8").trim();
writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2));
cpSync("static", "dist", { recursive: true });
console.log("extension built -> dist (id", readFileSync("keys/extension-id.txt", "utf8").trim() + ")");
