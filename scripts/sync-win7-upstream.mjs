import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

export function releaseTagName(tag) {
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag))
    throw new Error(`Unsupported release tag: ${tag}`);
  return `win7-${tag}`;
}

export function sourceMarker(manifest) {
  return `<!-- win7-release:${manifest.upstreamReleaseId}:${manifest.upstreamCommit} -->`;
}

export function assertPublishedRelease(release, manifest) {
  if (!release || release.draft) return false;
  if (
    release.tag_name !== manifest.outputTag ||
    !release.prerelease ||
    !/^[a-f0-9]{40}$/.test(release.target_commitish || "") ||
    !release.body?.includes(sourceMarker(manifest))
  )
    throw new Error("Published Win7 release has different source identity; refusing to overwrite");
  const assets = release.assets || [];
  const names = ["SHA256SUMS.txt", "win7-release.json"];
  const installers = assets.filter((asset) => asset.name.endsWith("-win7.exe"));
  if (installers.length !== 1)
    throw new Error("Published Win7 release has incomplete installer assets");
  for (const name of [...names, installers[0].name]) {
    const matches = assets.filter((asset) => asset.name === name);
    if (
      matches.length !== 1 ||
      matches[0].state !== "uploaded" ||
      matches[0].size <= 0 ||
      !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest || "")
    )
      throw new Error(`Published Win7 release has incomplete asset: ${name}`);
  }
  return true;
}

export function pendingReleases(releases, minimumPublishedAt, requestedTag = "") {
  if (!Number.isFinite(Date.parse(minimumPublishedAt)))
    throw new Error("Invalid release baseline date");
  if (requestedTag) releaseTagName(requestedTag);
  return releases
    .filter((release) => {
      if (release.draft || release.prerelease || !release.published_at) return false;
      if (
        !Number.isSafeInteger(release.id) ||
        release.id <= 0 ||
        !Number.isFinite(Date.parse(release.published_at))
      )
        throw new Error("Invalid upstream release metadata");
      if (requestedTag) return release.tag_name === requestedTag;
      return Date.parse(release.published_at) >= Date.parse(minimumPublishedAt);
    })
    .sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at) || a.id - b.id);
}

export async function githubApi(
  path,
  { method = "GET", body, token = process.env.GITHUB_TOKEN } = {},
) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const error = new Error(`GitHub API ${method} ${path}: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export async function prepareReleaseCandidate({
  cwd,
  upstreamRef,
  controllerSha,
  patchPath,
  bundlePath,
  upstreamTag,
}) {
  if (await git(cwd, ["status", "--porcelain"]))
    throw new Error("Release preparation requires a clean worktree");
  releaseTagName(upstreamTag);
  if (!/^[a-f0-9]{40}$/.test(controllerSha)) throw new Error("Expected full controller SHA");
  const upstreamSha = await git(cwd, ["rev-parse", "--verify", `${upstreamRef}^{commit}`]);
  const patch = await readFile(patchPath);
  const patchSha256 = createHash("sha256").update(patch).digest("hex");
  await git(cwd, ["checkout", "--detach", upstreamSha]);
  // 三方应用失败必须停止，不能用维护分支的最新源码替代正式 Release。
  await git(cwd, ["apply", "--3way", resolve(patchPath)]);
  const workflows = await git(cwd, ["ls-files", ".github/workflows"]);
  if (workflows) await git(cwd, ["rm", "-r", "--", ".github/workflows"]);
  if (await git(cwd, ["ls-tree", "--name-only", controllerSha, ".github/workflows"]))
    await git(cwd, ["checkout", controllerSha, "--", ".github/workflows"]);
  const pkg = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8"));
  if (pkg.version !== upstreamTag.replace(/^v/, ""))
    throw new Error("Release tag and package version differ");
  if (!pkg.scripts?.["bundle:desktop:win7"])
    throw new Error("Win7 patch is missing its build entry");
  const tree = await git(cwd, ["write-tree"]);
  const dates = await Promise.all(
    [controllerSha, upstreamSha].map((sha) => git(cwd, ["show", "-s", "--format=%ct", sha])),
  );
  const date = `${Math.max(...dates.map(Number))} +0000`;
  const candidateSha = await git(
    cwd,
    [
      "commit-tree",
      tree,
      "-p",
      controllerSha,
      "-m",
      `Win7 ${UPSTREAM_REPOSITORY}@${upstreamTag} (${upstreamSha})\n\nPatch SHA256: ${patchSha256}`,
    ],
    {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_NAME: "github-actions[bot]",
      GIT_COMMITTER_NAME: "github-actions[bot]",
      GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
    },
  );
  await mkdir(dirname(bundlePath), { recursive: true });
  await git(cwd, ["update-ref", CANDIDATE_REF, candidateSha]);
  await git(cwd, ["bundle", "create", resolve(bundlePath), CANDIDATE_REF, `^${controllerSha}`]);
  return { candidateSha, upstreamSha, patchSha256, packageVersion: pkg.version };
}

async function allReleases(api, repository) {
  const releases = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await api(`/repos/${repository}/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw new Error("Release pagination limit reached; refusing to skip history");
}

