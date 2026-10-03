# @dsh-external/session-console

DSH 会话管理 **hybrid 插件**（host 工具 + webServer API + 侧边栏「会话管理」全局面板）。

## 能力

| 入口 | 说明 |
| --- | --- |
| `dsh_session_list` | 按工作区分组列出会话：标题 / 最近活动 / 创建时间 / 轮次 / 日志大小。默认可见性与左侧列表一致（隐藏空会话、归档、子代理）；`all: true` 或 `showBlank/showArchived/showSubagents` 展开 |
| `dsh_session_archived` | 只列归档会话，并提示归档集里已无对应会话（目录已删）的残留 id |
| `dsh_session_delete` | 删除会话：关闭空闲会话 → 等待写入结束 → 工作区账号摘除 → 删除会话目录与缓存。`confirm: true` 必填；当前和运行中的会话拒删；支持 `ids` 批量 |
| `dsh_session_prune` | 清理「空会话」（创建后从未提问、非当前、非运行、非归档）。默认 dry-run，`confirm: true` 才真删 |
| UI 面板 | 侧边栏上部「插件」下方新增一个全局面板图标（官方 `sidebar.panellist`）→ 中间列显示会话管理面板：工作区分组可折叠、搜索、工作区筛选、可见性开关、多选批量删除（含**全选归档 / 全选非归档 / 全选子代理**）、单行删除与归档、未分组会话**一键归入工作区**、一键清理空会话 |
| webServer API | `GET /dsh-session-manager/api/sessions?current=<id>`、`POST …/delete`、`POST …/prune`、`POST …/archive`、`POST …/attach`、`POST …/repair-archives`、`POST …/prune-subagents` |

### 为什么是「全局面板」而不是「左下角弹窗」

官方 side bar 的槽位语义是固定的：

- `sidebar.settings`：侧边栏底部的**设置席**。网页端那里是「设置」行，**桌面端把它交给账号芯片**（点账号 → 设置/意见反馈/退出登录）。
- `sidebar.footer.action`：`settingsArea` **上方**的可选动作行。
- `sidebar.panellist`：侧边栏上部的**全局面板图标列**（官方「插件」就在这里），点击经 `ctx.layout.selectPanel(id)` 把中间列切成 `main` 槽里 `entryKey === id` 的面板。

会话管理本质是一块**面板**，所以挂 `sidebar.panellist` + `main`（`id`/`key` 都是 `session-console`）才与官方「插件」同构；挂在 footer 只会在桌面端变成账号行上方一个语义不明的按钮。切换回来就点侧边栏的「对话」/「插件」，因此面板内**不放关闭按钮**。

> 踩过的坑：`main` 面板根**不要**用 `position:absolute; inset:0`。桌面端（`[data-windows-titlebar]`）的应用框架用 `padding-top:var(--dsh-windows-titlebar-height)` 给窗口控制区留位，那是框架的 padding；一旦 `centerCol` 不是定位祖先，`inset:0` 会锚到视口/框架，面板就会顶到标题栏上、把窗口按钮盖住。用正常文档流 + `height:100%`。

面板顶部点击「多选」后可勾选会话、全选当前筛选结果，或用收窄的**全选归档 / 全选归档子代理 / 全选非归档子代理 / 全选子代理**按作用域圈选，再点击「删除所选」。这些快速全选只**追加**未选中的行、不覆盖已有选择，并且跳过当前会话 / 运行中 / 幽灵归档 / 只读条目；删除前仍会逐条列出确认。切换筛选会清空选择；当前和运行中的会话不能勾选删除。每行右侧「⋯」弹出原生 Popover 悬浮菜单，不改变行高、不受列表滚动裁切，底部空间不足时向上展开。归档调用 Harness 官方工作区接口，当前但未运行的会话也可归档，可通过「显示归档」查看。

> **全选按钮的两个设计约束**（都是踩坑后定下来的）：
>
> 1. **归档与子代理是两个独立维度，交集必须单独给按钮**。「全选归档 + 全选子代理」点两次得到的是**并集**，而"所有归档子代理"要的是**交集**——所以拆成 `全选归档`（归档 ∩ 全部）/ `全选归档子代理`（归档 ∩ 子代理）/ `全选非归档子代理`（非归档 ∩ 子代理）/ `全选子代理`（并集）。
> 2. **计数与作用域都豁免该维度自己的显示开关**。原实现把作用域绑在 `filtered`（已被开关裁过一遍）上，于是出现两个错乱：归档 10 条恰好全是子代理、而「显示子代理」默认关，`全选归档` 恒为 `0` 且置灰——看起来像"显示归档坏了"；同时 `全选非归档` 反把这 10 条归档吞了进去。现在按钮数字只反映"实际会选中多少条"，与开关无关；点下去会**自动打开**被藏住的开关，并在列表上方给出「另有 N 条归档会话不在当前列表里」的提示，避免"选中了却看不见"。

