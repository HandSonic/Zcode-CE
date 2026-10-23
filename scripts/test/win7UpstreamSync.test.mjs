import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { prepareUpstreamMerge } from "../sync-win7-upstream.mjs";

const execFileAsync = promisify(execFile);
const fixtureRoot = resolve(import.meta.dirname, "../../.tmp");
const upstreamRef = "refs/heads/upstream";

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
  return stdout.trim();
}

async function configure(cwd) {
  await git(cwd, "config", "user.name", "Win7 sync fixture");
  await git(cwd, "config", "user.email", "win7-sync@example.invalid");
  await git(cwd, "config", "commit.gpgsign", "false");
  await git(cwd, "config", "core.autocrlf", "false");
}

async function put(cwd, path, contents) {
  const absolutePath = join(cwd, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
}

async function commit(cwd, message) {
  await git(cwd, "add", "--all");
  await git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

async function fixture(t, { forkApp = false, forkWorkflow = false } = {}) {
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(join(fixtureRoot, "win7-upstream-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "repo");
  await mkdir(cwd);
  await git(cwd, "init", "-b", "main");
  await configure(cwd);
  await put(cwd, "app.txt", "common\n");
  await put(cwd, ".github/workflows/ci.yml", "name: Common CI\n");
  await put(cwd, ".github/workflows/preserve.yml", "name: Preserve this workflow\n");
  const commonSha = await commit(cwd, "common ancestor");
  await git(cwd, "branch", "upstream");
  await git(cwd, "checkout", "-b", "win7");
  await put(cwd, "win7-compat.txt", "keep the Windows 7 compatibility patch\n");
  if (forkApp) await put(cwd, "app.txt", "fork application change\n");
  if (forkWorkflow) await put(cwd, ".github/workflows/ci.yml", "name: Windows 7 CI\n");
  const baseSha = await commit(cwd, "Windows 7 fork patch");
  return { directory, cwd, commonSha, baseSha, bundlePath: join(directory, "candidate.bundle") };
}

async function changeUpstream(f, change) {
  await git(f.cwd, "checkout", "upstream");
  await change();
  const upstreamSha = await commit(f.cwd, "upstream update");
  await git(f.cwd, "checkout", "win7");
  return upstreamSha;
}

async function missing(path) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

test("上游已是 fork 祖先时不创建候选或 bundle", async (t) => {
  const f = await fixture(t);
  const result = await prepareUpstreamMerge({ cwd: f.cwd, upstreamRef, bundlePath: f.bundlePath });
  assert.equal(result.changed, false);
  assert.equal(result.baseSha, f.baseSha);
  assert.equal(result.upstreamSha, f.commonSha);
  assert.equal(await git(f.cwd, "rev-parse", "HEAD"), f.baseSha);
  assert.equal(await git(f.cwd, "status", "--porcelain"), "");
  await missing(f.bundlePath);
});

test("保留 Win7 补丁并合入上游功能，bundle 可被只有 base 历史的 checkout 消费", async (t) => {
  const f = await fixture(t);
  const upstreamSha = await changeUpstream(f, () =>
    put(f.cwd, "feature.txt", "new upstream feature\n"),
  );
  const result = await prepareUpstreamMerge({ cwd: f.cwd, upstreamRef, bundlePath: f.bundlePath });
  assert.equal(result.changed, true);
  assert.equal(result.baseSha, f.baseSha);
  assert.equal(result.upstreamSha, upstreamSha);
  assert.match(result.candidateSha, /^[a-f0-9]{40}$/);
  const parents = (await git(f.cwd, "rev-list", "--parents", "-n", "1", result.candidateSha)).split(
    " ",
  );
  assert.deepEqual(parents, [result.candidateSha, f.baseSha, upstreamSha]);
  assert.equal(
    await git(f.cwd, "bundle", "list-heads", f.bundlePath, "refs/heads/win7-upstream-candidate"),
    `${result.candidateSha} refs/heads/win7-upstream-candidate`,
  );

  const consumer = join(f.directory, "consumer");
  await mkdir(consumer);
  await git(consumer, "init", "-b", "main");
  await git(consumer, "fetch", "--no-tags", f.cwd, f.baseSha);
  await git(consumer, "checkout", "--detach", "FETCH_HEAD");
  await assert.rejects(git(consumer, "cat-file", "-e", `${result.candidateSha}^{commit}`));
  await git(consumer, "bundle", "verify", f.bundlePath);
  await git(
    consumer,
    "fetch",
    f.bundlePath,
    "refs/heads/win7-upstream-candidate:refs/heads/candidate",
  );
  await git(consumer, "checkout", "--detach", "candidate");
  assert.equal(await git(consumer, "rev-parse", "HEAD"), result.candidateSha);
  assert.equal(
    await readFile(join(consumer, "win7-compat.txt"), "utf8"),
    "keep the Windows 7 compatibility patch\n",
  );
  assert.equal(await readFile(join(consumer, "feature.txt"), "utf8"), "new upstream feature\n");
});

test("应用代码冲突必须 abort，HEAD、文件与干净状态不变", async (t) => {
  const f = await fixture(t, { forkApp: true });
  await changeUpstream(f, () => put(f.cwd, "app.txt", "upstream conflicting application change\n"));
  await assert.rejects(prepareUpstreamMerge({ cwd: f.cwd, upstreamRef, bundlePath: f.bundlePath }));
  assert.equal(await git(f.cwd, "rev-parse", "HEAD"), f.baseSha);
  assert.equal(await readFile(join(f.cwd, "app.txt"), "utf8"), "fork application change\n");
  assert.equal(await git(f.cwd, "status", "--porcelain"), "");
  await assert.rejects(git(f.cwd, "rev-parse", "--verify", "MERGE_HEAD"));
  await missing(f.bundlePath);
});

test("workflow 归 fork 所有：保留改动及上游删除项，移除上游新增项，同时合入应用代码", async (t) => {
  const f = await fixture(t, { forkWorkflow: true });
  await changeUpstream(f, async () => {
    await put(f.cwd, ".github/workflows/ci.yml", "name: Conflicting upstream CI\n");
    await put(f.cwd, ".github/workflows/upstream-only.yml", "name: New upstream workflow\n");
    await rm(join(f.cwd, ".github/workflows/preserve.yml"));
    await put(f.cwd, "feature.txt", "upstream feature still belongs in the merge\n");
  });
  const result = await prepareUpstreamMerge({ cwd: f.cwd, upstreamRef, bundlePath: f.bundlePath });
  assert.equal(result.changed, true);
  assert.equal(
    await git(
      f.cwd,
      "diff",
      "--name-only",
      f.baseSha,
      result.candidateSha,
      "--",
      ".github/workflows",
    ),
    "",
  );
  assert.equal(
    await git(f.cwd, "show", `${result.candidateSha}:.github/workflows/ci.yml`),
    "name: Windows 7 CI",
  );
  assert.equal(
    await git(f.cwd, "show", `${result.candidateSha}:.github/workflows/preserve.yml`),
    "name: Preserve this workflow",
  );
  await assert.rejects(
    git(f.cwd, "cat-file", "-e", `${result.candidateSha}:.github/workflows/upstream-only.yml`),
  );
  assert.equal(
    await git(f.cwd, "show", `${result.candidateSha}:feature.txt`),
    "upstream feature still belongs in the merge",
  );
});

test("同一 base/upstream 的候选 SHA 不随调用时的提交日期变化", async (t) => {
  const f = await fixture(t);
  await changeUpstream(f, () => put(f.cwd, "feature.txt", "deterministic feature\n"));
  const authorDate = process.env.GIT_AUTHOR_DATE;
  const committerDate = process.env.GIT_COMMITTER_DATE;
  try {
    process.env.GIT_AUTHOR_DATE = "2020-01-01T00:00:00Z";
    process.env.GIT_COMMITTER_DATE = "2020-01-01T00:00:00Z";
    const first = await prepareUpstreamMerge({ cwd: f.cwd, upstreamRef, bundlePath: f.bundlePath });
    await git(f.cwd, "checkout", "--detach", f.baseSha);
    process.env.GIT_AUTHOR_DATE = "2030-01-01T00:00:00Z";
    process.env.GIT_COMMITTER_DATE = "2030-01-01T00:00:00Z";
    const second = await prepareUpstreamMerge({
      cwd: f.cwd,
      upstreamRef,
      bundlePath: join(f.directory, "second.bundle"),
    });
    assert.equal(second.baseSha, first.baseSha);
    assert.equal(second.upstreamSha, first.upstreamSha);
    assert.equal(second.candidateSha, first.candidateSha);
  } finally {
    if (authorDate === undefined) delete process.env.GIT_AUTHOR_DATE;
    else process.env.GIT_AUTHOR_DATE = authorDate;
    if (committerDate === undefined) delete process.env.GIT_COMMITTER_DATE;
    else process.env.GIT_COMMITTER_DATE = committerDate;
  }
});
