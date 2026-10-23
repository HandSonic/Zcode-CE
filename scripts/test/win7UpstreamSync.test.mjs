import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  CANDIDATE_REF,
  assertPublishedRelease,
  pendingReleases,
  prepareReleaseCandidate,
  releaseTagName,
  sourceMarker,
} from "../sync-win7-upstream.mjs";

const execFileAsync = promisify(execFile);
const fixtureRoot = resolve(import.meta.dirname, "../../.tmp");

async function rawGit(cwd, ...args) {
  return (
    await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    })
  ).stdout;
}
async function git(cwd, ...args) {
  return (await rawGit(cwd, ...args)).trim();
}
async function put(cwd, path, contents) {
  const absolute = join(cwd, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}
async function commit(cwd, message) {
  await git(cwd, "add", "--all");
  await git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}
async function fixture(t) {
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(join(fixtureRoot, "win7-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "repo");
  await mkdir(cwd);
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.name", "Win7 release fixture");
  await git(cwd, "config", "user.email", "win7-release@example.invalid");
  await git(cwd, "config", "commit.gpgsign", "false");
  await git(cwd, "config", "tag.gpgsign", "false");
  await git(cwd, "config", "core.autocrlf", "false");
  const originalPackage = {
    name: "release-fixture",
    version: "1.2.3",
    scripts: { build: "node build.mjs" },
  };
  await put(cwd, "package.json", JSON.stringify(originalPackage, null, 2) + "\n");
  await put(cwd, "app.txt", "released application\n");
  await put(cwd, ".github/workflows/upstream-only.yml", "name: Upstream release workflow\n");
  const upstreamSha = await commit(cwd, "exact published source");
  const upstreamTag = "v1.2.3";
  await git(cwd, "tag", "-a", upstreamTag, "-m", "published release", upstreamSha);

  await git(cwd, "checkout", "-b", "patch-source");
  await put(
    cwd,
    "package.json",
    JSON.stringify(
      {
        ...originalPackage,
        scripts: { ...originalPackage.scripts, "bundle:desktop:win7": "node win7.mjs" },
      },
      null,
      2,
    ) + "\n",
  );
  await put(cwd, "app.txt", "released application with Windows 7 adapter\n");
  await put(cwd, "win7-compat.txt", "explicit static compatibility patch\n");
  const patchCommit = await commit(cwd, "static Windows 7 patch");
  const patchPath = join(directory, "windows7.patch");
  const patch = await rawGit(cwd, "diff", "--binary", "--full-index", upstreamSha, patchCommit);
  await writeFile(patchPath, patch);

  await git(cwd, "checkout", "-b", "controller");
  await put(cwd, "app.txt", "unpublished maintenance application\n");
  await put(cwd, "maintenance-extra.txt", "must never leak into the released source\n");
  await put(
    cwd,
    "package.json",
    JSON.stringify({ ...originalPackage, version: "9.9.9" }, null, 2) + "\n",
  );
  await rm(join(cwd, ".github/workflows/upstream-only.yml"));
  await put(cwd, ".github/workflows/fork.yml", "name: Trusted fork workflow\n");
  const controllerSha = await commit(cwd, "trusted controller with newer unpublished code");
  return {
    directory,
    cwd,
    upstreamSha,
    upstreamTag,
    controllerSha,
    patchPath,
    upstreamRef: `refs/tags/${upstreamTag}`,
    bundlePath: join(directory, "candidate.bundle"),
  };
}

const formal = (id, tag, published_at, extra = {}) => ({
  id,
  tag_name: tag,
  published_at,
  draft: false,
  prerelease: false,
  ...extra,
});
const manifest = {
  upstreamReleaseId: 42,
  upstreamCommit: "a".repeat(40),
  outputTag: "win7-v1.2.3",
};
const asset = (name, extra = {}) => ({
  name,
  state: "uploaded",
  size: 123,
  digest: `sha256:${"b".repeat(64)}`,
  ...extra,
});
const published = (extra = {}) => ({
  tag_name: manifest.outputTag,
  target_commitish: "c".repeat(40),
  draft: false,
  prerelease: true,
  body: `Win7 experimental\n${sourceMarker(manifest)}`,
  assets: [
    asset("ZCode-CE-1.2.3-win-x64-win7.exe"),
    asset("SHA256SUMS.txt"),
    asset("win7-release.json"),
  ],
  ...extra,
});

test("版本tag产生隔离的Win7标签，拒绝main和不合法的Git版本名", () => {
  assert.equal(releaseTagName("v3.15.1-ce.1"), "win7-v3.15.1-ce.1");
  assert.equal(releaseTagName("1.2.3"), "win7-1.2.3");
  for (const tag of ["main", "v../1.2.3", "--v1.2.3", "v1.2", "v1.2.3/extra"]) {
    assert.throws(() => releaseTagName(tag), undefined, tag);
  }
});

test("只按已发布正式Release的时间排序，不跳过同一轮中的中间版本", () => {
  const releases = [
    formal(4, "v1.2.4", "2026-10-22T04:00:00Z"),
    formal(2, "v1.2.2", "2026-10-22T02:00:00Z"),
    formal(3, "v1.2.3", "2026-10-22T02:00:00Z"),
    formal(1, "v1.2.1", "2026-10-21T23:00:00Z"),
    formal(5, "v1.2.5", "2026-10-22T05:00:00Z", { draft: true }),
    formal(6, "v1.2.6", "2026-10-22T06:00:00Z", { prerelease: true }),
  ];
  const minimum = "2026-10-22T00:00:00Z";
  assert.deepEqual(
    pendingReleases(releases, minimum).map((release) => release.id),
    [2, 3, 4],
  );
  assert.deepEqual(
    pendingReleases(releases, minimum, "v1.2.1").map((release) => release.id),
    [1],
  );
  assert.deepEqual(pendingReleases(releases, minimum, "v1.2.5"), []);
  assert.deepEqual(pendingReleases(releases, minimum, "v1.2.6"), []);
  assert.throws(() => pendingReleases(releases, "invalid date"));
  assert.throws(() => pendingReleases([formal(1, "v1.2.1", "invalid date")], minimum));
  assert.throws(() => pendingReleases([formal(0, "v1.2.1", minimum)], minimum));
});

test("已公开Win7版本必须有正确来源、完整附件和精确目标SHA", () => {
  assert.equal(sourceMarker(manifest), `<!-- win7-release:42:${"a".repeat(40)} -->`);
  assert.equal(assertPublishedRelease(undefined, manifest), false);
  assert.equal(assertPublishedRelease(published({ draft: true }), manifest), false);
  assert.equal(assertPublishedRelease(published(), manifest), true);
  for (const release of [
    published({ body: "another source" }),
    published({ tag_name: "win7-v9.9.9" }),
    published({ prerelease: false }),
    published({ target_commitish: "main" }),
    published({ assets: [asset("SHA256SUMS.txt"), asset("win7-release.json")] }),
    published({ assets: [asset("ZCode-CE-1.2.3-win-x64-win7.exe"), asset("SHA256SUMS.txt")] }),
    published({ assets: [...published().assets, asset("second-win7.exe")] }),
    published({ assets: published().assets.map((item) => asset(item.name, { size: 0 })) }),
    published({ assets: published().assets.map((item) => asset(item.name, { state: "new" })) }),
    published({
      assets: published().assets.map((item) => asset(item.name, { digest: "sha256:bad" })),
    }),
  ])
    assert.throws(() => assertPublishedRelease(release, manifest));
  assert.throws(() => assertPublishedRelease(published(), { ...manifest, upstreamReleaseId: 43 }));
  assert.throws(() =>
    assertPublishedRelease(published(), { ...manifest, upstreamCommit: "d".repeat(40) }),
  );
});

test("候选严格来自精确annotated tag+静态补丁，不带maintenance额外应用代码", async (t) => {
  const f = await fixture(t);
  assert.notEqual(await git(f.cwd, "rev-parse", f.upstreamRef), f.upstreamSha);
  const result = await prepareReleaseCandidate(f);
  assert.equal(result.upstreamSha, f.upstreamSha);
  assert.equal(result.packageVersion, "1.2.3");
  assert.equal(
    result.patchSha256,
    createHash("sha256")
      .update(await readFile(f.patchPath))
      .digest("hex"),
  );
  const parents = (await git(f.cwd, "rev-list", "--parents", "-n", "1", result.candidateSha)).split(
    " ",
  );
  assert.deepEqual(parents, [result.candidateSha, f.controllerSha]);
  assert.equal(
    await git(f.cwd, "show", `${result.candidateSha}:app.txt`),
    "released application with Windows 7 adapter",
  );
  assert.equal(
    await git(f.cwd, "show", `${result.candidateSha}:win7-compat.txt`),
    "explicit static compatibility patch",
  );
  await assert.rejects(
    git(f.cwd, "cat-file", "-e", `${result.candidateSha}:maintenance-extra.txt`),
  );
  const pkg = JSON.parse(await git(f.cwd, "show", `${result.candidateSha}:package.json`));
  assert.equal(pkg.version, "1.2.3");
  assert.equal(pkg.scripts["bundle:desktop:win7"], "node win7.mjs");
  assert.equal(
    await git(
      f.cwd,
      "diff",
      "--name-only",
      f.controllerSha,
      result.candidateSha,
      "--",
      ".github/workflows",
    ),
    "",
  );
  assert.equal(
    await git(f.cwd, "show", `${result.candidateSha}:.github/workflows/fork.yml`),
    "name: Trusted fork workflow",
  );
  await assert.rejects(
    git(f.cwd, "cat-file", "-e", `${result.candidateSha}:.github/workflows/upstream-only.yml`),
  );

  const consumer = join(f.directory, "consumer");
  await mkdir(consumer);
  await git(consumer, "init", "-b", "main");
  await git(consumer, "fetch", "--no-tags", f.cwd, f.controllerSha);
  await git(consumer, "checkout", "--detach", "FETCH_HEAD");
  await assert.rejects(git(consumer, "cat-file", "-e", `${result.candidateSha}^{commit}`));
  await git(consumer, "bundle", "verify", f.bundlePath);
  await git(consumer, "fetch", f.bundlePath, `${CANDIDATE_REF}:refs/heads/candidate`);
  await git(consumer, "checkout", "--detach", "candidate");
  assert.equal(await git(consumer, "rev-parse", "HEAD"), result.candidateSha);
  assert.equal(
    await readFile(join(consumer, "app.txt"), "utf8"),
    "released application with Windows 7 adapter\n",
  );
  await assert.rejects(stat(join(consumer, "maintenance-extra.txt")), { code: "ENOENT" });
});

test("相同controller、tag与patch得到确定性的单父候选", async (t) => {
  const f = await fixture(t);
  const originalAuthor = process.env.GIT_AUTHOR_DATE;
  const originalCommitter = process.env.GIT_COMMITTER_DATE;
  try {
    process.env.GIT_AUTHOR_DATE = "2020-01-01T00:00:00Z";
    process.env.GIT_COMMITTER_DATE = "2020-01-01T00:00:00Z";
    const first = await prepareReleaseCandidate(f);
    await git(f.cwd, "reset", "--hard", f.controllerSha);
    process.env.GIT_AUTHOR_DATE = "2030-01-01T00:00:00Z";
    process.env.GIT_COMMITTER_DATE = "2030-01-01T00:00:00Z";
    const second = await prepareReleaseCandidate({
      ...f,
      bundlePath: join(f.directory, "second.bundle"),
    });
    assert.equal(second.candidateSha, first.candidateSha);
    assert.equal(second.upstreamSha, first.upstreamSha);
    assert.equal(second.patchSha256, first.patchSha256);
  } finally {
    if (originalAuthor === undefined) delete process.env.GIT_AUTHOR_DATE;
    else process.env.GIT_AUTHOR_DATE = originalAuthor;
    if (originalCommitter === undefined) delete process.env.GIT_COMMITTER_DATE;
    else process.env.GIT_COMMITTER_DATE = originalCommitter;
  }
});

test("补丁与新正式tag源码冲突必须停止，不能退回maintenance源码或产出bundle", async (t) => {
  const f = await fixture(t);
  await git(f.cwd, "checkout", "--detach", f.upstreamSha);
  await put(f.cwd, "app.txt", "incompatible new upstream application\n");
  const pkg = JSON.parse(await readFile(join(f.cwd, "package.json"), "utf8"));
  await put(f.cwd, "package.json", JSON.stringify({ ...pkg, version: "1.2.4" }, null, 2) + "\n");
  const newRelease = await commit(f.cwd, "incompatible new formal release");
  await git(f.cwd, "tag", "v1.2.4", newRelease);
  await git(f.cwd, "checkout", "--detach", f.controllerSha);
  await assert.rejects(
    prepareReleaseCandidate({ ...f, upstreamRef: "refs/tags/v1.2.4", upstreamTag: "v1.2.4" }),
  );
  assert.equal(await git(f.cwd, "rev-parse", "refs/heads/controller"), f.controllerSha);
  await assert.rejects(stat(f.bundlePath), { code: "ENOENT" });
});

test("tag与package.version不符时拒绝候选和bundle", async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareReleaseCandidate({ ...f, upstreamTag: "v9.9.9" }), /version/i);
  assert.equal(await git(f.cwd, "rev-parse", "refs/heads/controller"), f.controllerSha);
  await assert.rejects(stat(f.bundlePath), { code: "ENOENT" });
});
