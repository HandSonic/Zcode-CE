import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runWin7Smoke } from "../../../scripts/run-win7-smoke.mjs";
import {
  SMOKE_PREFIX,
  SMOKE_CHECKS,
  assertWinptyOutput,
  parseSmokeResult,
} from "../../../scripts/win7-smoke-contract.cjs";

const report = {
  ok: true,
  windows: "10.0.26100",
  versions: { electron: "44.2.0" },
  checks: [...SMOKE_CHECKS],
};
const reportLine = (value = report) => `${SMOKE_PREFIX}${JSON.stringify(value)}`;
const contractPath = fileURLToPath(
  new URL("../../../scripts/win7-smoke-contract.cjs", import.meta.url),
);

async function fakeExecutableScript(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "win7-smoke-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scriptPath = join(directory, "fake-smoke.cjs");
  await writeFile(scriptPath, source);
  return { executable: process.execPath, scriptPath };
}

const printReport = (value = report) => `console.log(${JSON.stringify(reportLine(value))});`;

async function fakeSmokeProcess(t, source) {
  return fakeExecutableScript(
    t,
    `const { finishSmokeProcess } = require(${JSON.stringify(contractPath)});\n` +
      `setInterval(() => {}, 1000);\n${source}`,
  );
}

test("WinPTY 真实 ANSI 输出能识别结果，回显命令和部分匹配不能冒充执行成功", () => {
  const output =
    "\x1b]0;Administrator:  \x07\x1b[0mMicrosoft Windows [Version 10.0.26100.33650]\x1b[0K\r\n" +
    "C:\\temp>echo ZCODE_WIN7_PTY_%ZCODE_SMOKE%\x1b[0K\r\n" +
    "ZCODE_WIN7_PTY_OK\x1b[0K\r\n" +
    "\x1b[0K\x1b[?25h";
  assertWinptyOutput(output);
  for (const invalid of [
    "C:\\temp>echo ZCODE_WIN7_PTY_OK\x1b[0K\r\n",
    "echo ZCODE_WIN7_PTY_OK\r\n",
    "ZCODE_WIN7_PTY_OK_SUFFIX\r\n",
    "PREFIX_ZCODE_WIN7_PTY_OK\r\n",
    "ZCODE_WIN7_PTY_%ZCODE_SMOKE%\r\n",
  ]) {
    assert.throws(() => assertWinptyOutput(invalid), /independent successful command result/);
  }
});

test("结构化报告必须包含正确运行时、Windows 版本和全部检查项", () => {
  assert.deepEqual(parseSmokeResult(`${reportLine()}\n`), report);
  for (const invalid of [
    { ...report, ok: false },
    { ...report, windows: "unknown" },
    { ...report, versions: { electron: "41.0.0" } },
    { ...report, checks: SMOKE_CHECKS.slice(0, -1) },
  ])
    assert.throws(() => parseSmokeResult(reportLine(invalid)));
});

test("子进程输出断言错误但退出 0，也必须阻止通过", async (t) => {
  const options = await fakeExecutableScript(
    t,
    'console.error("AssertionError: terminal failed");',
  );
  await assert.rejects(runWin7Smoke(options), (error) => {
    assert.match(error.message, /exactly one Win7 smoke success report/);
    assert.match(error.stderr, /AssertionError: terminal failed/);
    return true;
  });
});

test("缺失、部分、畸形或重复的子进程报告均不能通过", async (t) => {
  const cases = [
    ["missing", 'console.log("finished");', /exactly one/],
    ["partial", printReport({ ok: true }), /valid Windows version/],
    [
      "invalid-json",
      `console.log(${JSON.stringify(`${SMOKE_PREFIX}{not json}`)});`,
      /JSON|property name/,
    ],
    ["duplicate", `${printReport()}\n${printReport()}`, /exactly one/],
  ];
  for (const [name, source, pattern] of cases) {
    await t.test(name, async (t) => {
      const options = await fakeExecutableScript(t, source);
      await assert.rejects(runWin7Smoke(options), pattern);
    });
  }
});

test("即使打印完整成功报告，非零退出仍阻止通过", async (t) => {
  const options = await fakeExecutableScript(t, `${printReport()}\nprocess.exitCode = 7;`);
  await assert.rejects(runWin7Smoke(options), (error) => {
    assert.match(error.message, /process failed/);
    assert.equal(error.cause.code, 7);
    assert.match(error.stdout, /ZCODE_WIN7_SMOKE_RESULT=/);
    return true;
  });
});