「显示只读（新版日志）」单独一个开关（不混进「显示归档」）：只读条目是「当前 DSH 读不出来」，与用户主动归档是两回事，混在一起会让人误判归档数量。归档集里已无对应目录的 id 会显示成「（无对应会话）+ 幽灵归档」行，不可选中，并给出统计说明。

「清理非活跃子代理」先预览所有工作区中非运行、非当前、非归档的子代理，确认后只提交预览的 ID；执行时重新检查状态，保留主会话。`POST …/prune-subagents` 省略 `confirm` 仅预览。

## ⚠️ 「有的归档我看不见」的两个真实原因（已修）

这是 2026-10 排查出来的现象：面板统计写着「归档 10 条」，列表里却对不上；部分会话在侧边栏和面板里**整体消失**。两个原因互不相干，必须分别处理：

### 原因 1：会话日志的格式版本比当前 DSH 新 → 官方列举整条跳过

会话日志是**带格式版本**的：`sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v<N>.jsonl.zstd`。

- `dsh-session` 的 `SESSION_FORMAT_VERSION`：**0.1.5-rc.2 = 3**、**0.2.0-rc.2 = 4**。
- `sessionPersistence.listArtifacts()` 只接受 ≤ 自己版本的 generation；版本更高的文件在
  `readGenerationHeader()` 里被判为 "future format"，返回 `undefined`，然后**整条会话被跳过**。
- 更坑的是 `resolveGenerationInDirectory()` 只取版本号**最大**的那个文件：一个目录里即使
  并排放着可读的 v3 和更高的 v4，也会因为选中 v4 而让整条会话从语料里消失（旁边的 v3 也不看）。

实测：磁盘 38 个会话目录，网页端 0.1.5-rc.2（v3）只能列出 22 个，另外 **16 个全是桌面端
0.2.0-rc.2 写出的 v4**。

**处理**：

1. **首选**：把两端升到同一版本（`npm i -g @deepseek-ai/dsh@0.2.0-rc.2`），升级后 16 条全部恢复正常读写。
2. 插件内保留**磁盘兜底索引**：把官方读不到的会话按目录约定直接读回 header，作为**只读**条目显示在
   它所属的工作区分组下（chip「只读」+ 说明「日志为 v4 格式，当前 DSH 只认到 v3」），并**拒绝删除/归档**
   它们——当前进程连正文都解析不了，不该去动更高版本 DSH 的数据。面板顶部会给出这类条目的数量提示。

### 原因 2：归档集里的「幽灵标记」

`workspaceRegistry.archivedSessionIds` 是**只增不减**的：官方只有 `archiveSession()`、**没有 unarchive**。
会话目录被删除后，这条 id 会永久留在归档集里——它不产生任何可见行，却让「归档 N」永远大于能看到的归档行。

**处理**：

- `POST /dsh-session-manager/api/repair-archives`：把「既不在语料、也不在磁盘」的 id 从归档集里摘掉，
  通过 `registry.setState()` 同时写库并更新**内存**快照，因此不需要重启。
- 面板打开时若检测到幽灵标记会自动调用一次（每次挂载最多一次），失败只影响修复、不影响列表。
- 命令行等价物：`node scripts/clean-ghost-archives.mjs [--apply]`（先备份 `workspace.json`）。
  ⚠️ **它必须在 dsh 停止时用**，否则运行中的进程会用内存里的旧集合把文件覆盖回去。

### 原因 3（分组）：为什么分叉会跑到「未分组」

工作区归属**只认 `Workspace.sessionIds`**，不是按路径推断的；而 `attachSession()` 还会**强制校验**
会话 header 的 `cwd` 必须 realpath 等于工作区路径、且该目录真实存在：

```
不能把分叉硬塞进 WORD 工作区：
  cannot attach session '…' to workspace 'E:\Desktop\WORD':
  its cwd 'E:\Desktop\langyangyang\WORD' does not resolve, so it cannot be validated
```

也不能「把父会话 cwd 改成 E:\Desktop\WORD」——`assertStoredIdentity()` 校验
「header 的 id+cwd 必须指向日志真实所在路径」，改了会话就打不开（要一致必须连目录一起搬）。

**插件的处理**：

- 次级分组兜底：没有工作区归属的行，再按 `cwd` 与工作区路径**等价匹配**归组（Windows 大小写不敏感），
  这样「日志确实写在工作区目录里、只是没登记进 sessionIds」的会话不会砸进未分组。口径统一在 host 层，
  面板统计与列表分组因此永远一致。
