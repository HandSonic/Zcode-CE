import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertManifestIdentity,
  assertPublicationHeads,
  createReleaseAssets,
  publishWin7Release,
  remoteTagCommit,
} from "../publish-win7-upstream.mjs";

const base = "a".repeat(40);
const upstream = "b".repeat(40);
const candidate = "c".repeat(40);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const copy = (value) => structuredClone(value);

async function publicationFixture(t, options = {}) {
  const parent = resolve(".tmp");
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(resolve(parent, "win7-publication-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(resolve(cwd, ".tmp/win7-installers"), { recursive: true });
  await mkdir(resolve(cwd, "patches"));
  const patch = Buffer.from("trusted Win7 patch\n");
  const installerName = "ZCode-CE-3.15.1-ce.1-x64-win7.exe";
  const installerBytes = Buffer.from("installer produced by the validated Windows build");
  const env = {
    GITHUB_REPOSITORY: "HandSonic/Zcode-CE",
    GITHUB_RUN_ID: "42",
    GITHUB_TOKEN: "test-token",
    CONTROL_BRANCH: "main",
    CONTROLLER_SHA: base,
    CANDIDATE_SHA: candidate,
  };
  const manifest = {
    schemaVersion: 1,
    upstreamRepository: "Zcode-CE/Zcode-CE",
    upstreamReleaseId: 12,
    upstreamTag: "v3.15.1-ce.1",
    upstreamCommit: upstream,
    upstreamPublishedAt: "2026-10-14T04:22:48Z",
    upstreamUrl: "https://github.com/Zcode-CE/Zcode-CE/releases/tag/v3.15.1-ce.1",
    outputTag: "win7-v3.15.1-ce.1",
    controllerCommit: base,
    candidateCommit: candidate,
    packageVersion: "3.15.1-ce.1",
    patchSha256: hash(patch),
    runUrl: "https://github.com/HandSonic/Zcode-CE/actions/runs/42",
  };
  await writeFile(resolve(cwd, "patches/windows7-desktop.patch"), patch);
  await writeFile(resolve(cwd, ".tmp/win7-release.json"), JSON.stringify(manifest));
  await writeFile(resolve(cwd, ".tmp/win7-installers", installerName), installerBytes);
  const state = { release: null, assets: [], branch: "", outputTag: "", events: [] };
  const releaseView = () => state.release && { ...copy(state.release), assets: copy(state.assets) };
  const api = async (path, request = {}) => {
    assert.equal(request.token, env.GITHUB_TOKEN);
    const method = request.method || "GET";
    if (path === "/repos/Zcode-CE/Zcode-CE/releases/12")
      return {
        id: manifest.upstreamReleaseId,
        draft: false,
        prerelease: false,
        tag_name: manifest.upstreamTag,
        published_at: manifest.upstreamPublishedAt,
        html_url: manifest.upstreamUrl,
      };
    if (path.includes("/releases/tags/")) {
      if (state.release) return releaseView();
      throw Object.assign(new Error("Release does not exist"), { status: 404 });
    }
    if (path === "/repos/HandSonic/Zcode-CE/releases" && method === "POST") {
      assert.equal(request.body.draft, true);
      assert.equal(request.body.prerelease, true);
      assert.equal(request.body.make_latest, "false");
      state.events.push("create-draft");
      state.release = {
        ...copy(request.body),
        id: 90,
        html_url: "https://github.com/HandSonic/Zcode-CE/releases/tag/win7-v3.15.1-ce.1",
      };
      return releaseView();
    }
    if (path.startsWith("/repos/HandSonic/Zcode-CE/releases/90/assets?")) {
      state.events.push(`list-assets:${state.assets.length}`);
      return copy(state.assets);
    }
    if (path === "/repos/HandSonic/Zcode-CE/releases/90") {
      if (method === "PATCH" && request.body.draft === true) {
        state.events.push("update-draft");
        Object.assign(state.release, request.body);
      } else if (method === "PATCH") {
        assert.equal(
          state.assets.length,
          3,
          "public release requires all three verified attachments",
        );
        assert.equal(request.body.draft, false);
        assert.equal(request.body.prerelease, true);
        assert.equal(request.body.make_latest, "false");
        state.events.push("publish");
        Object.assign(state.release, request.body);
      }
      return releaseView();
    }
    if (method === "DELETE" && path.includes("/releases/assets/")) {
      state.events.push("delete-asset");
      state.assets = state.assets.filter((asset) => asset.id !== Number(path.split("/").at(-1)));
      return null;
    }
    throw new Error(`Unexpected API request: ${method} ${path}`);
  };
  const gitRun = async (_cwd, args) => {
    assert.equal(_cwd, cwd);
    if (args[0] === "check-ref-format") return "";
    if (args[0] === "fetch") return "";
    if (args[0] === "rev-parse") return args.at(-1) === "HEAD" ? base : candidate;
    if (args[0] === "show") {
      if (args.includes("--format=%P")) return base;
      if (args.at(-1) === `${candidate}:package.json`)
        return JSON.stringify({ version: manifest.packageVersion });
    }
    if (args[0] === "ls-remote") {
      if (args[1] === "https://github.com/Zcode-CE/Zcode-CE.git")
        return `${options.sourceMoved ? candidate : upstream}\trefs/tags/${manifest.upstreamTag}`;
      const ref = args[2];
      if (ref === "refs/heads/main")
        return `${options.moveControllerAfterUpload && state.assets.length === 3 ? upstream : base}\t${ref}`;
      if (ref.startsWith("refs/heads/automation/win7-release-"))
        return state.branch ? `${state.branch}\t${ref}` : "";
      if (ref === `refs/tags/${manifest.outputTag}`)
        return state.outputTag ? `${state.outputTag}\t${ref}` : "";
    }
    if (args[0] === "push") {
      assert.match(args[1], /^--force-with-lease=refs\/(heads|tags)\/.+:$/);
      if (args.at(-1).includes(":refs/heads/")) {
        state.events.push("push-candidate");
        state.branch = candidate;
      } else {
        state.events.push("push-tag");
        state.outputTag = candidate;
      }
      return "";
    }
    throw new Error(`Unexpected git command: ${args.join(" ")}`);
  };
  const upload = async ({ repository, releaseId, name, bytes, token }) => {
    assert.equal(repository, env.GITHUB_REPOSITORY);
    assert.equal(releaseId, 90);
    assert.equal(token, env.GITHUB_TOKEN);
    assert.equal(state.release.draft, true, "attachments must only be changed on a draft");
    state.events.push(`upload:${name}`);
    if (name === options.failUpload) throw new Error("Upload transport failed");
    const asset = {
      id: 100 + state.assets.length,
      name,
      state: "uploaded",
      size: bytes.length,
      digest: `sha256:${options.corruptDigest ? "0".repeat(64) : hash(bytes)}`,
    };
    state.assets.push(asset);
    return copy(asset);
  };
  return { cwd, env, manifest, state, api, gitRun, upload, installerName, installerBytes, options };
}

const run = ({ cwd, env, api, gitRun, upload }) =>
  publishWin7Release({ cwd, env, api, gitRun, upload });

test("发布先建草稿，再上传核对全部附件，最后公开 prerelease；重跑不改公开版本", async (t) => {
  const fixture = await publicationFixture(t);
  const first = await run(fixture);
  assert.equal(first.reused, false);
  assert.equal(first.release.draft, false);
  assert.equal(first.release.prerelease, true);
  const events = fixture.state.events;
  assert.ok(
    events.indexOf("create-draft") < events.findIndex((event) => event.startsWith("upload:")),
  );
  assert.ok(events.indexOf("list-assets:3") < events.indexOf("push-tag"));
  assert.ok(events.indexOf("push-tag") < events.indexOf("publish"));
  const before = copy(fixture.state);
  const second = await run(fixture);
  assert.equal(second.reused, true);
  assert.deepEqual(fixture.state, before, "already published releases are immutable");
});

test("附件上传失败保留草稿，重跑补齐附件后才能公开", async (t) => {
  const fixture = await publicationFixture(t, { failUpload: "SHA256SUMS.txt" });
  await assert.rejects(run(fixture), /Upload transport failed/);
  assert.equal(fixture.state.release.draft, true);
  assert.equal(fixture.state.assets.length, 1);
  assert.equal(fixture.state.events.includes("publish"), false);
  assert.equal(fixture.state.outputTag, "");
  fixture.options.failUpload = undefined;
  const resumed = await run(fixture);
  assert.equal(resumed.release.draft, false);
  assert.equal(fixture.state.events.filter((event) => event === "create-draft").length, 1);
  assert.equal(
    fixture.state.events.filter((event) => event === `upload:${fixture.installerName}`).length,
    1,
  );
});

test("GitHub 返回的附件摘要不符时禁止公开", async (t) => {
  const fixture = await publicationFixture(t, { corruptDigest: true });
  await assert.rejects(run(fixture), /digest does not match/);
  assert.equal(fixture.state.release.draft, true);
  assert.equal(fixture.state.events.includes("publish"), false);
  assert.equal(fixture.state.outputTag, "");
});

test("上传期间控制分支移动，已有候选和附件也不能发布", async (t) => {
  const fixture = await publicationFixture(t, { moveControllerAfterUpload: true });
  await assert.rejects(run(fixture), /moved during validation/);
  assert.equal(fixture.state.assets.length, 3);
  assert.equal(fixture.state.release.draft, true);
  assert.equal(fixture.state.events.includes("publish"), false);
  assert.equal(fixture.state.outputTag, "");
});

test("上游同名 tag 被重写时，在任何发布写入前停止", async (t) => {
  const fixture = await publicationFixture(t, { sourceMoved: true });
  await assert.rejects(run(fixture), /Upstream release tag was moved/);
  assert.deepEqual(fixture.state.events, []);
});

test("既有输出 tag 指向另一候选时不覆盖", async (t) => {
  const fixture = await publicationFixture(t);
  fixture.state.outputTag = upstream;
  await assert.rejects(run(fixture), /output tag already points to a different candidate/);
  assert.deepEqual(fixture.state.events, []);
});

test("未生成 output tag 的同源旧草稿可以迁移到新验证候选", async (t) => {
  const fixture = await publicationFixture(t);
  fixture.state.release = {
    id: 90,
    draft: true,
    prerelease: true,
    tag_name: fixture.manifest.outputTag,
    target_commitish: upstream,
    body: `<!-- win7-release:12:${upstream} -->`,
    html_url: "https://github.com/HandSonic/Zcode-CE/releases/tag/win7-v3.15.1-ce.1",
  };
  const result = await run(fixture);
  assert.equal(result.release.target_commitish, candidate);
  assert.equal(result.release.draft, false);
  assert.ok(fixture.state.events.includes("update-draft"));
  assert.equal(fixture.state.events.includes("create-draft"), false);
});

test("已有旧 output tag 的草稿不能迁移或覆盖标签", async (t) => {
  const fixture = await publicationFixture(t);
  fixture.state.release = {
    id: 90,
    draft: true,
    prerelease: true,
    tag_name: fixture.manifest.outputTag,
    target_commitish: upstream,
    body: `<!-- win7-release:12:${upstream} -->`,
  };
  fixture.state.outputTag = upstream;
  await assert.rejects(run(fixture), /output tag already points to a different candidate/);
  assert.deepEqual(fixture.state.events, []);
});

test("清单的来源、版本、控制提交与 workflow 身份必须全部匹配", async (t) => {
  const { manifest, env } = await publicationFixture(t);
  assertManifestIdentity(manifest, env);
  for (const overrides of [
    { controllerCommit: upstream },
    { candidateCommit: upstream },
    { upstreamRepository: "other/repo" },
    { packageVersion: "0.0.0" },
    { outputTag: "other-tag" },
    { runUrl: "https://github.com/other/repo/actions/runs/42" },
    { upstreamUrl: "https://example.com/releases/tag/v3.15.1-ce.1" },
  ])
    assert.throws(() => assertManifestIdentity({ ...manifest, ...overrides }, env));
});

test("构建期间维护分支移动或候选被修改时拒绝发布", () => {
  assert.throws(
    () =>
      assertPublicationHeads({ expectedBase: base, actualBase: upstream, candidateSha: candidate }),
    /moved during validation/,
  );
  assert.throws(
    () =>
      assertPublicationHeads({
        expectedBase: base,
        actualBase: base,
        candidateSha: candidate,
        remoteCandidate: upstream,
      }),
    /refusing to overwrite/,
  );
  assertPublicationHeads({
    expectedBase: base,
    actualBase: base,
    candidateSha: candidate,
    remoteCandidate: candidate,
  });
});

test("校验清单记录真实附件哈希，annotated tag 解析到 peeled commit", async (t) => {
  const { manifest, installerName, installerBytes } = await publicationFixture(t);
  const assets = createReleaseAssets(manifest, installerName, installerBytes);
  const sums = assets.find((asset) => asset.name === "SHA256SUMS.txt");
  assert.equal(sums.bytes.toString(), `${hash(installerBytes)}  ${installerName}\n`);
  const publishedManifest = JSON.parse(
    assets.find((asset) => asset.name === "win7-release.json").bytes,
  );
  assert.deepEqual(
    publishedManifest.assets,
    assets.slice(0, 2).map(({ name, sha256, size }) => ({ name, sha256, size })),
  );
  assert.equal(
    remoteTagCommit(`${base}\trefs/tags/v1.0.0\n${upstream}\trefs/tags/v1.0.0^{}`, "v1.0.0"),
    upstream,
  );
  assert.throws(
    () => remoteTagCommit(`${base}\trefs/tags/other`, "v1.0.0"),
    /Unexpected remote tag response/,
  );
});

test("写权限 job 等待两套验证，执行可信控制代码；候选只在只读 job 执行", async () => {
  const { parse } = await import("yaml");
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/sync-win7-upstream.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(workflow.permissions.contents, "read");
  assert.deepEqual(workflow.jobs.publish.needs, ["prepare", "verify", "build"]);
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: "write" });
  assert.equal(workflow.on.schedule[0].cron, "17 2 * * *");
  assert.ok(workflow.on.workflow_dispatch.inputs.release_tag);
  for (const name of ["verify", "build"]) {
    const job = workflow.jobs[name];
    assert.equal(job.permissions, undefined, "candidate validation inherits read-only permissions");
    assert.equal(
      job.steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with[
        "persist-credentials"
      ],
      false,
    );
    assert.equal(
      job.steps.some((step) => step.env?.GITHUB_TOKEN),
      false,
    );
    assert.equal(
      job.steps.some((step) => step["continue-on-error"]),
      false,
    );
  }
  for (const name of ["prepare", "publish"])
    assert.equal(
      workflow.jobs[name].steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with[
        "package-manager-cache"
      ],
      false,
    );
  const publishSteps = workflow.jobs.publish.steps;
  assert.equal(
    publishSteps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with.ref,
    "${{ needs.prepare.outputs.controllerSha }}",
  );
  assert.deepEqual(
    publishSteps.filter((step) => step.run).map((step) => step.run),
    ["node scripts/publish-win7-upstream.mjs"],
  );
  assert.equal(
    publishSteps.some((step) => step["continue-on-error"]),
    false,
  );
  assert.ok(
    publishSteps.some(
      (step) =>
        step.uses?.startsWith("actions/download-artifact@") &&
        step.with.path === ".tmp/win7-installers",
    ),
  );
});
