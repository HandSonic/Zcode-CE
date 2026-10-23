import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// 固定发行资产和摘要，禁止把官方 Electron 或上游更新的归档误当成 Win7 运行时。
export const WINDOWS7_RUNTIME = Object.freeze({
  version: "44.2.0",
  source: "https://github.com/e3kskoy7wqk/Electron-for-windows-7/releases/tag/v44.2.0",
  url: "https://github.com/e3kskoy7wqk/Electron-for-windows-7/releases/download/v44.2.0/dist.zip",
  sha256: "c50ba2c10c87331ab961f60569e4d906c8514921ac17e138fd0da21ee4ddb2b1",
});

export function isWindows7Build(env = process.env) {
  const value = env.ZCODE_WINDOWS7?.trim() ?? "";
  if (!["", "0", "1"].includes(value)) throw new Error("ZCODE_WINDOWS7 must be 0 or 1");
  return value === "1";
}

export async function verifyWindows7Archive(path, expectedHash = WINDOWS7_RUNTIME.sha256) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== expectedHash) {
    throw new Error(`Win7 Electron SHA-256 mismatch: ${path}`);
  }
  return resolve(path);
}

export async function resolveWindows7BuilderOptions({ env = process.env, target }) {
  if (!isWindows7Build(env)) return {};
  if (target.os !== "win32" || target.arch !== "x64") {
    throw new Error("Win7 experimental builds require win32-x64");
  }
  if (!env.ZCODE_WIN7_ELECTRON_ZIP) throw new Error("Run pnpm bundle:desktop:win7 first");
  return {
    electronVersion: WINDOWS7_RUNTIME.version,
    electronDist: await verifyWindows7Archive(env.ZCODE_WIN7_ELECTRON_ZIP),
  };
}

export async function assertWindows7WinptyPayload(resourcesDir) {
  const directory = resolve(
    resourcesDir,
    "app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64",
  );
  for (const file of ["pty.node", "winpty.dll", "winpty-agent.exe"]) {
    const path = resolve(directory, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error(`Missing Win7 WinPTY payload: ${path}`);
  }
}

export async function prepareWindows7Archive({ destination, fetchArchive = fetch }) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    const response = await fetchArchive(WINDOWS7_RUNTIME.url, {
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok || !response.body)
      throw new Error(`Win7 runtime download: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    await verifyWindows7Archive(temporary);
    await rename(temporary, destination);
    return resolve(destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
