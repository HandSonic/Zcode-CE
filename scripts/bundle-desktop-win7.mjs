import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  prepareWindows7Archive,
  verifyWindows7Archive,
} from "../packages/desktop/scripts/windows7-runtime.mjs";

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== "--prepare-only")) {
    throw new Error("Only --prepare-only is supported; Win7 bundles must rebuild application code");
  }
  const root = resolve(import.meta.dirname, "..");
  const destination = resolve(root, "packages/desktop/.cache/win7/electron-v44.2.0-win32-x64.zip");
  const configured = process.env.ZCODE_WIN7_ELECTRON_ZIP;
  const archive = configured || (existsSync(destination) ? destination : undefined);
  const runtimePath = archive
    ? await verifyWindows7Archive(archive)
    : await prepareWindows7Archive({ destination });
  console.log(`[win7] verified runtime: ${runtimePath}`);
  if (args.includes("--prepare-only")) return;
  const child = spawn(process.execPath, ["scripts/bundle.mjs", "--os", "win", "--arch", "x64"], {
    cwd: resolve(root, "packages/desktop"),
    stdio: "inherit",
    env: {
      ...process.env,
      ZCODE_WINDOWS7: "1",
      ZCODE_WIN7_ELECTRON_ZIP: runtimePath,
      ZCODE_DESKTOP_DIST_DIR: "dist-win7",
      ZCODE_SKIP_PREPARE: "0",
      ZCODE_SKIP_BUILD: "0",
    },
  });
  await new Promise((resolveRun, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`Win7 bundle failed: ${signal || code}`));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
