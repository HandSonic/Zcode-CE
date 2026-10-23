import { createHash } from "node:crypto";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATE_REF,
  UPSTREAM_REPOSITORY,
  assertPublishedRelease,
  git,
  githubApi,
  releaseTagName,
  sourceMarker,
} from "./sync-win7-upstream.mjs";

const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function assertManifestIdentity(manifest, env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || ""))
    throw new Error("Invalid destination repository");
  if (!env.GITHUB_TOKEN) throw new Error("A release publishing token is required");
  if (!/^\d+$/.test(env.GITHUB_RUN_ID || "")) throw new Error("Invalid workflow run ID");
  if (!env.CONTROL_BRANCH) throw new Error("Missing maintenance branch");
  for (const sha of [env.CONTROLLER_SHA, env.CANDIDATE_SHA]) {
    if (!SHA.test(sha || "")) throw new Error("Expected full validated Git SHA");
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.upstreamRepository !== UPSTREAM_REPOSITORY ||
    !Number.isSafeInteger(manifest.upstreamReleaseId) ||
    manifest.upstreamReleaseId <= 0 ||
    !SHA.test(manifest.upstreamCommit || "") ||
    !SHA256.test(manifest.patchSha256 || "") ||
    manifest.controllerCommit !== env.CONTROLLER_SHA ||
    manifest.candidateCommit !== env.CANDIDATE_SHA ||
    manifest.outputTag !== releaseTagName(manifest.upstreamTag) ||
    manifest.packageVersion !== manifest.upstreamTag.replace(/^v/, "") ||
    !Number.isFinite(Date.parse(manifest.upstreamPublishedAt)) ||
    manifest.runUrl !== `https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
  )
    throw new Error("Release manifest does not match the validated source and workflow");
  const sourceUrl = new URL(manifest.upstreamUrl);
  if (
    sourceUrl.origin !== "https://github.com" ||
    sourceUrl.pathname !== `/${UPSTREAM_REPOSITORY}/releases/tag/${manifest.upstreamTag}` ||
    sourceUrl.search ||
    sourceUrl.hash
  )
    throw new Error("Invalid upstream release URL");
}

export function releaseBranchName(manifest) {
  return `automation/win7-release-${manifest.upstreamReleaseId}-${manifest.candidateCommit.slice(0, 12)}`;
}

export function assertPublicationHeads({
  expectedBase,
  actualBase,
  candidateSha,
  remoteCandidate,
}) {
  if (actualBase !== expectedBase)
    throw new Error("Maintenance branch moved during validation; retry with the new controller");
  if (remoteCandidate && remoteCandidate !== candidateSha)
    throw new Error("Release branch was modified; refusing to overwrite it");
}

export function remoteTagCommit(output, tag) {
  const ref = `refs/tags/${tag}`;
  const refs = new Map(
    output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, name, ...extra] = line.split(/\s+/);
        if (!SHA.test(sha) || ![ref, `${ref}^{}`].includes(name) || extra.length)
          throw new Error("Unexpected remote tag response");
        return [name, sha];
      }),
  );
  return refs.get(`${ref}^{}`) || refs.get(ref) || "";
}

export function assertSourceRelease(release, manifest) {
  if (
    release.id !== manifest.upstreamReleaseId ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.tag_name !== manifest.upstreamTag ||
    release.published_at !== manifest.upstreamPublishedAt ||
    release.html_url !== manifest.upstreamUrl
  )
    throw new Error("Upstream release changed or is no longer a published stable release");
}

export function createReleaseAssets(manifest, installerName, installerBytes) {
  if (
    !/^[A-Za-z0-9_.+-]+-win7\.exe$/.test(installerName) ||
    !installerName.includes(`-${manifest.packageVersion}-`) ||
    installerBytes.length === 0
  )
    throw new Error("Expected one nonempty installer for the validated Win7 version");
  const installer = {
    name: installerName,
    bytes: installerBytes,
    sha256: digest(installerBytes),
    size: installerBytes.length,
  };
  const sumsBytes = Buffer.from(`${installer.sha256}  ${installer.name}\n`);
  const sums = {
    name: "SHA256SUMS.txt",
    bytes: sumsBytes,
    sha256: digest(sumsBytes),
    size: sumsBytes.length,
  };
  // The manifest lists the other assets; its own digest is checked against GitHub after upload.
  const manifestBytes = Buffer.from(
    `${JSON.stringify(
      {
        ...manifest,
        assets: [installer, sums].map(({ name, sha256, size }) => ({ name, sha256, size })),
      },
      null,
      2,
    )}\n`,
  );
  return [
    installer,
    sums,
    {
      name: "win7-release.json",
      bytes: manifestBytes,
      sha256: digest(manifestBytes),
      size: manifestBytes.length,
    },
  ];
}

export function assertAssetDigest(remote, local) {
  if (
    remote.name !== local.name ||
    remote.state !== "uploaded" ||
    remote.size !== local.size ||
    remote.digest !== `sha256:${local.sha256}`
  )
    throw new Error(`Release attachment digest does not match: ${local.name}`);
}

export async function uploadReleaseAsset({
  repository,
  releaseId,
  name,
  bytes,
  token,
  fetchImpl = fetch,
}) {
  const url = new URL(
    `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets`,
  );
  url.searchParams.set("name", name);
  const response = await fetchImpl(url, {
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: bytes,
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(`GitHub asset upload failed: HTTP ${response.status}`);
  return response.json();
}

function assertDraftRelease(release, manifest, { allowPreviousCandidate = false } = {}) {
  if (
    !Number.isSafeInteger(release.id) ||
    release.draft !== true ||
    release.prerelease !== true ||
    release.tag_name !== manifest.outputTag ||
    !SHA.test(release.target_commitish || "") ||
    (!allowPreviousCandidate && release.target_commitish !== manifest.candidateCommit) ||
    !release.body?.includes(sourceMarker(manifest))
  )
    throw new Error("Existing release is not this validated candidate's draft prerelease");
}

function draftDetails(manifest) {
  return {
    tag_name: manifest.outputTag,
    target_commitish: manifest.candidateCommit,
    name: `${manifest.upstreamTag} — Windows 7 experimental`,
    body: `${sourceMarker(manifest)}\n\n基于 [${UPSTREAM_REPOSITORY} ${manifest.upstreamTag}](${manifest.upstreamUrl}) 的 Windows 7 实验构建。\n\n- 上游提交：${manifest.upstreamCommit}\n- Win7 补丁 SHA-256：${manifest.patchSha256}\n- 控制提交：${manifest.controllerCommit}\n- 已验证候选：${manifest.candidateCommit}\n- 检查与构建：[workflow run](${manifest.runUrl})\n\nLinux 检查、Windows 打包及包内 SQLite、WinPTY、搜索工具 smoke 已通过。现代 Windows smoke 不代替 Win7 真机验收；固定社区 Electron 版本和摘要不自动升级。本版本保持 prerelease，不接管常规桌面 latest 或自动更新源。`,
    draft: true,
    prerelease: true,
    make_latest: "false",
  };
}

async function releaseByTag(api, repository, tag) {
  try {
    return await api(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function listReleaseAssets(api, repository, releaseId) {
  const assets = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = await api(
      `/repos/${repository}/releases/${releaseId}/assets?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch)) throw new Error("Invalid release attachments response");
    assets.push(...batch);
    if (batch.length < 100) return assets;
  }
  throw new Error("Too many release attachments");
}

