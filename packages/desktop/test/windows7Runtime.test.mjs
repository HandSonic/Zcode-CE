import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isWindows7Build,
  verifyWindows7Archive,
  prepareWindows7Archive,
  resolveWindows7BuilderOptions,
} from "../scripts/windows7-runtime.mjs";

const target = { os: "win32", arch: "x64" };
test("普通构建无需兼容归档；Win7 拒绝错误目标和未准备的归档", async () => {
  assert.deepEqual(await resolveWindows7BuilderOptions({ env: {}, target }), {});
  assert.equal(isWindows7Build({ ZCODE_WINDOWS7: "0" }), false);
  assert.throws(() => isWindows7Build({ ZCODE_WINDOWS7: "true" }));
  for (const target of [
    { os: "linux", arch: "x64" },
    { os: "win32", arch: "arm64" },
  ]) {
    await assert.rejects(
      resolveWindows7BuilderOptions({ env: { ZCODE_WINDOWS7: "1" }, target }),
      /win32-x64/,
    );
  }
  await assert.rejects(
    resolveWindows7BuilderOptions({ env: { ZCODE_WINDOWS7: "1" }, target }),
    /bundle:desktop:win7/,
  );
});

test("校验使用文件内容；拒绝损坏归档；失败下载不覆盖已有缓存且清理临时文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "win7-runtime-"));
  try {
    const path = join(directory, "dist.zip");
    await writeFile(path, "fixture");
    const digest = createHash("sha256").update("fixture").digest("hex");
    assert.equal(await verifyWindows7Archive(path, digest), path);
    await assert.rejects(
      resolveWindows7BuilderOptions({
        env: { ZCODE_WINDOWS7: "1", ZCODE_WIN7_ELECTRON_ZIP: path },
        target,
      }),
      /SHA-256 mismatch/,
    );
    await assert.rejects(
      prepareWindows7Archive({
        destination: path,
        fetchArchive: async () => new Response("bad zip"),
      }),
      /SHA-256 mismatch/,
    );
    assert.equal(await readFile(path, "utf8"), "fixture");
    assert.deepEqual(await readdir(directory), ["dist.zip"]);
    await assert.rejects(
      prepareWindows7Archive({
        destination: path,
        fetchArchive: async () => new Response(null, { status: 404 }),
      }),
      /HTTP 404/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Win7 归档必须提供完整 WinPTY 的三个原生文件", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { assertWindows7WinptyPayload } = await import("../scripts/windows7-runtime.mjs");
  const root = await mkdtemp(join(tmpdir(), "win7-pty-"));
  try {
    const path = join(root, "app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64");
    await mkdir(path, { recursive: true });
    for (const file of ["pty.node", "winpty.dll", "winpty-agent.exe"]) {
      await assert.rejects(assertWindows7WinptyPayload(root), /Missing Win7 WinPTY payload/);
      await writeFile(join(path, file), "fixture");
    }
    await assertWindows7WinptyPayload(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
