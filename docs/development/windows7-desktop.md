# Windows 7 本地桌面实验构建

## 范围与规则

目标是 Windows 7 SP1 x64 本机运行桌面、Host、Agent、SQLite 和终端，不是远程客户端。
当前为实验移植入口，尚未在 Windows 7 真机完成验收，不能视为正式支持声明。
构建机仍使用现代 Windows、Node 24.14.0 和 pnpm 10.33.2；不要求在 Win7 编译源码。

运行时由 `packages/desktop/scripts/windows7-runtime.mjs` 唯一选择，固定为
[e3kskoy7wqk/Electron-for-windows-7 v44.2.0](https://github.com/e3kskoy7wqk/Electron-for-windows-7/releases/tag/v44.2.0)
的 x64 `dist.zip`，SHA-256 固定在代码中。它是第三方修改版，不是 Electron 官方支持的运行时。
保留 Node 24 与现代 Chromium，避免降级到 Electron 22 后失去 `node:sqlite` 及现代 CSS。
下载失败、校验失败或目标不是 win32-x64 时必须终止；不得退回官方 Electron 冒充 Win7 包。
原归档许可证由现有 `afterExtract` 流程保留，修改版来源另写入包内 `resources/WIN7-RUNTIME.json`。

终端后端由 `windowsPtyPolicy.ts` 根据真实系统版本决定：Windows 10 build 18309 起（与 node-pty 的后端阈值一致）使用
ConPTY，旧系统使用 WinPTY；未知版本拒绝猜测并使用兼容后端。选定 WinPTY 后只启动一次，
不尝试 ConPTY DLL。依赖的 node-pty 必须包含 WinPTY 的 pty.node、winpty.dll 和 winpty-agent.exe。
Win7 构建关闭自动更新，防止被常规更新源替换成不支持 Win7 的运行时。

## 构建

```bash
pnpm install --frozen-lockfile
pnpm bundle:desktop:win7
```

入口下载并校验运行时，再复用桌面原有 prepare、build、bundle 与原生载荷检查。
可用 `ZCODE_WIN7_ELECTRON_ZIP` 指定已下载的原版 `dist.zip`（同样校验固定 SHA-256）。
`pnpm bundle:desktop:win7 --prepare-only` 只准备运行时；正常出包不允许跳过构建，避免复用常规版 bundle。
产物在 `packages/desktop/dist-win7/`，文件名带 `-win7`，包内记录 `zcodeWindows7: true`。
普通 `bundle:desktop` 保持使用原有运行时。

## 验收场景

1. 校验正确归档可用，错误哈希、缺失归档、非 x64/Windows 目标均失败；普通构建无 Win7 覆盖。
2. Win7 `6.1.7601` / Win8.1 / Win10 build 18308 选 WinPTY；18309 及以上选 ConPTY。
3. 在干净 Win7 SP1 x64 上安装、首次启动、新建本地工作区、配置模型并完成一次 Agent 文件读写。
4. 创建/恢复会话，重启后 SQLite 历史仍可读；终端 cmd.exe/PowerShell 输入、输出、resize、退出可用。
5. 检查更新不访问常规更新源；卸载后重新安装可启动；Win10/11 常规包终端不回归。
6. 对 CUA 原生驱动、浏览器导入 helper、外部浏览器自动化、MCP 子进程逐一真机验收。
   第三方工具各有系统要求；仅更换 Electron 不证明这些原生程序可在 Win7 运行。

## 验证边界

本入口解决运行时选择、归档完整性、更新隔离及终端后端选择；它不修改系统 DLL、
不要求安装内核扩展，也不以 `NODE_SKIP_PLATFORM_CHECK` 冒充平台兼容。
CI 或 Linux 上的单元测试不能替代上述最终安装包的 Win7 真机验收。

## 最终包 smoke

`.github/workflows/windows7-experimental.yml` 在现代 Windows runner 构建并上传实验安装包，
同时使用包内 EXE 实测 SQLite 持久化及 WinPTY 输入、输出、resize 和退出；该结果不等同于 Win7 验收。
将安装包装到 Win7 后，用 cmd 执行（脚本取自本仓库）：

```bat
set ELECTRON_RUN_AS_NODE=1
"C:\安装目录\ZCode-CE.exe" "C:\源码目录\scripts\smoke-win7-desktop.cjs" --require-win7
set ELECTRON_RUN_AS_NODE=
```

随后仍须执行上述界面、Agent 与可选原生能力的验收场景。实验包不向常规 Release 更新源自动发布。

## 自动跟随上游

[Win7 自动同步工作流](windows7-upstream-sync.md) 每六小时检查直接上游，保留兼容补丁，
检查和打包全部通过才生成更新 PR；应用冲突或验证失败不会推进维护分支。
定时任务需将该工作流合入默认分支后启用，不会自动合入更新或升级固定运行时。
