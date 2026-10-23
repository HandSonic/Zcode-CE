import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATE_REF,
  UPSTREAM_REPOSITORY,
  existingSyncPull,
  git,
  githubApi,
  syncBranchName,
} from "./sync-win7-upstream.mjs";

export function assertPublicationHeads({
  expectedBase,
  actualBase,
  candidateSha,
  remoteCandidate,
}) {
  if (actualBase !== expectedBase)
    throw new Error("Maintenance branch moved during validation; retry with the new base");
  if (remoteCandidate && remoteCandidate !== candidateSha)
    throw new Error("Sync branch was modified; refusing to overwrite it");
}

async function main() {
  const cwd = process.cwd();
  const {
    SYNC_BASE_SHA: baseSha,
    SYNC_UPSTREAM_SHA: upstreamSha,
    SYNC_CANDIDATE_SHA: candidateSha,
    SYNC_BASE_BRANCH: base,
    GITHUB_REPOSITORY: repo,
  } = process.env;
  const branch = syncBranchName(baseSha, upstreamSha);
  if (!/^[a-f0-9]{40}$/.test(candidateSha || "")) throw new Error("Invalid candidate SHA");
  await git(cwd, ["check-ref-format", "--branch", base]);
  await git(cwd, ["fetch", resolve(".tmp/win7-upstream.bundle"), CANDIDATE_REF]);
  if ((await git(cwd, ["rev-parse", "FETCH_HEAD"])) !== candidateSha)
    throw new Error("Candidate bundle does not match the validated SHA");
  const actualBase = (await git(cwd, ["ls-remote", "origin", `refs/heads/${base}`])).split(/\s/)[0];
  const remoteCandidate = (await git(cwd, ["ls-remote", "origin", `refs/heads/${branch}`])).split(
    /\s/,
  )[0];
  assertPublicationHeads({ expectedBase: baseSha, actualBase, candidateSha, remoteCandidate });
  if (!remoteCandidate) {
    // 空 lease 只允许创建新分支，绝不覆盖同名的人工提交。
    await git(cwd, [
      "push",
      `--force-with-lease=refs/heads/${branch}:`,
      "origin",
      `${candidateSha}:refs/heads/${branch}`,
    ]);
  }
  const existing = await existingSyncPull(repo, branch, base);
  if (existing) {
    console.log(`Sync PR #${existing.number} already exists (${existing.state})`);
    return;
  }
  const runUrl = `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const pull = await githubApi(`/repos/${repo}/pulls`, {
    method: "POST",
    body: {
      title: `chore(win7): sync upstream ${upstreamSha.slice(0, 12)}`,
      head: branch,
      base,
      draft: false,
      body: `自动跟随 ${UPSTREAM_REPOSITORY}/main。\n\n- 维护分支基线：${baseSha}\n- 上游提交：${upstreamSha}\n- 已验证候选：${candidateSha}\n- 检查与安装包：[workflow run](${runUrl})\n\n类型、Lint、格式、全量测试、架构检查、Win7 打包及最终包 smoke 均在上述运行中通过。\n\n保留 fork 自有 .github/workflows/**，因此这是应用源码同步，不是上游逐文件镜像。Win7 运行时仍固定版本和 SHA-256。\n\n现代 Windows 上的 smoke 不等于 Win7 真机验收，继续保留实验标记；此 PR 不自动合入、不发布正式 Release。`,
    },
  });
  console.log(pull.html_url);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Validated upstream update: ${pull.html_url}\n`,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
