import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
const common = { bundle: true, platform: "node", target: "node22", format: "esm" };
await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/host.js" });
await build({ ...common, entryPoints: ["src/install.ts"], outfile: "dist/install.js" });