- 行菜单给出「归入工作区「X」」按钮（仅在 `cwd` 恰好等于某工作区路径时可用）；对不上号的显示灰色
  「无法归入：cwd 与工作区路径不一致」并带原因 tooltip，而不是点了没反应。

## 安全边界（写接口）

`POST /archive`、`/delete`、`/prune`、`/prune-subagents`、`/attach`、`/repair-archives` 是**破坏性写操作**，而 DSH 的 HTTP 端口对所有本机进程开放，因此这些路由带信任栅栏：

- 写操作的 **Host 必须是回环地址**（`127.0.0.1` / `localhost` / `[::1]`），否则 `403`
- 带 `Sec-Fetch-Site: cross-site` 的一律拒绝（防恶意网页打本机接口）
- `Origin` 存在时必须与可信来源同源
- 需要经反向代理/局域网管理时：`DSHW_ADMIN_HOSTS=host:port,other.host`（逗号分隔）显式放行

`GET` 只读接口不受限制。这些行为由 `scripts/check-prune.mjs` 覆盖（局域网 Host / 跨站标记 / 陌生 Origin 三种拒绝路径 + 回环同源放行）。

## 数据源（重要）

全部读 DSH **公开服务**，不再解析 storage 文件：

```
ctx.sessionQuery.listSessions()   全量逻辑会话（live 优先，含冷会话）
ctx.workspaceRegistry.list()      工作区实体 + 账号内会话 id（已按 cwd 表头校验过滤）
ctx.sessionProjectionCache        冷会话投影：cachedSnapshot(header, 0) ?? cachedPredecessorTitle(header, 0)
ctx.sessionProjections            活会话投影：cachedSnapshot(session)
ctx.sessions / ctx.agents         活状态 / 运行状态
```

历史数据源已失效，**不要再读**：

- `storages/session_projcache.json`：投影缓存已改为 per-record 布局
  （`storages/session_projcache/sessions/<sessionId>.json`，内容形如 `{version, record:{identity,rows}}`），
  旧的单文件只剩历史残留 → 读它会让**所有标题变成 null**（面板退化成显示工作区名）。
- `SessionProjectionCache.coldSnapshot(sid)`：签名已变为
  `coldSnapshot(meta, inheritedEventCount, events)`，旧的一参调用永远拿不到标题。
- 裸读 `storages/workspace.json`：绕过官方可见性规则（空会话 / 归档 / 子代理），
  面板会多出侧边栏根本没有的行。
- `sessions/<workspace>/<sessionId>/session.jsonl.zstd`：会话日志名带**格式版本**，
  现在是 `session.v<N>.jsonl.zstd`（0.1.5-rc.2 → v3，0.2.0-rc.2 → v4），只认旧名会导致
  size/mtime 全为空（行里没有时间、排序错乱）；反过来，**只信官方列举**又会让更高版本的
  日志整条消失，见上面「有的归档我看不见」一节。

可见性规则与官方侧边栏（`dsh-client-ui-workspace`）一致：

```
visible = origin !== 'subagent' && !archived && (!blank || id === current)
```

删除策略：`live` 仅表示「已打开到内存」，不等于运行中。

- 插件通过可卸载的 `AgentRegistry.create/resume` 方法适配保留返回的 `AgentHandle`（保留调用者上下文和返回对象）。删除时等待 `dispose()` 完成关闭、持久化排空和注销，再删除磁盘数据，不使用强删绕过。
- 运行中或当前会话仍拒删；归档的空闲会话同样可删除。早于适配安装且没有关闭句柄的会话会明确提示重启一次，不会强删日志。重启后正常打开的会话均可跟踪。
- 归档标记残留不会产生可见行（目录删除后该 id 同时离开语料），仅在返回步骤里提示。

## 升级网页端（与桌面端对齐）

网页端和桌面端共用同一个 `~/.dsh`（`sessions/`、`storages/`），但**版本可以不同**，于是会出现
"桌面端写得进去、网页端读不出来"的错位。2026-10 的处置：

```powershell
# 1) 备份当前全局安装（可回滚）
Copy-Item "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh" "$env:USERPROFILE\.dsh\dsh-backup-0.1.5-rc.2" -Recurse

# 2) 升级（npm 默认缓存在沙箱外，用本仓库内的缓存避免 EPERM；
#    路径换成你 clone 本仓库的位置，例如 E:\Desktop\html\.dsh-upgrade-preflight\npm-cache）
$env:npm_config_cache = '<本仓库路径>\.dsh-upgrade-preflight\npm-cache'
npm i -g '@deepseek-ai/dsh@0.2.0-rc.2'

# 3) 重启 dsh web（旧进程仍在跑旧代码）
#    本机没有 pwsh 7，用 Windows PowerShell + Bypass（默认执行策略禁止脚本）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-web.ps1 -WhatIfOnly   # 先只检查环境
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-web.ps1               # 再真重启
```

