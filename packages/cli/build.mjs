import { build } from "esbuild";

await build({
  entryPoints: { bb: "src/index.ts", "injection-suite": "src/injection-suite.ts" },
  outdir: "dist",
  entryNames: "[name]",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
});
