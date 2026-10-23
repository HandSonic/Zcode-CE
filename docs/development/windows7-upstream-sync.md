# Win7 自动跟随直接上游

## 产品规则与边界

直接上游固定为 GitHub fork parent `Zcode-CE/Zcode-CE` 的 `main`。
`zai-org/ZCode` 的功能筛选继续由 CE 维护者负责，本自动化不跨过 CE 直接合入原始上游。
目标是在保留 Win7 补丁的前提下自动准备、验证并提出更新，不自动合入未经 Win7 真机验收的代码。

`.github/workflows/sync-win7-upstream.yml` 每六小时检查一次，也可手动执行。
定时任务只有进入仓库默认分支后才生效；公开 fork 还需在 Actions 中启用相应工作流。
默认维护目标为默认分支，手动运行可指定已包含 Win7 构建入口的其他维护分支。
配置尚在 PR 中时不应声称定时任务已经启用。

唯一状态来源是 Git：目标分支 SHA、上游 SHA、确定性候选提交，以及该组合对应的同步 PR。
同一目标/上游组合重复执行复用同一候选分支和 PR；人工关闭的 PR 不自动重开。
上游无新提交时不安装依赖、不构建、不创建 PR。

## 合入策略

采用三方 merge 保留本仓库的 Win7 改动，禁止 reset 到上游或使用 theirs 强行解决应用代码冲突。
`.github/workflows/**` 是 fork 自己维护的控制面，始终保留目标分支版本，包括删除上游新增的 workflow。
这项排除会在同步 PR 中明确声明，表示同步应用源码，不宣称逐文件镜像上游。
应用代码出现冲突时 abort merge、列出冲突路径并失败，目标分支保持不动。
固定的社区 Electron 运行时及 SHA-256 不会因自动跟随而升级。

## 验证与凭据

控制工作流先在只读 job 中产生 Git bundle，再由只读 Linux job 执行类型、Lint、格式、测试、架构检查，
并由只读 Windows job 构建 Win7 包、运行 SQLite/WinPTY/搜索工具的最终包 smoke。
这些验证在同一个 workflow run 内显式衔接，不依赖机器人 push/PR 再触发另一套 CI。
现代 Windows smoke 仍不能替代 Win7 真机验收，实验标记保留。

只有全部验证成功，独立发布 job 才获取 contents/pull-requests 写权限。
该 job 重新检出可信控制代码，仅通过 Git 读取候选，不执行候选中的脚本或安装其依赖。
发布前复核目标分支 SHA；目标已移动则失败，等待下一轮重建。
候选使用包含目标 SHA 与上游 SHA 的专用分支；同名分支已被修改则拒绝覆盖，不 force push。
新 PR 的说明包含两个 SHA、运行链接、控制面排除及 Win7 真机验证边界。
上传、推送或创建 PR 失败必须使整个工作流失败，不能吞掉错误。

使用仓库内置 GITHUB_TOKEN，无需额外 PAT。仓库 Settings → Actions → General 的
“Allow GitHub Actions to create and approve pull requests” 需允许创建 PR；若禁止，发布步骤明确失败。
自动同步不发布正式 Release、不自动安装到用户电脑、不向常规桌面更新源投放安装包。

## 验收

1. 上游已是目标祖先：返回无变化，目标 SHA 不动，不产生 bundle。
2. 上游有独立功能变更：候选同时保留 Win7 补丁与新功能，且两个原提交都是其祖先。
3. 两方修改同一应用文件造成冲突：失败并清理 merge 状态，保留目标原文与 SHA。
4. 两方修改 workflow：保留目标 workflow，不引入上游新增 workflow；其余源码正常合入。
5. 相同两个 SHA 重试得到相同候选 SHA；已有 PR 不重复创建，人工关闭的 PR 不重开。
6. 类型/测试/构建/smoke 任一步失败，不执行写权限发布 job。
7. 构建期间目标分支发生移动，或候选分支出现人工提交：拒绝发布/覆盖。
8. 定时检查只有在默认分支工作流启用后才算已激活。