export async function publishWin7Release({
  cwd = process.cwd(),
  env = process.env,
  api = githubApi,
  gitRun = git,
  upload = uploadReleaseAsset,
} = {}) {
  const manifest = JSON.parse(await readFile(resolve(cwd, ".tmp/win7-release.json"), "utf8"));
  assertManifestIdentity(manifest, env);
  const repository = env.GITHUB_REPOSITORY;
  const callApi = (path, options = {}) => api(path, { ...options, token: env.GITHUB_TOKEN });
  const runGit = (args) => gitRun(cwd, args);
  await runGit(["check-ref-format", `refs/heads/${env.CONTROL_BRANCH}`]);
  await runGit(["check-ref-format", `refs/tags/${manifest.outputTag}`]);
  if ((await runGit(["rev-parse", "HEAD"])) !== manifest.controllerCommit)
    throw new Error("Publisher must execute from the trusted controller checkout");
  if (
    digest(await readFile(resolve(cwd, "patches/windows7-desktop.patch"))) !== manifest.patchSha256
  )
    throw new Error("Validated Win7 patch does not match the trusted controller");
  await runGit(["fetch", "--no-tags", resolve(cwd, ".tmp/win7-upstream.bundle"), CANDIDATE_REF]);
  if ((await runGit(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])) !== manifest.candidateCommit)
    throw new Error("Candidate bundle does not match the validated SHA");
  if (
    (await runGit(["show", "-s", "--format=%P", manifest.candidateCommit])) !==
    manifest.controllerCommit
  )
    throw new Error("Candidate does not have the trusted controller as its only parent");
  const candidatePackage = JSON.parse(
    await runGit(["show", `${manifest.candidateCommit}:package.json`]),
  );
  if (candidatePackage.version !== manifest.packageVersion)
    throw new Error("Candidate package version does not match its upstream release");

  const branch = releaseBranchName(manifest);
  const remoteTag = async (remote, tag) =>
    remoteTagCommit(
      await runGit(["ls-remote", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]),
      tag,
    );
  const checkSourceAndHeads = async () => {
    assertSourceRelease(
      await callApi(`/repos/${UPSTREAM_REPOSITORY}/releases/${manifest.upstreamReleaseId}`),
      manifest,
    );
    if (
      (await remoteTag(`https://github.com/${UPSTREAM_REPOSITORY}.git`, manifest.upstreamTag)) !==
      manifest.upstreamCommit
    )
      throw new Error("Upstream release tag was moved or removed");
    const actualBase = (
      await runGit(["ls-remote", "origin", `refs/heads/${env.CONTROL_BRANCH}`])
    ).split(/\s/)[0];
    const remoteCandidate = (await runGit(["ls-remote", "origin", `refs/heads/${branch}`])).split(
      /\s/,
    )[0];
    assertPublicationHeads({
      expectedBase: manifest.controllerCommit,
      actualBase,
      candidateSha: manifest.candidateCommit,
      remoteCandidate,
    });
    return remoteCandidate;
  };
  const remoteCandidate = await checkSourceAndHeads();
  const outputCommit = await remoteTag("origin", manifest.outputTag);
  if (outputCommit && outputCommit !== manifest.candidateCommit)
    throw new Error("Win7 output tag already points to a different candidate");
  let release = await releaseByTag(callApi, repository, manifest.outputTag);
  if (assertPublishedRelease(release, manifest)) {
    if (outputCommit !== manifest.candidateCommit)
      throw new Error("Published Win7 output tag is missing or points to a different candidate");
    return { release, reused: true };
  }
  if (release) assertDraftRelease(release, manifest, { allowPreviousCandidate: !outputCommit });

  const installerDirectory = resolve(cwd, ".tmp/win7-installers");
  const entries = await readdir(installerDirectory, { withFileTypes: true });
  const installers = entries.filter((entry) => /\.exe$/i.test(entry.name));
  if (installers.length !== 1 || !installers[0].isFile())
    throw new Error("Expected exactly one Win7 installer attachment");
  const installerName = installers[0].name;
  const assets = createReleaseAssets(
    manifest,
    installerName,
    await readFile(resolve(installerDirectory, installerName)),
  );
  if (!remoteCandidate)
    await runGit([
      "push",
      `--force-with-lease=refs/heads/${branch}:`,
      "origin",
      `${manifest.candidateCommit}:refs/heads/${branch}`,
    ]);
  if (!release) {
    release = await callApi(`/repos/${repository}/releases`, {
      method: "POST",
      body: draftDetails(manifest),
    });
  } else if (
    release.target_commitish !== manifest.candidateCommit ||
    release.body !== draftDetails(manifest).body
  ) {
    const releasePath = `/repos/${repository}/releases/${release.id}`;
    release = await callApi(releasePath);
    assertDraftRelease(release, manifest, { allowPreviousCandidate: !outputCommit });
    // An unfinished, untagged draft can move to a freshly validated controller candidate.
    // Once a tag exists, its commit is immutable even if publishing previously failed.
    const currentTag = await remoteTag("origin", manifest.outputTag);
    if (currentTag && currentTag !== manifest.candidateCommit)
      throw new Error("Win7 output tag changed before draft update");
    if (release.target_commitish !== manifest.candidateCommit && currentTag)
      throw new Error("An existing Win7 output tag prevents draft candidate migration");
    release = await callApi(releasePath, { method: "PATCH", body: draftDetails(manifest) });
  }
  assertDraftRelease(release, manifest);
  const releasePath = `/repos/${repository}/releases/${release.id}`;
  const remoteAssets = await listReleaseAssets(callApi, repository, release.id);
  const expectedNames = new Set(assets.map((asset) => asset.name));
  if (
    remoteAssets.some((asset) => !expectedNames.has(asset.name)) ||
    new Set(remoteAssets.map((asset) => asset.name)).size !== remoteAssets.length
  )
    throw new Error(
      "Draft contains unexpected or duplicate attachments; refusing to overwrite them",
    );
  for (const asset of assets) {
    const existing = remoteAssets.find((item) => item.name === asset.name);
    if (
      existing?.digest === `sha256:${asset.sha256}` &&
      existing.size === asset.size &&
      existing.state === "uploaded"
    )
      continue;
    assertDraftRelease(await callApi(releasePath), manifest);
    if (existing)
      await callApi(`/repos/${repository}/releases/assets/${existing.id}`, { method: "DELETE" });
    const uploaded = await upload({
      repository,
      releaseId: release.id,
      name: asset.name,
      bytes: asset.bytes,
      token: env.GITHUB_TOKEN,
    });
    assertAssetDigest(uploaded, asset);
  }
  const verifiedAssets = await listReleaseAssets(callApi, repository, release.id);
  if (verifiedAssets.length !== assets.length)
    throw new Error("Release attachments are incomplete");
  for (const asset of assets) {
    const matching = verifiedAssets.filter((item) => item.name === asset.name);
    if (matching.length !== 1) throw new Error(`Missing unique release attachment: ${asset.name}`);
    assertAssetDigest(matching[0], asset);
  }
  await checkSourceAndHeads();
  assertDraftRelease(await callApi(releasePath), manifest);
  const finalTag = await remoteTag("origin", manifest.outputTag);
  if (finalTag && finalTag !== manifest.candidateCommit)
    throw new Error("Win7 output tag changed during upload");
  if (!finalTag)
    await runGit([
      "push",
      `--force-with-lease=refs/tags/${manifest.outputTag}:`,
      "origin",
      `${manifest.candidateCommit}:refs/tags/${manifest.outputTag}`,
    ]);
  release = await callApi(releasePath, {
    method: "PATCH",
    body: { draft: false, prerelease: true, make_latest: "false" },
  });
  if (release.draft !== false || release.prerelease !== true)
    throw new Error("GitHub did not publish the Win7 experimental prerelease");
  assertPublishedRelease(release, manifest);
  return { release, reused: false };
}

async function main() {
  const result = await publishWin7Release();
  const message = `${result.reused ? "Existing" : "Published"} Win7 experimental prerelease: ${result.release.html_url}`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