test("打印成功报告后一直不退出的进程仍须超时失败", async (t) => {
  const options = await fakeExecutableScript(t, `${printReport()}\nsetInterval(() => {}, 1000);`);
  await assert.rejects(runWin7Smoke({ ...options, timeout: 1_000 }), (error) => {
    assert.match(error.message, /timed out after 1000 ms/);
    assert.match(error.stdout, /ZCODE_WIN7_SMOKE_RESULT=/);
    return true;
  });
});

test("等待正常退出并收到完整报告后才成功，保留 stdout/stderr 便于诊断", async (t) => {
  const options = await fakeExecutableScript(
    t,
    `console.log("starting smoke");\nconsole.error("fixture diagnostic");\n${printReport()}`,
  );
  const result = await runWin7Smoke(options);
  assert.deepEqual(result.report, report);
  assert.match(result.stdout, /starting smoke/);
  assert.match(result.stderr, /fixture diagnostic/);
});

test("require-win7 验证子进程收到参数，并拒绝现代 Windows 成功报告", async (t) => {
  const modern = await fakeExecutableScript(t, printReport());
  await assert.rejects(runWin7Smoke({ ...modern, requireWin7: true }), /Windows 7/);
  const legacyReport = { ...report, windows: "6.1.7601" };
  const legacy = await fakeExecutableScript(
    t,
    `require("node:assert/strict").ok(process.argv.includes("--require-win7"));\n${printReport(legacyReport)}`,
  );
  const result = await runWin7Smoke({ ...legacy, requireWin7: true });
  assert.deepEqual(result.report, legacyReport);
});

test("独立 smoke 等待异步清理后写完报告并退出，不受常驻句柄影响", async (t) => {
  const options = await fakeSmokeProcess(
    t,
    `finishSmokeProcess(async () => {
      try { return ${JSON.stringify(report)}; }
      finally {
        await new Promise(resolve => setTimeout(resolve, 20));
        process.stderr.write("cleanup completed\\n");
      }
    });`,
  );
  const result = await runWin7Smoke({ ...options, timeout: 5_000 });
  assert.deepEqual(result.report, report);
  assert.equal(result.stdout, `${reportLine()}\n`);
  assert.match(result.stderr, /cleanup completed/);
});

test("独立 smoke 的检查或异步清理抛错时非零退出且不输出成功报告", async (t) => {
  const cases = [
    ["check", '() => { throw new Error("fixture check failed"); }', /fixture check failed/],
    [
      "cleanup",
      `async () => {
        try { return ${JSON.stringify(report)}; }
        finally {
          await new Promise(resolve => setTimeout(resolve, 20));
          throw new Error("fixture cleanup failed");
        }
      }`,
      /fixture cleanup failed/,
    ],
  ];
  for (const [name, run, pattern] of cases) {
    await t.test(name, async (t) => {
      const options = await fakeSmokeProcess(t, `finishSmokeProcess(${run});`);
      await assert.rejects(runWin7Smoke({ ...options, timeout: 5_000 }), (error) => {
        assert.equal(error.cause.code, 1);
        assert.match(error.stderr, pattern);
        assert.match(error.stderr, /\n\s+at /);
        assert.equal(error.stdout.includes(SMOKE_PREFIX), false);
        return true;
      });
    });
  }
});

test("独立 smoke 未完成时不得提前输出成功报告", async (t) => {
  const options = await fakeSmokeProcess(t, "finishSmokeProcess(() => new Promise(() => {}));");
  await assert.rejects(runWin7Smoke({ ...options, timeout: 1_000 }), (error) => {
    assert.match(error.message, /timed out/);
    assert.equal(error.stdout.includes(SMOKE_PREFIX), false);
    return true;
  });
});

test("独立 smoke 的 stdout 或 stderr 写入回调失败也必须非零退出", async (t) => {
  for (const stream of ["stdout", "stderr"]) {
    await t.test(stream, async (t) => {
      const run =
        stream === "stdout"
          ? `() => (${JSON.stringify(report)})`
          : '() => { throw new Error("fixture failure"); }';
      const options = await fakeSmokeProcess(
        t,
        `process.${stream}.write = (_output, callback) => {
          setImmediate(() => callback(new Error("fixture write failed")));
        };
        finishSmokeProcess(${run});`,
      );
      await assert.rejects(runWin7Smoke({ ...options, timeout: 5_000 }), (error) => {
        assert.equal(error.cause.code, 1);
        assert.equal(error.stdout.includes(SMOKE_PREFIX), false);
        return true;
      });
    });
  }
});
