/** Win7 没有 ConPTY；不能通过加载新版 conpty.dll 绕过系统 API 限制。 */
export function resolveWindowsPtyPolicy(releaseText: string): {
  backend: "conpty" | "winpty";
  buildNumber?: number;
} {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(releaseText);
  if (!match) return { backend: "winpty" };
  const major = Number(match[1]);
  const buildNumber = Number(match[3]);
  return {
    backend: major >= 10 && buildNumber >= 18309 ? "conpty" : "winpty",
    buildNumber,
  };
}