`restart-web.ps1` 不硬编码用户名/盘符：自动从 `PATH` 找 node、从 `npm root -g` 找 dsh 入口，
输出落到 `$DSH_HOME/logs/web-<端口>.out|err.log`；支持 `-Port` / `-Profile` / `-DshHome`。
⚠️ 脚本存为**带 BOM 的 UTF-8**：Windows PowerShell 5.1 按 ANSI 读取无 BOM 的 .ps1，
中文注释会被解成乱码并连带破坏词法分析（报 `Unexpected token`）。

回滚：把备份目录拷回 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh` 再重启。

升级后核对：`GET /dsh-session-manager/api/sessions` 里 `stats.unreachable` 应为 `0`。

只读诊断脚本：

- `node scripts/audit-disk-vs-corpus.mjs` —— 逐个解出磁盘 header，与官方语料对照，列出
  「磁盘有、语料没有」的会话及其日志版本（本次就是靠它定位到 v4 的）。
- `node scripts/clean-ghost-archives.mjs [--apply]` —— 清幽灵归档标记（**须在 dsh 停止时用**；
  运行中的进程会用内存里的旧集合把文件覆盖回去）。

## 构建

## 安装

仓库已包含构建好的 `lib/`，所以**不需要任何构建步骤**，clone 下来直接装即可。

```powershell
# 桌面端（Electron）：在桌面端的会话里让 DSH 自己装，它会用当前 profile（desktop）
#   直接把本仓库目录的绝对路径给它即可；也可用 --profile web 装到网页端 profile
dsh plugin --profile web add link:<本仓库绝对路径>
```

装完重启一次 Harness（或刷新页面），侧边栏「插件」下方会出现「会话管理」。

## 开发

`src/` 是唯一真源，`lib/` 全部由 tsc 产出（不再手工同步）。Host 使用 ESM；client 必须用 `tsconfig.client.json` 输出普通浏览器脚本，通过 `window.__ModuleLoader__.load` 注册。不要在 client 添加顶层 `import` / `export`，否则会让 Harness 合并加载的整包插件无法执行。

```bash
npm i -D typescript @types/node --legacy-peer-deps   # 仅首次（插件保持零运行时依赖）
npm run build        # src/index.ts → lib/index.js ; src/client.ts → lib/client.js
npm run typecheck    # 只类型检查
npm test             # 普通脚本加载、清理/批量删除/归档保护（隔离测试目录）
npm run smoke        # 无浏览器冒烟：用最小 React 运行时渲染 lib/client.js 并真调 host API
```

`scripts/build.mjs` 依次找 tsc：插件自带 `node_modules/typescript` → `DSH_CHECKOUT` 的 checkout。
构建会自动检查 client 能否作为普通脚本注册并重复加载，避免 Node 的 ESM 导入掩盖浏览器语法错误。
有 Web 登录校验时，通过 `DSH_WEB_URL` 环境变量传入 Harness 启动时输出的完整登录链接，或设置 `DSH_WEB_COOKIE` 后运行 smoke；测试仅允许 GET，不会删除真实会话。

面板是**全局面板**（官方 `main` 槽），不是弹窗；切换靠侧边栏那一列，所以面板内没有关闭按钮。列表支持分组折叠、多选批量删除、搜索与工作区筛选、窄屏布局。
刷新中会显示状态，重复请求会取消旧请求；删除与清理互斥，清理只提交预览后确认的 ID。清理范围为全部工作区，不受搜索与筛选影响。
若 npm 因沙箱写不了默认缓存，加 `--cache ./.npm-cache`。

### 改代码时容易踩的三个坑（都已在源码注释里标注）

1. **图标名只有两个变体**：官方 primitives 只导出 `...Regular` / `...Medium`，**没有裸名**，`16` 也从来不是名字的一部分。写错会拿到 `undefined`，被当 React 组件渲染时整个槽位注册抛错、面板静默消失。
2. **`SessionProjectionCache` 签名跨版本不同**：`0.1.5-rc.2` 是 `cachedSnapshot(meta, inheritedEventCount, keys)`，`0.2.0-rc.2` 是 `cachedSnapshot(meta, keys)`。传错第二个参数会抛 `SessionLogOffset must be a non-negative safe integer`，或者静默拿到空 values（标题全丢）。
3. **`main` 面板根不要用 `position:absolute; inset:0`**：桌面端框架用 `padding-top` 给窗口控制区留位，`inset:0` 会锚到视口，面板会顶到标题栏上。

注入 / 热重载（注入器环境内）：`dev_inject_plugin <本目录>`、`dev_reload_package session-console`。
client 侧改动后浏览器需刷新一次页面才会用上新 bundle。
