# @dsh-external/session-console

DSH 会话管理 **hybrid 插件**（host 工具 + webServer API + 侧边栏「会话管理」全局面板）。

## 能力

| 入口 | 说明 |
| --- | --- |
| `dsh_session_list` | 按工作区分组列出会话：标题 / 最近活动 / 创建时间 / 轮次 / 日志大小。默认可见性与左侧列表一致（隐藏空会话、归档、子代理）；`all: true` 或 `showBlank/showArchived/showSubagents` 展开 |
| `dsh_session_archived` | 只列归档会话，并提示归档集里已无对应会话（目录已删）的残留 id |
| `dsh_session_delete` | 删除会话：关闭空闲会话 → 等待写入结束 → 工作区账号摘除 → 删除会话目录与缓存。`confirm: true` 必填；当前和运行中的会话拒删；支持 `ids` 批量 |
| `dsh_session_prune` | 清理「空会话」（创建后从未提问、非当前、非运行、非归档）。默认 dry-run，`confirm: true` 才真删 |
| UI 面板 | 侧边栏上部「插件」下方新增一个全局面板图标（官方 `sidebar.panellist`）→ 中间列显示会话管理面板：工作区分组可折叠、搜索、工作区筛选、可见性开关、单行删除、一键清理空会话 |
| webServer API | `GET /dsh-session-manager/api/sessions?current=<id>`、`POST …/delete`、`POST …/prune`、`POST …/archive`、`POST …/prune-subagents` |

### 为什么是「全局面板」而不是「左下角弹窗」

官方 side bar 的槽位语义是固定的：

- `sidebar.settings`：侧边栏底部的**设置席**。网页端那里是「设置」行，**桌面端把它交给账号芯片**（点账号 → 设置/意见反馈/退出登录）。
- `sidebar.footer.action`：`settingsArea` **上方**的可选动作行。
- `sidebar.panellist`：侧边栏上部的**全局面板图标列**（官方「插件」就在这里），点击经 `ctx.layout.selectPanel(id)` 把中间列切成 `main` 槽里 `entryKey === id` 的面板。

会话管理本质是一块**面板**，所以挂 `sidebar.panellist` + `main`（`id`/`key` 都是 `session-console`）才与官方「插件」同构；挂在 footer 只会在桌面端变成账号行上方一个语义不明的按钮。切换回来就点侧边栏的「对话」/「插件」，因此面板内**不放关闭按钮**。

> 踩过的坑：`main` 面板根**不要**用 `position:absolute; inset:0`。桌面端（`[data-windows-titlebar]`）的应用框架用 `padding-top:var(--dsh-windows-titlebar-height)` 给窗口控制区留位，那是框架的 padding；一旦 `centerCol` 不是定位祖先，`inset:0` 会锚到视口/框架，面板就会顶到标题栏上、把窗口按钮盖住。用正常文档流 + `height:100%`。

面板顶部点击「多选」后可勾选会话、全选当前筛选结果，再点击「删除所选」。切换筛选会清空选择；当前和运行中的会话不能勾选删除。每行右侧「⋯」弹出原生 Popover 悬浮菜单，不改变行高、不受列表滚动裁切，底部空间不足时向上展开。归档调用 Harness 官方工作区接口，当前但未运行的会话也可归档，可通过「显示归档」查看。

「清理非活跃子代理」先预览所有工作区中非运行、非当前、非归档的子代理，确认后只提交预览的 ID；执行时重新检查状态，保留主会话。`POST …/prune-subagents` 省略 `confirm` 仅预览。

## 安全边界（写接口）

`POST /archive`、`/delete`、`/prune`、`/prune-subagents` 是**破坏性写操作**，而 DSH 的 HTTP 端口对所有本机进程开放，因此这些路由带信任栅栏：

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
- `sessions/<workspace>/<sessionId>/session.jsonl.zstd`：v3 会话日志名是
  `session.v3.jsonl.zstd`，只认旧名会导致 size/mtime 全为空（行里没有时间、排序错乱）。

可见性规则与官方侧边栏（`dsh-client-ui-workspace`）一致：

```
visible = origin !== 'subagent' && !archived && (!blank || id === current)
```

删除策略：`live` 仅表示「已打开到内存」，不等于运行中。

- 插件通过可卸载的 `AgentRegistry.create/resume` 方法适配保留返回的 `AgentHandle`（保留调用者上下文和返回对象）。删除时等待 `dispose()` 完成关闭、持久化排空和注销，再删除磁盘数据，不使用强删绕过。
- 运行中或当前会话仍拒删；归档的空闲会话同样可删除。早于适配安装且没有关闭句柄的会话会明确提示重启一次，不会强删日志。重启后正常打开的会话均可跟踪。
- 归档标记残留不会产生可见行（目录删除后该 id 同时离开语料），仅在返回步骤里提示。

## 构建

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

面板使用原生模态弹窗，避免其他悬浮插件遮挡；支持 Escape 关闭、焦点限制/恢复、键盘折叠分组和窄屏布局。
刷新中会显示状态，重复请求会取消旧请求；删除与清理互斥，清理只提交预览后确认的 ID。清理范围为全部工作区，不受搜索与筛选影响。
若 npm 因沙箱写不了默认缓存，加 `--cache ./.npm-cache`。

注入 / 热重载（注入器环境内）：`dev_inject_plugin <本目录>`、`dev_reload_package session-console`。
client 侧改动后浏览器需刷新一次页面才会用上新 bundle。
