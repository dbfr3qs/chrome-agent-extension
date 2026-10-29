import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.browser_bridge.host";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // packages/host
const extId = readFileSync(resolve(root, "../extension/keys/extension-id.txt"), "utf8").trim();

const dirs: Record<string, string> = {
  darwin: join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
  linux: join(homedir(), ".config/google-chrome/NativeMessagingHosts"),
};
const manifestDir = dirs[process.platform];
if (!manifestDir) throw new Error(`unsupported platform ${process.platform} (Windows registry install not implemented)`);

// Chrome launches the host with a minimal PATH, so pin the absolute node binary.
const wrapper = join(root, "dist/host-launcher.sh");
writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${join(root, "dist/host.js")}"\n`);
chmodSync(wrapper, 0o755);

mkdirSync(manifestDir, { recursive: true });
const manifestPath = join(manifestDir, `${HOST_NAME}.json`);
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      name: HOST_NAME,
      description: "Browser Bridge native host",
      path: wrapper,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extId}/`],
    },
    null,
    2,
  ),
);
console.log(`installed ${manifestPath}\n  allowed origin: chrome-extension://${extId}/\n  node: ${process.execPath}`);
