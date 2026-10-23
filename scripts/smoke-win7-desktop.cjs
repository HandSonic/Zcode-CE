// 使用安装目录中的 EXE + ELECTRON_RUN_AS_NODE=1 执行，验证最终包而非开发依赖。
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { tmpdir, release } = require("node:os");
const { dirname, join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { spawnSync } = require("node:child_process");

async function main() {
  assert.equal(process.platform, "win32", "需要 Windows 上的最终桌面包");
  assert.equal(process.versions.electron, "44.2.0", "不能混入官方桌面运行时");
  if (process.argv.includes("--require-win7")) assert.match(release(), /^6\.1\./);
  const appRoot = dirname(process.execPath);
  const appRequire = createRequire(join(appRoot, "resources/app.asar/package.json"));
  assert.equal(appRequire("./package.json").zcodeWindows7, true);
  const nodePty = appRequire("node-pty");
  for (const [directory, executable] of [
    ["ripgrep", "rg.exe"],
    ["ugrep", "ugrep.exe"],
  ]) {
    const result = spawnSync(
      join(appRoot, "resources/tools", directory, executable),
      ["--version"],
      {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${executable}: ${result.stderr}`);
  }
  const directory = await mkdtemp(join(tmpdir(), "zcode-win7-smoke-"));
  try {
    const databasePath = join(directory, "smoke.sqlite");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("CREATE TABLE smoke (value TEXT); INSERT INTO smoke VALUES ('persisted')");
    } finally {
      db.close();
    }
    const reopened = new DatabaseSync(databasePath);
    try {
      assert.equal(reopened.prepare("SELECT value FROM smoke").get().value, "persisted");
    } finally {
      reopened.close();
    }
    await new Promise((resolve, reject) => {
      let output = "";
      const pty = nodePty.spawn(process.env.ComSpec || "cmd.exe", ["/d", "/q"], {
        cwd: directory,
        env: process.env,
        cols: 80,
        rows: 24,
        useConpty: false,
      });
      const timer = setTimeout(() => {
        pty.kill();
        reject(new Error("WinPTY smoke timed out"));
      }, 15_000);
      pty.onData((data) => {
        output += data;
      });
      pty.onExit(({ exitCode }) => {
        clearTimeout(timer);
        try {
          assert.equal(exitCode, 0);
          assert.match(output, /(?:^|[\r\n])ZCODE_WIN7_PTY_OK(?:[\r\n]|$)/);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      pty.resize(100, 30);
      pty.write("set ZCODE_SMOKE=OK\r\necho ZCODE_WIN7_PTY_%ZCODE_SMOKE%\r\nexit /b 0\r\n");
    });
    console.log(
      JSON.stringify({
        ok: true,
        windows: release(),
        versions: process.versions,
        checks: ["packaged-runtime", "sqlite-reopen", "winpty-input-output-resize-exit"],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
