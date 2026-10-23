import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SMOKE_PREFIX, parseSmokeResult } from "./win7-smoke-contract.cjs";

const exec = promisify(execFile);
const defaultScript = fileURLToPath(new URL("./smoke-win7-desktop.cjs", import.meta.url));

export async function runWin7Smoke({
  executable,
  scriptPath = defaultScript,
  requireWin7 = false,
  timeout = 60_000,
}) {
  assert.ok(typeof executable === "string" && executable.length > 0, "Missing packaged executable");
  assert.ok(Number.isSafeInteger(timeout) && timeout > 0, "Smoke timeout must be positive");
  let result;
  try {
    // Node 等待真实子进程结束；Windows GUI EXE 不能依赖 shell 的隐式等待或旧退出码。
    result = await exec(
      executable,
      [resolve(scriptPath), ...(requireWin7 ? ["--require-win7"] : [])],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
        windowsHide: true,
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch (cause) {
    const error = new Error(
      cause.killed
        ? `Win7 smoke process timed out after ${timeout} ms`
        : `Win7 smoke process failed (${cause.code || cause.signal || "spawn error"})`,
      { cause },
    );
    error.stdout = cause.stdout || "";
    error.stderr = cause.stderr || "";
    throw error;
  }
  // 即使错误路径意外退出 0，没有完整成功报告也不能通过发布门禁。
  try {
    const report = parseSmokeResult(result.stdout);
    if (requireWin7) assert.match(report.windows, /^6\.1\./, "Smoke must run on Windows 7");
    return { ...result, report };
  } catch (error) {
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || (args.length === 2 && args[1] !== "--require-win7"))
    throw new Error("Usage: node scripts/run-win7-smoke.mjs <packaged-exe> [--require-win7]");
  const result = await runWin7Smoke({
    executable: args[0],
    requireWin7: args[1] === "--require-win7",
  });
  if (result.stderr) process.stderr.write(result.stderr);
  console.log(`${SMOKE_PREFIX}${JSON.stringify(result.report)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    console.error(error);
    process.exitCode = 1;
  });
}
