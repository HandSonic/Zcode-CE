import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import fs from "node:fs";
import test from "node:test";
import { createTerminalService } from "../src/terminal/terminalService.js";

// 通过服务真实的 create 路径验证：后端元信息、spawn 参数必须一致，Win7 不得重试 ConPTY。
test("终端服务在 Win7 只启动一次 WinPTY，在 Win11 保持 ConPTY", async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalRelease = os.release;
  const originalAccess = fs.accessSync;
  const originalComSpec = process.env.ComSpec;
  const originalPath = process.env.PATH;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    fs.accessSync = (path, mode) => {
      if (path === "/test-shell.exe") return;
      return originalAccess(path, mode);
    };
    process.env.ComSpec = "/test-shell.exe";
    process.env.PATH = "";
    for (const [version, backend] of [
      ["6.1.7601", "winpty"],
      ["10.0.22631", "conpty"],
    ] as const) {
      os.release = () => version;
      syncBuiltinESMExports();
      const calls: Array<Record<string, unknown>> = [];
      const service = createTerminalService({
        settingService: { get: async () => ({}) } as never,
        localLibcSnapshot: () => ({ platform: "win32", readFailures: [] }),
        loadNodePty: async () =>
          ({
            spawn: (_shell: string, _args: string[], options: Record<string, unknown>) => {
              calls.push(options);
              return { onData() {}, onExit() {}, kill() {}, write() {}, resize() {} };
            },
          }) as never,
      });
      try {
        const terminal = await service.create({ cols: 80, rows: 24, cwd: process.cwd() });
        assert.equal(terminal.windowsPty?.backend, backend);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].useConpty, backend === "conpty");
        assert.equal(calls[0].useConptyDll, backend === "conpty" ? true : undefined);
        await service.dispose({ id: terminal.id });
      } finally {
        (service as typeof service & { disposeAll(): void }).disposeAll();
      }
    }
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    os.release = originalRelease;
    fs.accessSync = originalAccess;
    syncBuiltinESMExports();
    if (originalComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = originalComSpec;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});
