const assert = require("node:assert/strict");
const { stripVTControlCharacters } = require("node:util");

const SMOKE_PREFIX = "ZCODE_WIN7_SMOKE_RESULT=";
const SMOKE_CHECKS = Object.freeze([
  "packaged-runtime",
  "sqlite-reopen",
  "winpty-input-output-resize-exit",
  "search-tools",
]);

function assertWinptyOutput(output) {
  // WinPTY 返回的真实结果行可能以擦除行尾等 ANSI 控制序列结尾，先去掉控制序列再判断。
  assert.match(
    stripVTControlCharacters(output),
    /(?:^|[\r\n])ZCODE_WIN7_PTY_OK(?:[\r\n]|$)/,
    "WinPTY must emit an independent successful command result line",
  );
}

function parseSmokeResult(stdout) {
  const reports = stdout.split(/\r?\n/).filter((line) => line.startsWith(SMOKE_PREFIX));
  assert.equal(reports.length, 1, "Expected exactly one Win7 smoke success report");
  const report = JSON.parse(reports[0].slice(SMOKE_PREFIX.length));
  assert.ok(report && typeof report === "object" && !Array.isArray(report), "Invalid smoke report");
  assert.equal(report.ok, true, "Win7 smoke report is not successful");
  assert.match(report.windows || "", /^\d+\.\d+\.\d+(?:\.\d+)?$/, "Missing valid Windows version");
  assert.equal(report.versions?.electron, "44.2.0", "Unexpected packaged Electron version");
  assert.ok(
    Array.isArray(report.checks) &&
      report.checks.every((name) => typeof name === "string") &&
      SMOKE_CHECKS.every((name) => report.checks.includes(name)),
    "Win7 smoke report is missing required checks",
  );
  return report;
}

function writeAndExit(stream, output, exitCode) {
  try {
    stream.write(output, (error) => process.exit(error ? 1 : exitCode));
  } catch {
    process.exit(1);
  }
}

function finishSmokeProcess(run) {
  // WinPTY 已退出后，node-pty 的 worker 仍可能保活。独立 CLI 必须等全部检查、清理
  // 完成，且成功报告写入回调结束后再显式退出；写入失败不能被当作成功。
  return Promise.resolve()
    .then(run)
    .then((report) => {
      writeAndExit(process.stdout, `${SMOKE_PREFIX}${JSON.stringify(report)}\n`, 0);
    })
    .catch((error) => {
      writeAndExit(process.stderr, `${error?.stack || String(error)}\n`, 1);
    });
}

module.exports = {
  SMOKE_PREFIX,
  SMOKE_CHECKS,
  assertWinptyOutput,
  parseSmokeResult,
  finishSmokeProcess,
};
