import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicationHeads } from "../publish-win7-upstream.mjs";
import { existingSyncPull, syncBranchName } from "../sync-win7-upstream.mjs";

const base = "a".repeat(40);
const upstream = "b".repeat(40);
const candidate = "c".repeat(40);

test("构建期间维护分支移动或候选被人工修改时拒绝发布", () => {
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
    remoteCandidate: "",
  });
  assertPublicationHeads({
    expectedBase: base,
    actualBase: base,
    candidateSha: candidate,
    remoteCandidate: candidate,
  });
});

test("同一目标和上游组合复用分支；无效 SHA 不能进入 ref", () => {
  assert.equal(syncBranchName(base, upstream), syncBranchName(base, upstream));
  assert.notEqual(syncBranchName(base, upstream), syncBranchName(candidate, upstream));
  assert.throws(() => syncBranchName("--all", upstream));
});

test("复用已关闭PR，不自动重开；只匹配本仓库的正确head和base", async () => {
  const repo = "HandSonic/Zcode-CE";
  const branch = syncBranchName(base, upstream);
  const expected = {
    number: 7,
    state: "closed",
    head: { ref: branch, repo: { full_name: repo } },
    base: { ref: "main" },
  };
  const match = await existingSyncPull(repo, branch, "main", async (path) => {
    assert.match(path, /state=all/);
    assert.match(path, /base=main/);
    return [
      { ...expected, head: { ref: branch, repo: { full_name: "other/fork" } } },
      { ...expected, base: { ref: "other" } },
      expected,
    ];
  });
  assert.equal(match, expected);
});

test("写权限job必须等待两套验证，候选代码只能在只读job中执行", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/sync-win7-upstream.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(workflow.permissions.contents, "read");
  assert.deepEqual(workflow.jobs.publish.needs, ["prepare", "verify", "build"]);
  assert.equal(workflow.jobs.publish.permissions.contents, "write");
  for (const name of ["verify", "build"]) {
    const job = workflow.jobs[name];
    assert.equal(job.permissions, undefined, "继承只读权限");
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
  // 控制 job 不安装 pnpm；setup-node 的自动缓存会误探测 packageManager 并在启动时失败。
  for (const name of ["prepare", "publish"]) {
    assert.equal(
      workflow.jobs[name].steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with[
        "package-manager-cache"
      ],
      false,
    );
  }
  const publishSteps = workflow.jobs.publish.steps;
  assert.equal(
    publishSteps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with.ref,
    "${{ github.sha }}",
  );
  assert.deepEqual(
    publishSteps.filter((step) => step.run).map((step) => step.run),
    ["node scripts/publish-win7-upstream.mjs"],
  );
});