export async function prepareWin7Release({
  cwd = process.cwd(),
  env = process.env,
  api = githubApi,
} = {}) {
  const config = JSON.parse(await readFile(resolve(cwd, "config/windows7-release.json"), "utf8"));
  if (config.upstreamRepository !== UPSTREAM_REPOSITORY)
    throw new Error("Unexpected upstream repository");
  const controllerSha = await git(cwd, ["rev-parse", "HEAD"]);
  const controlBranch = env.CONTROL_BRANCH || "main";
  await git(cwd, ["check-ref-format", "--branch", controlBranch]);
  const releases = pendingReleases(
    await allReleases(api, UPSTREAM_REPOSITORY),
    config.minimumPublishedAt,
    env.RELEASE_TAG || "",
  );
  if (env.RELEASE_TAG && releases.length !== 1)
    throw new Error("Requested tag is not a published stable release");
  let selected;
  let manifest;
  for (const release of releases) {
    const outputTag = releaseTagName(release.tag_name);
    await git(cwd, [
      "fetch",
      "--no-tags",
      `https://github.com/${UPSTREAM_REPOSITORY}.git`,
      `+refs/tags/${release.tag_name}:refs/remotes/win7-release/source`,
    ]);
    const upstreamCommit = await git(cwd, [
      "rev-parse",
      "refs/remotes/win7-release/source^{commit}",
    ]);
    manifest = {
      schemaVersion: 1,
      upstreamRepository: UPSTREAM_REPOSITORY,
      upstreamReleaseId: release.id,
      upstreamTag: release.tag_name,
      upstreamCommit,
      upstreamPublishedAt: release.published_at,
      upstreamUrl: release.html_url,
      outputTag,
      controllerCommit: controllerSha,
      runUrl: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    };
    let existing;
    try {
      existing = await api(
        `/repos/${env.GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(outputTag)}`,
      );
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (!assertPublishedRelease(existing, manifest)) {
      selected = release;
      break;
    }
    const refs = await git(cwd, [
      "ls-remote",
      "origin",
      `refs/tags/${outputTag}`,
      `refs/tags/${outputTag}^{}`,
    ]);
    const lines = refs
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/\s+/));
    const actual =
      lines.find(([, ref]) => ref === `refs/tags/${outputTag}^{}`)?.[0] ||
      lines.find(([, ref]) => ref === `refs/tags/${outputTag}`)?.[0];
    if (actual !== existing.target_commitish)
      throw new Error("Published Win7 tag moved or disappeared; refusing to skip it");
  }
  if (!selected) return { changed: false, controllerSha, controlBranch };
  const candidateDir = resolve(cwd, ".tmp/win7-release-candidate");
  const bundlePath = resolve(cwd, ".tmp/win7-upstream.bundle");
  await mkdir(dirname(candidateDir), { recursive: true });
  await git(cwd, ["worktree", "add", "--detach", candidateDir, manifest.upstreamCommit]);
  try {
    const result = await prepareReleaseCandidate({
      cwd: candidateDir,
      upstreamRef: manifest.upstreamCommit,
      controllerSha,
      patchPath: resolve(cwd, config.patchFile),
      bundlePath,
      upstreamTag: selected.tag_name,
    });
    Object.assign(manifest, {
      candidateCommit: result.candidateSha,
      patchSha256: result.patchSha256,
      packageVersion: result.packageVersion,
    });
    await writeFile(
      resolve(cwd, ".tmp/win7-release.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    return {
      changed: true,
      controllerSha,
      controlBranch,
      candidateSha: result.candidateSha,
      upstreamSha: result.upstreamSha,
      upstreamTag: selected.tag_name,
      outputTag: manifest.outputTag,
    };
  } finally {
    await git(cwd, ["worktree", "remove", "--force", candidateDir]);
    await rm(candidateDir, { recursive: true, force: true });
  }
}

async function main() {
  const result = await prepareWin7Release();
  const summary = result.changed
    ? `Prepared ${result.upstreamTag} for Win7; validation and build required before publication.`
    : "All eligible upstream stable releases already have a complete Win7 release.";
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
