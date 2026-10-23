import assert from "node:assert/strict";
import test from "node:test";
import { resolveWindowsPtyPolicy } from "../src/terminal/windowsPtyPolicy.js";

test("旧 Windows 选择 WinPTY，现代 Windows 保持 ConPTY", () => {
  for (const version of ["6.1.7601", "6.2.9200", "6.3.9600", "10.0.18308"]) {
    assert.equal(resolveWindowsPtyPolicy(version).backend, "winpty", version);
  }
  for (const version of ["10.0.18309", "10.0.19045", "10.0.22631"]) {
    assert.equal(resolveWindowsPtyPolicy(version).backend, "conpty", version);
  }
  assert.deepEqual(resolveWindowsPtyPolicy("unknown"), { backend: "winpty" });
});
