import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const UPSTREAM_REPOSITORY = "Zcode-CE/Zcode-CE";
export const CANDIDATE_REF = "refs/heads/win7-upstream-candidate";

export async function git(cwd, args, env = {}) {
  return (
    await exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=github-actions[bot]",
        "-c",
        "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        ...args,
      ],
      {
        cwd,
        env: { ...process.env, ...env },
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 300_000,
      },
    )
  ).stdout.trim();
}

export function syncBranchName(baseSha, upstreamSha) {
  for (const sha of [baseSha, upstreamSha]) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected full Git SHA");
  }
  return `automation/win7-upstream-${upstreamSha.slice(0, 12)}-${baseSha.slice(0, 12)}`;
}

export async function prepareUpstreamMerge({ cwd, upstreamRef, bundlePath }) {
  if (await git(cwd, ["status", "--porcelain"])) throw new Error("Sync requires a clean worktree");
  const baseSha = await git(cwd, ["rev-parse", "HEAD"]);
  const upstreamSha = await git(cwd, ["rev-parse", "--verify", `${upstreamRef}^{commit}`]);
  const branch = syncBranchName(baseSha, upstreamSha);
  try {
    await git(cwd, ["merge-base", "--is-ancestor", upstreamSha, baseSha]);
    return { changed: false, baseSha, upstreamSha, branch };
  } catch (error) {
    if (error.code !== 1) throw error;
  }
  await mkdir(dirname(bundlePath), { recursive: true });
  try {
    let mergeFailure;
    try {
      await git(cwd, ["merge", "--no-ff", "--no-commit", upstreamSha]);
    } catch (error) {
      mergeFailure = error;
    }
    // fork 自己维护 Actions；不能用上游 workflow 覆盖 Win7 控制面，也不能静默宣称镜像同步。
    const workflows = await git(cwd, ["ls-files", ".github/workflows"]);
    if (workflows)
      await git(cwd, [
        "restore",
        `--source=${baseSha}`,
        "--staged",
        "--worktree",
        "--",
        ".github/workflows",
      ]);
    const conflicts = await git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
    if (conflicts) throw new Error(`Upstream application merge conflicts:\n${conflicts}`);
    if (mergeFailure && mergeFailure.code !== 1) throw mergeFailure;
    const dates = await Promise.all(
      [baseSha, upstreamSha].map((sha) => git(cwd, ["show", "-s", "--format=%ct", sha])),
    );
    const date = `${Math.max(...dates.map(Number))} +0000`;
    await git(
      cwd,
      ["commit", "--no-verify", "-m", `Merge ${UPSTREAM_REPOSITORY}@${upstreamSha} for Windows 7`],
      {
        GIT_AUTHOR_NAME: "github-actions[bot]",
        GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
        GIT_COMMITTER_NAME: "github-actions[bot]",
        GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    );
    const candidateSha = await git(cwd, ["rev-parse", "HEAD"]);
    await git(cwd, ["update-ref", CANDIDATE_REF, candidateSha]);
    await git(cwd, ["bundle", "create", resolve(bundlePath), CANDIDATE_REF, `^${baseSha}`]);
    return { changed: true, baseSha, upstreamSha, candidateSha, branch };
  } catch (error) {
    await git(cwd, ["merge", "--abort"]).catch(() => {});
    throw error;
  }
}

export async function githubApi(
  path,
  { method = "GET", body, token = process.env.GITHUB_TOKEN } = {},
) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export async function existingSyncPull(repo, branch, base, api = githubApi) {
  const query = new URLSearchParams({
    state: "all",
    head: `${repo.split("/")[0]}:${branch}`,
    base,
    per_page: "100",
  });
  const pulls = await api(`/repos/${repo}/pulls?${query}`);
  return pulls.find(
    (pr) => pr.head?.repo?.full_name === repo && pr.head?.ref === branch && pr.base?.ref === base,
  );
}

async function main() {
  const cwd = process.cwd();
  const base = process.env.SYNC_BASE_BRANCH || "main";
  const repo = process.env.GITHUB_REPOSITORY;
  await git(cwd, ["check-ref-format", "--branch", base]);
  await git(cwd, [
    "fetch",
    "--no-tags",
    "origin",
    `refs/heads/${base}:refs/remotes/win7-sync/base`,
  ]);
  await git(cwd, [
    "fetch",
    "--no-tags",
    `https://github.com/${UPSTREAM_REPOSITORY}.git`,
    "refs/heads/main:refs/remotes/win7-sync/upstream",
  ]);
  const baseSha = await git(cwd, ["rev-parse", "refs/remotes/win7-sync/base"]);
  const upstreamSha = await git(cwd, ["rev-parse", "refs/remotes/win7-sync/upstream"]);
  const branch = syncBranchName(baseSha, upstreamSha);
  const existing = await existingSyncPull(repo, branch, base);
  let result = { changed: false, baseSha, upstreamSha, branch };
  const candidateDir = resolve(cwd, ".tmp/win7-upstream-candidate");
  const bundlePath = resolve(cwd, ".tmp/win7-upstream.bundle");
  if (!existing) {
    await git(cwd, ["worktree", "add", "--detach", candidateDir, baseSha]);
    try {
      const manifest = JSON.parse(await readFile(resolve(candidateDir, "package.json"), "utf8"));
      if (!manifest.scripts?.["bundle:desktop:win7"])
        throw new Error(`Branch ${base} has no Win7 build entry; merge the Win7 PR first`);
      result = await prepareUpstreamMerge({
        cwd: candidateDir,
        upstreamRef: upstreamSha,
        bundlePath,
      });
    } finally {
      await git(cwd, ["worktree", "remove", "--force", candidateDir]);
      await rm(candidateDir, { recursive: true, force: true });
    }
  }
  const summary = existing
    ? `Existing sync PR #${existing.number} (${existing.state}); no duplicate work.`
    : result.changed
      ? "Candidate prepared; validation required before publication."
      : "Already contains upstream; no update needed.";
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `${summary}\n\nBase: ${baseSha}\n\nUpstream: ${upstreamSha}\n`,
    );
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries({ ...result, baseBranch: base })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
