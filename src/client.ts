/**
 * @dsh-external/session-console — client 面板。
 *
 * sidebar.footer.action：左下角「会话管理」入口（设置上方，IconListPenOutline16）→ 打开会话列表弹窗。
 * 数据源：host webServer API（/dsh-session-manager/api）——由 host 侧用 DSH 公开服务产出，
 * 可见性规则与官方侧边栏一致（隐藏空会话 / 归档 / 子代理），因此面板里的行 = 侧边栏里的行。
 *
 * 面板能力：工作区分组（可折叠）、标题、最近活动相对时间、轮次、日志大小、
 *          搜索、空/归档/子代理开关、未分组分组、空会话一键清理、单行删除。
 */
/** 本地最小契约（不 import DSH 包：编译不依赖 checkout，运行时由 __ModuleLoader__ 注入）。 */
type PrimitiveModule = Record<string, (props: any) => any>

interface Window { __ModuleLoader__: {
  load: (entry: {
    id: string
    factory: (require: (spec: string) => any) => unknown
  }) => void
} }

window.__ModuleLoader__.load({
  id: '@dsh-external/session-console',
  factory: (require) => {
    const API = '/dsh-session-manager/api'
    const React: any = require('react')
    const { useState, useEffect, useCallback, useMemo, useRef } = React
    const primitives: PrimitiveModule = require('@deepseek-ai/dsh-client-ui-primitives')

    /**
     * 图标解析：外层再包一层，避免图标缺失时把整个槽位注册炸掉。
     *
     * ⚠️ 官方 primitives 的图标**只导出两个变体**：`...Regular`（1px 细描边）
     * 与 `...Medium`（1.3px 中等描边）——**没有裸名**。例如存在
     * `IconListPenOutlineRegular` / `IconListPenOutlineMedium`，
     * 但**不存在** `IconListPenOutline`，也**不存在** `IconListPenOutline16`
     * （16 只是默认 size，从来不是名字的一部分）。
     *
     * 历史上这里写过 `primitives.IconListPenOutline16` → undefined → 被当 React
     * 组件渲染 → 整个槽位注册抛错、面板静默消失（桌面端与 web 端同样）；
     * 退成文字字符又会和官方 SVG 图标基线对不齐。所以先按官方命名取
     * Regular/Medium，取不到再退旧名，最后才降级成文字，任何一步都不抛错。
     */
    function resolveIcon(...names: string[]): any {
      for (const name of names) {
        const candidate: any = (primitives as any)[name]
        if (typeof candidate === 'function' || (candidate !== null && typeof candidate === 'object')) return candidate
      }
      return null
    }
    const IconListPen = resolveIcon('IconListPenOutlineRegular', 'IconListPenOutlineMedium', 'IconListPenOutline', 'IconListPenOutline16')
    if (IconListPen === null) console.warn('[session-console] 未找到可用的列表图标，入口退化为文字')

    const DSH_SM_CSS = [
      /**
       * 面板根：主区域占据者。
       *
       * ⚠️ 不要用 `position:absolute; inset:0`：桌面端（`[data-windows-titlebar]`）的
       * 应用框架已经用 `padding-top:var(--dsh-windows-titlebar-height)` 给窗口控制区
       * （─ □ ✕）留了位，那是**框架**的 padding；一旦 centerCol 不是定位祖先，
       * `inset:0` 就会锚到视口/框架，把面板顶到标题栏上去 —— 表现就是
       * 「顶部和桌面端顶部重叠、面板自己的头部被窗口按钮压住」。
       * 用正常文档流 + `height:100%` 才会规规矩矩落在标题栏下方。
       */
      '.dshsm-panel{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary)}',
      '.dshsm-panel-head{box-sizing:border-box;flex:none;display:flex;align-items:center;gap:10px;min-height:54px;padding:0 16px 0 18px;border-bottom:1px solid var(--dsw-alias-border-2,var(--dsw-alias-border-l3,#e8e8e8))}',
      '.dshsm-panel-title{font-size:15px;font-weight:500;line-height:24px}',
      '.dshsm-panel-body{flex:1;min-height:0;display:flex;flex-direction:column;padding:12px 18px 16px;overflow:hidden}',
      '.dshsm-body{color:var(--dsw-alias-label-primary,#222);font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.5}',
      '.dshsm-input{box-sizing:border-box;width:100%;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-2,#dcdcdc);background:transparent;color:inherit;font:inherit;outline:none}',
      '.dshsm-input:focus{border-color:var(--dsw-alias-brand-primary,#4a6cf7)}',
      '.dshsm-btn{cursor:pointer;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-2,#d5d5d5);background:transparent;color:inherit;font:inherit;white-space:nowrap}',
      '.dshsm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshsm-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.dshsm-btn-danger{background:#d33;border-color:#d33;color:#fff}',
      '.dshsm-btn-danger:hover:not(:disabled){background:#c02a2a}',
      '.dshsm-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-2,#e4e4e4);border-radius:8px;margin-bottom:6px;background:var(--dsw-alias-bg-layer-1,transparent)}',
      '.dshsm-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03))}',
      '.dshsm-group{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;margin:12px 0 6px;padding:5px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05));font-weight:600}',
      '.dshsm-muted{opacity:.62;font-size:11px}',
      '.dshsm-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:8px 0 2px}',
      '.dshsm-toggle{display:inline-flex;align-items:center;gap:4px;font-size:12px;opacity:.85;cursor:pointer;user-select:none}',
      '.dshsm-chip{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid currentColor;opacity:.85;white-space:nowrap}',
      '.dshsm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}',
      '.dshsm-row{position:relative;flex-wrap:wrap}.dshsm-row[data-selected="true"]{border-color:#a8bde6;background:rgba(100,140,220,.06)}',
      '.dshsm-more{border:0;background:transparent;color:inherit;cursor:pointer;flex:none;width:30px;height:30px;border-radius:8px;font-size:20px;line-height:20px}',
      '.dshsm-more:hover,.dshsm-more[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dshsm-menu-wrap{position:fixed;inset:auto;margin:0;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary,#222);overflow:visible}.dshsm-menu{display:flex;flex-direction:column;min-width:128px;padding:4px;border:1px solid var(--dsw-alias-border-2,#e4e4e4);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 6px 18px rgba(0,0,0,.16)}',
      '.dshsm-menu button{border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;padding:7px 12px;cursor:pointer;font:inherit}.dshsm-menu button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}.dshsm-menu button:disabled{opacity:.4;cursor:not-allowed}.dshsm-menu .dshsm-menu-danger{color:#d33}',
      '.dshsm-group{width:100%;border:0;color:inherit;font-family:inherit;text-align:left}',
      '.dshsm-group-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '@media(max-width:600px){.dshsm-group-path{display:none}.dshsm-row{align-items:flex-start}.dshsm-toolbar{gap:6px}.dshsm-title{overflow-wrap:anywhere}}',
    ].join('')
    if (typeof document !== 'undefined' && document.querySelector('style[data-dshsm="session-console"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.dshsm = 'session-console'
      tag.textContent = DSH_SM_CSS
      document.head.appendChild(tag)
    }

    /**
     * 当前选中会话：host 进程没有 DSH_SESSION_ID（那是 agent 子进程的 env），
     * 所以面板把 client 侧 sessions 服务的 current 传给 host：这样「当前」标记与
     * 「不能删当前会话」的判断才准确。服务不可用时返回 null（host 会退回 env）。
     */
    let currentSessionProvider: (() => string | null) | null = null
    function currentSessionId(): string | null {
      try {
        return currentSessionProvider === null ? null : currentSessionProvider()
      } catch {
        return null
      }
    }

    async function readResponse(r: Response): Promise<any> {
      if (r.status === 401) throw new Error('登录已失效，请从 Harness 启动窗口的链接重新打开页面。')
      let payload: any
      try { payload = await r.json() } catch { throw new Error(`服务返回了无效数据（HTTP ${r.status}），请刷新重试。`) }
      if (!r.ok && !payload.error && !payload.results) throw new Error(`请求失败（HTTP ${r.status}）`)
      return payload
    }

    async function apiGet(signal?: AbortSignal): Promise<any> {
      const current = currentSessionId()
      const suffix = current === null ? '' : `?current=${encodeURIComponent(current)}`
      const r = await fetch(API + '/sessions' + suffix, { credentials: 'include', signal })
      return readResponse(r)
    }

    async function apiPost(path: string, body: Record<string, unknown>): Promise<any> {
      const r = await fetch(API + path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, current: currentSessionId() }),
      })
      return readResponse(r)
    }

    function relTime(ms: number | null): string {
      if (!ms) return '—'
      const delta = Date.now() - ms
      if (delta < 60_000) return '刚刚'
      if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
      if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
      if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
      return new Date(ms).toLocaleDateString()
    }

    function fmtSize(bytes: number | null): string | null {
      if (bytes === null || bytes === undefined) return null
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    const chipColors: Record<string, string> = {
      当前: '#2f7d32',
      运行中: '#1a73e8',
      活动: '#1a73e8',
      空会话: '#b26a00',
      归档: '#777',
      子代理: '#7b1fa2',
      只读: '#8a6d3b',
      幽灵归档: '#a0522d',
    }

    function Chip(props: any) {
      return React.createElement('span', {
        className: 'dshsm-chip',
        style: { color: chipColors[props.label] ?? 'inherit' },
      }, props.label)
    }

    function rowFlags(s: any): string[] {
      const out: string[] = []
      if (s.current) out.push('当前')
      if (s.running) out.push('运行中')
      else if (s.live) out.push('已打开')
      if (s.blank) out.push('空会话')
      if (s.archived) out.push('归档')
      if (s.subagent) out.push('子代理')
      if (s.diskOnly) out.push('只读')
      if (s.ghost) out.push('幽灵归档')
      return out
    }

    /**
     * 未分组会话的「疑似归属」：把会话 cwd 与各工作区路径比对（Windows 路径大小写不敏感）。
     *
     * 为什么需要它：DSH 的工作区归属只认工作区自己登记的 sessionIds，而
     * `attachSession()` 还会**强制校验**会话 header 的 cwd 必须 realpath 到工作区路径。
     * 分叉/历史会话一旦 cwd 与任何已登记工作区不相等（例如 cwd 指向一个已经不存在、
     * 或从未登记的子目录），它就永远落在"未分组"，面板这边能做的只有：
     *   1. 找出 cwd 恰好等于某个工作区路径的会话 → 给一键归入；
     *   2. 对不上号的，明确说明"为什么不能归入"，而不是给一个点了没反应的按钮。
     */
    function normalizePath(value: unknown): string {
      if (typeof value !== 'string') return ''
      return value.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
    }

    function attachCandidates(row: any, workspaces: any[]): { exact: any[]; near: any[] } {
      const exact: any[] = []
      const near: any[] = []
      const cwd = normalizePath(row.cwd)
      const groupPath = normalizePath(row.groupPath)
      for (const workspace of workspaces) {
        if (String(workspace.id) === row.groupKey) continue
        const path = normalizePath(workspace.path)
        if (path === '') continue
        if (cwd !== '' && (path === cwd || path === groupPath)) exact.push(workspace)
        else if (cwd !== '' && (cwd.startsWith(path + '\\') || path.startsWith(cwd + '\\'))) near.push(workspace)
      }
      return { exact, near }
    }

    function SessionRowView(props: any) {
      const { row, rowBusy, anyBusy, onDelete, onArchive, onAttach, workspaces, multiSelect, selected, selectable, onSelect, menuOpen, onMenu } = props
      // 行内控件只看**本行**是否在忙；全局动作（prune/批量）用 anyBusy 兜底。
      const busy = rowBusy === true ? row.id : (anyBusy === true ? 'global' : null)
      const rowRef = useRef(null)
      const menuRef = useRef(null)
      useEffect(() => {
        if (!menuOpen) return
        const menu = menuRef.current
        if (menu) menu.showPopover()
        const position = () => {
          if (!menu || !rowRef.current) return
          const trigger = rowRef.current.querySelector('.dshsm-more').getBoundingClientRect()
          const rect = menu.getBoundingClientRect()
          menu.style.left = Math.max(8, Math.min(trigger.right - rect.width, window.innerWidth - rect.width - 8)) + 'px'
          menu.style.top = (trigger.bottom + rect.height + 8 <= window.innerHeight ? trigger.bottom + 4 : Math.max(8, trigger.top - rect.height - 4)) + 'px'
        }
        position()
        const closeOutside = (event: MouseEvent) => { if (!rowRef.current?.contains(event.target)) onMenu(null) }
        const closeKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onMenu(null); rowRef.current?.querySelector('.dshsm-more')?.focus() } }
        document.addEventListener('pointerdown', closeOutside)
        document.addEventListener('scroll', position, true)
        window.addEventListener?.('resize', position)
        rowRef.current?.addEventListener('keydown', closeKey)
        return () => { menu?.hidePopover(); document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('scroll', position, true); window.removeEventListener?.('resize', position); rowRef.current?.removeEventListener('keydown', closeKey) }
      }, [menuOpen])
      const meta: string[] = []
      meta.push(`最近活动 ${relTime(row.updatedAt)}`)
      if (row.turns > 0) meta.push(`${row.turns} 轮`)
      const size = fmtSize(row.sizeBytes)
      if (size !== null) meta.push(size)
      if (row.dir === null && !row.ghost) meta.push('无日志目录')
      const deletable = !row.current && !row.running && !row.ghost && !row.diskOnly
      const blockedReason = row.ghost
        ? '归档集里有这条 id，但会话目录已经不存在了，没有可删的对象'
        : row.diskOnly
          ? `${row.diskNote ?? '日志格式比当前 DSH 更新'}：只读展示，删除请到能读该格式的 DSH 里操作`
          : row.current
            ? '当前会话不能删除'
            : row.running
              ? '运行中的会话不能删除或归档。'
              : null
      const candidates = onAttach === undefined ? { exact: [], near: [] } : attachCandidates(row, workspaces)
      return React.createElement('div', { ref: rowRef, className: 'dshsm-row', 'data-selected': selected ? 'true' : 'false' },
        multiSelect && React.createElement('input', {
          type: 'checkbox',
          'aria-label': `选择 ${row.title ?? row.id}`,
          checked: selected,
          disabled: !selectable || busy !== null,
          title: selectable ? undefined : (blockedReason ?? '该条目不可删除，已从多选中排除'),
          onChange: () => onSelect(row.id),
        }),
        React.createElement('div', { style: { flex: '1', minWidth: '0' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
            React.createElement('span', { className: 'dshsm-title', style: { fontWeight: 600 } }, row.title ?? (row.ghost ? `（无对应会话）${row.id}` : row.diskOnly ? `（当前 DSH 读不到标题）${row.id}` : '（无标题会话）')),
            ...rowFlags(row).map((f: string) => React.createElement(Chip, { key: f, label: f })),
          ),
          React.createElement('div', { className: 'dshsm-muted', style: { marginTop: '2px' } }, meta.join(' · ')),
          row.diskOnly || row.ghost
            ? React.createElement('div', { className: 'dshsm-muted', style: { marginTop: '2px', color: '#8a6d3b' } }, row.ghost ? '归档集里有这条 id，但会话目录已不存在（幽灵归档标记）' : `${row.diskNote}；升级网页端 DSH 到同一版本即可正常读写`)
            : null,
          React.createElement('div', { className: 'dshsm-mono dshsm-muted', title: row.dir ? `日志目录: ${row.dir}` : '未找到会话目录' }, row.id),
        ),
        React.createElement('button', {
          type: 'button',
          className: 'dshsm-more',
          disabled: busy !== null,
          'aria-label': `更多操作 ${row.title ?? row.id}`,
          'aria-expanded': menuOpen,
          'aria-haspopup': 'menu',
          onClick: () => onMenu(menuOpen ? null : row.id),
        }, '⋯'),
        menuOpen && React.createElement('div', { ref: menuRef, popover: 'manual', className: 'dshsm-menu-wrap' },
          React.createElement('div', { className: 'dshsm-menu', role: 'menu', 'aria-label': '会话操作' },
            React.createElement('button', { type: 'button', role: 'menuitem', disabled: busy !== null || row.archived || row.running || row.diskOnly || row.ghost, onClick: () => { onMenu(null); onArchive(row) } }, row.archived ? '已归档' : '归档'),
            // 「归入工作区」：只对未分组、且 cwd 与某个工作区路径**完全一致**的会话可用
            // （官方 attachSession 会 realpath 校验 cwd === 工作区路径，对不上必然失败）。
            row.groupKey === '' && !row.diskOnly && !row.ghost
              ? (candidates.exact.length > 0
                ? candidates.exact.map((workspace: any) => React.createElement('button', {
                  key: 'attach-' + workspace.id,
                  type: 'button',
                  role: 'menuitem',
                  disabled: busy !== null,
                  onClick: () => { onMenu(null); onAttach(row, workspace) },
                }, `归入工作区「${workspace.title ?? workspace.id}」`))
                : React.createElement('button', {
                  type: 'button',
                  role: 'menuitem',
                  disabled: true,
                  title: `它的 cwd 是 ${row.cwd || '(空)'}，而已登记的工作区是 ${workspaces.map((w: any) => w.path).join('、') || '(无)'}；DSH 要求两者完全一致才能归入`,
                }, '无法归入：cwd 与工作区路径不一致'))
              : null,
            React.createElement('button', { type: 'button', role: 'menuitem', className: 'dshsm-menu-danger', disabled: !deletable || busy !== null, title: blockedReason ?? undefined, onClick: () => { onMenu(null); onDelete([row]) } }, '删除'),
          ),
        ),
      )
    }

    function SessionConsoleBody(props: { fill?: boolean }) {
      const fill = props.fill === true
      const [data, setData] = useState(null)
      const [status, setStatus] = useState('加载中…')
      const [error, setError] = useState(null)
      /**
       * 忙碌状态：`busyRowIds` 是**按行**的（正在删哪几行），`busy` 是全局动作
       * （prune / archive / 批量删除）。
       *
       * 以前是单一 `busy` 标志：删任意一行都会把**所有**行的「⋯」和工具栏按钮一起
       * 禁用，看起来像整个面板卡住。删一行时其余行不该失去交互能力。
       */
      const [busy, setBusy] = useState(null)
      // 不能写 useState<string[]>([])：React 是 any，未类型化调用不接受类型参数。
      const [busyRowIds, setBusyRowIds] = useState([] as string[])
      /**
       * 删除时是否连带删除子代理会话（默认关）。
       *
       * 默认关是刻意的：删父会话时子代理目录会变成孤儿（parentSession 指向已不存在的 id），
       * 但"连带删掉"是破坏性更强的行为，必须由人显式选择。打开时确认框里会写明。
       */
      const [withSubagents, setWithSubagents] = useState(false)
      const [loading, setLoading] = useState(false)
      const [query, setQuery] = useState('')
      const [showBlank, setShowBlank] = useState(false)
      const [showArchived, setShowArchived] = useState(false)
      const [showSubagents, setShowSubagents] = useState(false)
      /**
       * 「显示只读（新版日志）」——官方语料读不出、由 host 磁盘兜底补回来的会话。
       * 单独一个开关，不塞进「显示归档」：这类条目是"当前 DSH 读不到"，
       * 和"用户主动归档"是两回事，混在一起会让人误判归档数量。
       */
      const [showReadOnly, setShowReadOnly] = useState(false)
      const [groupFilter, setGroupFilter] = useState('')
      const [collapsed, setCollapsed] = useState({})
      const [multiSelect, setMultiSelect] = useState(false)
      const [selected, setSelected] = useState([])
      const [menuId, setMenuId] = useState(null)
      const mounted = useRef(true)
      const loadController = useRef(null)
      const actionLock = useRef(false)

      const load = useCallback(() => {
        loadController.current?.abort()
        const controller = new AbortController()
        loadController.current = controller
        setLoading(true)
        return apiGet(controller.signal)
          .then((p: any) => {
            if (!mounted.current || controller.signal.aborted) return
            if (!p.ok) { setError(p.error || '读取失败'); setStatus('读取失败'); return }
            setData(p)
            setSelected((previous: string[]) => previous.filter((id) => p.sessions?.some((s: any) => s.id === id && !s.current && !s.running)))
            setError(null)
            const st = p.stats ?? {}
            const parts = [`共 ${st.total ?? 0} 个会话`, `可见 ${st.visible ?? 0}`]
            if (st.blank) parts.push(`空会话 ${st.blank}`)
            if (st.archived) parts.push(`归档 ${st.archived}`)
            if (st.subagent) parts.push(`子代理 ${st.subagent}`)
            if (st.ungrouped) parts.push(`未分组 ${st.ungrouped}`)
            if (st.unreachable) parts.push(`只读·新版日志 ${st.unreachable}`)
            if (st.orphanArchived) parts.push(`幽灵归档 ${st.orphanArchived}`)
            setStatus(parts.join(' · '))
            if (Array.isArray(p.warnings) && p.warnings.length > 0) setError(p.warnings.join('；'))
          })
          .catch((e: any) => { if (mounted.current && !controller.signal.aborted) { setError(e.message ?? String(e)); setStatus('读取失败') } })
          .finally(() => { if (mounted.current && !controller.signal.aborted) setLoading(false) })
      }, [])

      useEffect(() => {
        mounted.current = true
        load()
        return () => { mounted.current = false; loadController.current?.abort() }
      }, [load])

      useEffect(() => { setSelected([]); setMenuId(null) }, [query, showBlank, showArchived, showSubagents, showReadOnly, groupFilter])

      /**
       * 幽灵归档标记自愈（每次打开面板最多自动跑一次，避免与用户操作打架）。
       *
       * 背景：DSH 没有 unarchive API，删除会话目录后 `archivedSessionIds` 会永久残留，
       * 于是统计里的「归档 N」永远大于列表里能看到的归档行。host 提供
       * `POST /repair-archives` 把「既不在语料、也不在磁盘」的 id 摘掉；这里只在
       * 检测到幽灵时才触发，正常情况零开销。任何失败都只是不修，不影响列表可用性。
       */
      const repairTried = useRef(false)
      useEffect(() => {
        if (repairTried.current) return
        const ids = data?.orphanArchivedIds
        if (!Array.isArray(ids) || ids.length === 0) return
        repairTried.current = true
        apiPost('/repair-archives', {})
          .then((r: any) => { if (r?.ok && Array.isArray(r.removed) && r.removed.length > 0) load() })
          .catch(() => { /* 修不了就只展示，不影响使用 */ })
      }, [data, load])

      const onDelete = async (rows: any[]) => {
        if (actionLock.current) return
        if (rows.length === 0) return
        // 确认框里**不再静默截断**：以前只列前 20 行就写"其余 N 个"，容易误删。
        // 全列出来（confirm 本身可滚动），批量很大时明确写清总数。
        const list = rows.map((row: any) => `· ${row.title ?? '（无标题）'}  ${row.id}`).join('\n')
        const subNote = withSubagents ? '\n\n⚠ 已勾选「连带删子代理」：这些会话的子代理会话会一并删除。' : ''
        if (!window.confirm(`确定删除 ${rows.length} 个会话？\n\n${list}${subNote}\n\n将关闭已打开的空闲会话并删除会话目录与工作区记录，不可恢复。`)) return
        actionLock.current = true
        const ids = rows.map((row: any) => row.id)
        setBusy('delete')
        setBusyRowIds(ids)
        try {
          const r = await apiPost('/delete', { ids, confirm: true, withSubagents })
          const successes = (r.results ?? []).filter((x: any) => x.ok).map((x: any) => x.id)
          setSelected((previous: string[]) => previous.filter((id) => !successes.includes(id)))
          const failures = (r.results ?? []).filter((x: any) => !x.ok)
          if (!r.ok || failures.length) window.alert(`已删除 ${successes.length}/${rows.length} 个会话\n` + (failures.map((x: any) => `${x.id}: ${x.error}`).join('\n') || r.error || '删除失败'))
          await load()
        } catch (e) {
          window.alert('删除失败: ' + String(e))
        } finally {
          actionLock.current = false
          if (mounted.current) { setBusy(null); setBusyRowIds([]) }
        }
      }

      const onArchive = async (row: any) => {
        if (actionLock.current) return
        actionLock.current = true
        setBusy('archive')
        setBusyRowIds([row.id])
        try {
          const r = await apiPost('/archive', { id: row.id })
          if (!r.ok) throw new Error(r.error || '归档失败')
          setSelected((previous: string[]) => previous.filter((id) => id !== row.id))
          await load()
        } catch (e) { window.alert('归档失败: ' + String(e)) }
        finally { actionLock.current = false; if (mounted.current) { setBusy(null); setBusyRowIds([]) } }
      }

      /**
       * 把一条「未分组」会话正式归入工作区（官方 workspaceRegistry 写链）。
       *
       * 官方 `attachSession()` 会校验会话 header 的 cwd 必须 realpath 等于工作区路径，
       * 因此 UI 只在 cwd 完全一致时给出这个入口；失败时把官方的原话原样弹出来，
       * 而不是静默无反应。
       */
      const onAttach = async (row: any, workspace: any) => {
        if (actionLock.current) return
        actionLock.current = true
        setBusy('attach')
        setBusyRowIds([row.id])
        try {
          const r = await apiPost('/attach', { id: row.id, workspaceId: String(workspace.id) })
          if (!r.ok) throw new Error(r.error || '归入工作区失败')
          await load()
        } catch (e) { window.alert('归入工作区失败: ' + String(e)) }
        finally { actionLock.current = false; if (mounted.current) { setBusy(null); setBusyRowIds([]) } }
      }

      const onPrune = async (kind: 'blank' | 'subagents') => {
        if (actionLock.current) return
        actionLock.current = true
        setBusy(kind)
        const label = kind === 'subagents' ? '非活跃子代理' : '空会话'
        const endpoint = kind === 'subagents' ? '/prune-subagents' : '/prune'
        try {
          const preview = await apiPost(endpoint, {})
          if (!preview.ok) throw new Error(preview.error || '无法预览待清理会话')
          const targets = preview.targets ?? []
          if (targets.length === 0) { window.alert(`没有可清理的${label}`); return }
          const list = targets.slice(0, 20).map((t: any) => `· ${t.title ?? '（无标题）'}  ${t.id}`).join('\n')
          const more = targets.length > 20 ? `\n… 其余 ${targets.length - 20} 个` : ''
          if (!window.confirm(`清理全部工作区的 ${targets.length} 个${label}（非当前、非运行、非归档）？\n\n${list}${more}\n\n${kind === 'subagents' ? '将删除子代理的会话日志，主会话不会删除。\n' : ''}不可恢复。`)) return
          const r = await apiPost(endpoint, { confirm: true, ids: targets.map((t: any) => t.id) })
          if (!r.ok) throw new Error(r.error || '清理失败')
          const okCount = (r.deleted ?? []).filter((d: any) => d.ok).length
          const failed = (r.deleted ?? []).filter((d: any) => !d.ok)
          window.alert(`已清理 ${okCount}/${targets.length} 个${label}` + (failed.length ? '\n' + failed.map((d: any) => `${d.id}: ${d.error}`).join('\n') : ''))
          await load()
        } catch (e) {
          window.alert('清理失败: ' + String(e))
        } finally {
          actionLock.current = false
          if (mounted.current) setBusy(null)
        }
      }

      const sessions: any[] = data?.sessions ?? []
      const current = data?.current ?? null
      const workspaces: any[] = data?.workspaces ?? []

      /**
       * 「幽灵归档」：归档集（workspaceRegistry.archivedSessionIds）里有这条 id，
       * 但磁盘上既没有会话目录、也没有语料行。
       *
       * 为什么必须显式列出来：官方只有 archiveSession、**没有 unarchive**，所以删除
       * 会话目录后归档标记会永久残留。以前面板对这类 id 完全不显示，用户看到的是
       * "统计说归档 23 条，列表里只有 10 条"——正是"有的归档我看不见"的另一半原因。
       * 这类条目只是把标记本身展示出来（告诉你这个 id 已经没有任何东西可删），
       * 因此不可选中、不可删除，也不会干扰多选。
       */
      const ghostRows = useMemo(() => {
        const ids: any[] = Array.isArray(data?.orphanArchivedIds) ? data!.orphanArchivedIds : []
        return ids.map((id: any) => ({
          id: String(id),
          title: null,
          groupKey: '',
          groupLabel: '未分组',
          groupPath: '',
          cwd: '',
          archived: true,
          blank: false,
          subagent: false,
          parentSessionId: null,
          live: false,
          canClose: false,
          running: false,
          current: false,
          seeded: false,
          diskOnly: false,
          ghost: true,
          diskNote: null,
          createdAt: 0,
          updatedAt: 0,
          lastPromptAt: null,
          turns: 0,
          steps: 0,
          sizeBytes: null,
          fileMtime: null,
          dir: null,
        }))
      }, [data])

      const listSessions = useMemo(
        () => (showArchived && !showReadOnly ? [...sessions.filter((s: any) => !s.diskOnly), ...ghostRows] : sessions),
        [sessions, ghostRows, showArchived, showReadOnly],
      )

      /**
       * 可见性谓词（列表与「全选」共用同一套规则，避免两处口径漂移）。
       *
       * `ignore` 用来在算「全选 X」作用域时**豁免 X 自己的那个开关**：
       * 「显示归档」没勾时，`全选归档` 仍然应该数得到归档——否则按钮永远是 0 且置灰，
       * 看起来就像"显示归档坏了"（真实踩坑：归档 10 条恰好全是子代理，
       * 子代理开关默认关，于是 `全选归档（0）`、而 `全选非归档（24）` 反把那 10 条
       * 归档算了进去，语义完全错乱）。豁免只针对按钮自己那一个维度，
       * 搜索/工作区筛选等正交条件一律照旧生效。
       */
      const matchesFilters = (s: any, ignore?: 'archived' | 'subagent'): boolean => {
        if (s.diskOnly && !showReadOnly) return false
        if ((s.subagent && !showSubagents) && ignore !== 'subagent') return false
        if ((s.archived && !showArchived) && ignore !== 'archived') return false
        if (s.blank && !s.current && !showBlank) return false
        if (groupFilter === '~~~') { if (s.groupKey !== '') return false } else if (groupFilter && s.groupKey !== groupFilter) return false
        const q = query.trim().toLowerCase()
        if (q) {
          const hay = `${s.title ?? ''} ${s.id} ${s.groupLabel} ${s.cwd}`.toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      }

      const filtered = useMemo(
        () => listSessions.filter((s: any) => matchesFilters(s)),
        [listSessions, query, showBlank, showArchived, showSubagents, showReadOnly, groupFilter],
      )

      const groups = useMemo(() => {
        const map = new Map<string, { key: string; label: string; path: string; rows: any[] }>()
        for (const s of filtered) {
          const gkey = s.groupKey === '' ? `~${s.groupLabel}` : s.groupKey
          const bucket = map.get(gkey)
          if (bucket) bucket.rows.push(s)
          else map.set(gkey, {
            key: gkey,
            label: s.groupKey === '' ? `未分组 · ${s.groupLabel}` : s.groupLabel,
            path: s.groupPath,
            rows: [s],
          })
        }
        // 工作区顺序沿用 host 的注册顺序（workspaces 数组），未分组置底
        const order = new Map<string, number>()
        ;(data?.workspaces ?? []).forEach((w: any, i: number) => order.set(w.id, i))
        return [...map.values()].sort((a, b) => {
          const ai = order.has(a.key) ? order.get(a.key)! : 10_000
          const bi = order.has(b.key) ? order.get(b.key)! : 10_000
          return ai - bi
        })
      }, [filtered, data])

      const toggleGroup = (key: string) => setCollapsed((prev: any) => ({ ...prev, [key]: !prev[key] }))
      /** 是否是可批量删除的对象：跳过当前会话、运行中、幽灵归档与只读条目。 */
      const isSelectable = (s: any): boolean => s.current !== true && s.running !== true && s.ghost !== true && s.diskOnly !== true
      const selectable = filtered.filter(isSelectable)
      const selectedRows = selectable.filter((s: any) => selected.includes(s.id))
      const toggleSelected = (id: string) => setSelected((previous: string[]) => previous.includes(id) ? previous.filter((x) => x !== id) : [...previous, id])
      /**
       * 快速全选：把满足条件的那部分**未选中**的行追加进选择集（不清空已选）。
       *
       * 为什么按条件而不是只留一个"全选当前结果"：面板里可见行经常混着归档、
       * 子代理、空会话三类，用户的实际诉求是"把归档的/子代理的全选出来删掉"，
       * 逐行勾太累；而一次把所有可见行（含正在用的主会话邻居）全勾上又太危险。
       * 所以给出一组收窄的全选按钮，删除前仍会二次确认。
       *
       * 作用域**不是**"当前可见行"（`filtered`），而是按维度豁免自己那个开关后的集合：
       * 「全选归档」在「显示归档」没勾时也要能圈到归档。同时点击时会把被藏住的维度
       * 自动打开（`reveal`），否则会出现"选中 10 条却只看得到 2 条"的悬空状态。
       * 删除前仍会逐条列出确认。
       */
      const selectMany = (rows: any[], reveal?: { archived?: boolean; subagent?: boolean }) => {
        if (reveal?.archived === true && !showArchived) setShowArchived(true)
        if (reveal?.subagent === true && !showSubagents) setShowSubagents(true)
        setSelected((previous: string[]) => {
          const next = new Set(previous)
          for (const row of rows) if (isSelectable(row)) next.add(row.id)
          return [...next]
        })
      }
      /**
       * 各维度的"全选"作用域。归档与子代理是**两个独立维度**，交集必须单独给按钮：
       * `全选归档` 是归档 ∩ 全部，`全选归档子代理` 才是 归档 ∩ 子代理。
       *
       * 关键修正：作用域用 `matchesFilters(s, 豁免自己那个开关)` 计算，而不是直接复用
       * `filtered`。归档 10 条全是子代理时，若复用 `filtered`（子代理开关默认关），
       * `全选归档` 会算成 0，而 `全选非归档` 反而把这 10 条归档吞进去——正是用户
       * 反馈的"显示归档了却不能全选归档"。
       */
      const bulk = {
        archived: listSessions.filter((s: any) => isSelectable(s) && s.archived === true && matchesFilters(s, 'archived')),
        active: listSessions.filter((s: any) => isSelectable(s) && s.archived !== true && matchesFilters(s, 'archived')),
        subagents: listSessions.filter((s: any) => isSelectable(s) && s.subagent === true && matchesFilters(s, 'subagent')),
        archivedSubagents: listSessions.filter((s: any) => isSelectable(s) && s.archived === true && s.subagent === true && matchesFilters(s, 'archived')),
        activeSubagents: listSessions.filter((s: any) => isSelectable(s) && s.archived !== true && s.subagent === true && matchesFilters(s, 'archived')),
      }
      /**
       * 「全选」按钮上的计数 = 实际会被选中的条数（`bulk.*`，已豁免该维度自己的显示开关）。
       *
       * 所以按钮数字与「显示归档/显示子代理」开关**无关**：截图里两个开关都没勾，
       * 按钮依然应显示 `全选归档（10）`，而不是恒为 0 的 0——那正是用户报的
       * "显示归档了却不能全选归档"（原实现把作用域绑在 `filtered` 上，而 `filtered`
       * 已经被开关裁过一遍）。
       *
       * 「有多少条现在看不到」用真实的 `sessions`／`filtered` 比较得出，不能用
       * `matchesFilters` 去算：那是**当前开关值**下的谓词，拿它过滤 `showArchived=false`
       * 得出的集合恒为空，提示会永远是 0。下面这两个提示是在渲染期现算的。
       */
      const hiddenByArchivedSwitch = sessions.filter((s: any) => bulk.archived.includes(s) && !filtered.includes(s)).length
      const hiddenBySubagentSwitch = sessions.filter((s: any) => bulk.subagents.includes(s) && !filtered.includes(s)).length
      const hiddenBySwitch = { archived: hiddenByArchivedSwitch, subagents: hiddenBySubagentSwitch }
      const bulkCounts = {
        archived: bulk.archived.length,
        active: bulk.active.length,
        subagents: bulk.subagents.length,
        archivedSubagents: bulk.archivedSubagents.length,
        activeSubagents: bulk.activeSubagents.length,
        selectable: selectable.length,
        selected: selectedRows.length,
      }

      const nodes: any[] = []
      for (const group of groups) {
        const isCollapsed = collapsed[group.key] === true
        nodes.push(React.createElement('button', {
          key: 'g-' + group.key,
          type: 'button',
          'aria-expanded': !isCollapsed,
          className: 'dshsm-group',
          onClick: () => toggleGroup(group.key),
          title: group.path,
        },
          React.createElement('span', null, isCollapsed ? '▸' : '▾'),
          React.createElement('span', null, group.label),
          React.createElement('span', { className: 'dshsm-muted' }, `${group.rows.length} 个`),
          React.createElement('span', { style: { flex: '1' } }),
          React.createElement('span', { className: 'dshsm-muted dshsm-group-path' }, group.path),
        ))
        if (isCollapsed) continue
        for (const row of group.rows) {
          nodes.push(React.createElement(SessionRowView, {
            key: row.id,
            row,
            rowBusy: busyRowIds.includes(row.id),
            // 全局动作（prune/清理子代理/批量删除）期间整表只读，避免并发写
            anyBusy: busy === 'blank' || busy === 'subagents' || busy === 'delete',
            onDelete,
            onArchive,
            onAttach,
            workspaces,
            multiSelect,
            selectable: isSelectable(row),
            selected: selected.includes(row.id),
            onSelect: toggleSelected,
            menuOpen: menuId === row.id,
            onMenu: setMenuId,
          }))
        }
      }
      if (nodes.length === 0 && data !== null) {
        nodes.push(React.createElement('div', { key: 'empty', className: 'dshsm-muted', style: { padding: '12px 4px' } },
          query || groupFilter ? '没有匹配的会话' : '（没有可见会话）'))
      }

      const listWrap = fill
        ? { flex: '1', minHeight: '0', overflowY: 'auto', paddingRight: '2px' }
        : { overflowY: 'auto', maxHeight: '420px', paddingRight: '2px' }
      const rootStyle = fill
        ? { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' }
        : {}

      const blankCount = sessions.filter((s: any) => s.blank && !s.running && !s.archived && !s.current).length
      const inactiveCount = sessions.filter((s: any) => s.subagent && !s.running && !s.archived && !s.current).length
      const readOnlyCount = sessions.filter((s: any) => s.diskOnly === true).length
      const ghostCount = Array.isArray(data?.orphanArchivedIds) ? data.orphanArchivedIds.length : 0
      const toggle = (label: string, checked: boolean, onChange: (v: boolean) => void) =>
        React.createElement('label', { className: 'dshsm-toggle' },
          React.createElement('input', { type: 'checkbox', checked, onChange: (e: any) => onChange(e.target.checked) }),
          label)

      return React.createElement('div', { className: 'dshsm-body', style: rootStyle },
        React.createElement('div', { role: 'status', 'aria-live': 'polite', style: { opacity: 0.75, marginBottom: '6px' } }, status),
        error !== null ? React.createElement('div', { role: 'alert', style: { color: '#c0392b', marginBottom: '6px', fontSize: '12px' } }, '⚠ ' + error) : null,
        React.createElement('div', { className: 'dshsm-toolbar' },
          React.createElement('input', {
            className: 'dshsm-input',
            style: { flex: '1 1 200px', width: 'auto' },
            placeholder: '搜索标题 / id / 路径…',
            'aria-label': '搜索会话',
            value: query,
            onChange: (e: any) => setQuery(e.target.value),
          }),
          React.createElement('select', {
            className: 'dshsm-input',
            style: { width: 'auto' },
            value: groupFilter,
            'aria-label': '筛选工作区',
            onChange: (e: any) => setGroupFilter(e.target.value),
          },
            React.createElement('option', { value: '' }, '全部工作区'),
            ...(data?.workspaces ?? []).map((w: any) => React.createElement('option', { key: w.id, value: w.id }, `${w.title}（${w.count}）`)),
            React.createElement('option', { value: '~~~' }, '（仅未分组）'),
          ),
          React.createElement('button', { type: 'button', className: 'dshsm-btn', disabled: loading || busy !== null, onClick: load }, loading ? '刷新中…' : '刷新'),
        ),
        React.createElement('div', { className: 'dshsm-toolbar', style: { marginBottom: '8px' } },
          React.createElement('button', { type: 'button', className: 'dshsm-btn', disabled: busy !== null, 'aria-pressed': multiSelect, onClick: () => { setMultiSelect(!multiSelect); setSelected([]); setMenuId(null) } }, multiSelect ? '取消多选' : '多选'),
          multiSelect && React.createElement('label', { className: 'dshsm-toggle' },
            React.createElement('input', { type: 'checkbox', checked: selectable.length > 0 && selectedRows.length === selectable.length, disabled: busy !== null || !selectable.length, onChange: (e: any) => setSelected(e.target.checked ? selectable.map((s: any) => s.id) : []) }), '全选当前结果'),
          // 收窄全选：归档 / 归档∩子代理 / 非归档∩子代理 / 全部子代理 四个作用域。
          // 计数与圈选都**豁免自己那个显示开关**（见 bulk 的注释），并在点击时自动把
          // 被藏住的维度打开，避免"选中了却看不见"；删除前仍逐条列确认。
          multiSelect && React.createElement('button', {
            type: 'button',
            className: 'dshsm-btn',
            disabled: busy !== null || bulkCounts.archived === 0,
            title: `把所有已归档会话加入选择（${bulkCounts.archived} 条，含其中的非子代理会话）`
              + (hiddenBySwitch.archived > 0 ? `；其中 ${hiddenBySwitch.archived} 条现在没显示（被「显示归档」/「显示子代理」挡着），点击后会一并选中并打开对应开关` : ''),
            onClick: () => selectMany(bulk.archived, { archived: true, subagent: true }),
          }, `全选归档（${bulkCounts.archived}）`),
          multiSelect && React.createElement('button', {
            type: 'button',
            className: 'dshsm-btn',
            disabled: busy !== null || bulkCounts.archivedSubagents === 0,
            title: `只把「已归档 且 是子代理」的会话加入选择（${bulkCounts.archivedSubagents} 条，归档与子代理的交集，不带非子代理的归档会话）`
              + (hiddenBySwitch.archived > 0 ? '；点击后会打开「显示子代理」以便核对' : ''),
            onClick: () => selectMany(bulk.archivedSubagents, { archived: true, subagent: true }),
          }, `全选归档子代理（${bulkCounts.archivedSubagents}）`),
          multiSelect && React.createElement('button', {
            type: 'button',
            className: 'dshsm-btn',
            disabled: busy !== null || bulkCounts.activeSubagents === 0,
            title: `只把「未归档 且 是子代理」的会话加入选择（${bulkCounts.activeSubagents} 条）`,
            onClick: () => selectMany(bulk.activeSubagents, { subagent: true }),
          }, `全选非归档子代理（${bulkCounts.activeSubagents}）`),
          multiSelect && React.createElement('button', {
            type: 'button',
            className: 'dshsm-btn',
            disabled: busy !== null || bulkCounts.subagents === 0,
            title: `把所有子代理会话加入选择（${bulkCounts.subagents} 条，归档与否都算；可用于清掉整个子代理树）`
              + (hiddenBySwitch.subagents > 0 ? `；其中 ${hiddenBySwitch.subagents} 条已归档、正被「显示归档」开关挡住，点击后会一并打开` : ''),
            onClick: () => selectMany(bulk.subagents, { archived: true, subagent: true }),
          }, `全选子代理（${bulkCounts.subagents}）`),
          multiSelect && React.createElement('button', { type: 'button', className: 'dshsm-btn', disabled: busy !== null || selectedRows.length === 0, onClick: () => setSelected([]) }, '清空选择'),
          multiSelect && React.createElement('button', { type: 'button', className: 'dshsm-btn dshsm-btn-danger', disabled: !selectedRows.length || busy !== null || loading, onClick: () => onDelete(selectedRows) }, busy === 'delete' ? '删除中…' : `删除所选（${selectedRows.length}）`),
          React.createElement('button', {
            type: 'button',
            className: 'dshsm-btn',
            disabled: blankCount === 0 || loading || busy !== null,
            title: blankCount === 0 ? '没有可清理的空会话' : `清理全部工作区的 ${blankCount} 个空会话（不受当前筛选影响，执行前会再次确认）`,
            onClick: () => onPrune('blank'),
          }, busy === 'blank' ? '清理中…' : `清理空会话${blankCount > 0 ? `（${blankCount}）` : ''}`),
          React.createElement('button', { type: 'button', className: 'dshsm-btn', disabled: !inactiveCount || loading || busy !== null, title: '清理全部工作区的非活跃子代理，执行前预览并确认；主会话不会删除', onClick: () => onPrune('subagents') }, busy === 'subagents' ? '清理中…' : `清理非活跃子代理（${inactiveCount}）`),
        ),
        React.createElement('div', { className: 'dshsm-toolbar', style: { marginTop: 0 } },
          toggle('显示空会话', showBlank, setShowBlank),
          toggle('显示归档', showArchived, setShowArchived),
          toggle('显示子代理', showSubagents, setShowSubagents),
          toggle('显示只读（新版日志）', showReadOnly, setShowReadOnly),
          toggle('删除时连带子代理', withSubagents, setWithSubagents),
          React.createElement('span', { className: 'dshsm-muted' },
            `列出 ${filtered.length} 行`
            + (bulkCounts.selected > 0 ? ` · 已选 ${bulkCounts.selected}` : '')),
        ),
        hiddenBySwitch.archived > 0
          ? React.createElement('div', { className: 'dshsm-muted', style: { marginBottom: '6px' } },
            `另有 ${hiddenBySwitch.archived} 条归档会话不在当前列表里（被「显示归档」/「显示子代理」开关藏着）；点「全选归档」会一并选中，并自动打开对应开关让你核对。`)
          : null,
        readOnlyCount > 0 && !showReadOnly
          ? React.createElement('div', { className: 'dshsm-muted', style: { marginBottom: '6px', color: '#8a6d3b' } },
            `另有 ${readOnlyCount} 条会话的日志格式更新（桌面端等更高版本 DSH 写入），当前 DSH 读不出正文；勾选「显示只读（新版日志）」查看。`)
          : null,
        ghostCount > 0 && (showArchived || showReadOnly)
          ? React.createElement('div', { className: 'dshsm-muted', style: { marginBottom: '6px', color: '#a0522d' } },
            `归档集里还有 ${ghostCount} 条 id 已经没有任何会话目录（历史删除留下的归档标记），已单独列出、不可删除。`)
          : null,
        React.createElement('div', { style: listWrap }, nodes),
      )
    }

    /**
     * `sidebar.panellist` 的图标。
     *
     * 官方 `PluginsPanelIcon` 的写法就是**直接返回图标**，不自己套尺寸容器 ——
     * 28×28 的居中盒子由官方 `.panelGlyph` 提供。照抄这个写法，图标大小与
     * 文字起点才会和「插件」那一行逐像素一致（自己再加 width/height/line-height
     * 反而会和官方盒子的 flex 居中打架，出现基线偏移）。
     */
    function SessionConsoleGlyph(props: any) {
      const size = typeof props?.size === 'number' ? props.size : 16
      if (IconListPen === null) return React.createElement('span', { 'aria-hidden': 'true' }, '≡')
      return React.createElement(IconListPen, { size })
    }

    /**
     * 全局面板本体：注册进 `main` 槽（keyed by PANEL_ID）。
     *
     * 切换靠侧边栏那一列（官方 `sidebar.panellist`），所以这里**不再放关闭按钮**：
     * 曾经那个 X 走 `ctx.layout.selectPanel(null)`，但 `ctx.slots.inject` 回调里拿到的
     * 是 slots 服务的子上下文，直接读 `ctx.layout` 会触发 cordis 的注入守卫抛错，
     * 又被自身的 catch 吞掉 —— 表现就是"点了没反应"。要去掉面板本来也只需点侧边栏
     * 的「对话」或「插件」，这个按钮属于多余控件，删掉更干净。
     */
    function SessionConsolePanel() {
      return React.createElement('div', { className: 'dshsm-panel', role: 'region', 'aria-label': '会话管理' },
        React.createElement('div', { className: 'dshsm-panel-head' },
          React.createElement('span', { className: 'dshsm-panel-title' }, '会话管理'),
        ),
        React.createElement('div', { className: 'dshsm-panel-body' },
          React.createElement(SessionConsoleBody, { fill: true }),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply: (ctx: any) => {
        currentSessionProvider = () => {
          let sessions: any = undefined
          try {
            sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
          } catch { /* 未注入 */ }
          if (sessions === undefined || sessions === null) {
            try { sessions = ctx.sessions } catch { /* 需要 inject：忽略 */ }
          }
          const snapshot = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
            ? sessions.list.getSnapshot()
            : null
          const cur = snapshot ? snapshot.current : null
          return typeof cur === 'string' && cur !== '' ? cur : null
        }

        /**
         * 入口 = 「插件的兄弟」（侧边栏上部那一列的全局面板图标）。
         *
         * 为什么不挂 sidebar.footer.action：网页端那里上方是「设置」行，桌面端把设置
         * 搬进了账号弹窗（`sidebar.settings` 变成账号芯片），底部那条不再是面板语义。
         *
         * 注意：old versions 的 `sidebar.panellist` 是**纯图标**槽（label 只用于原生
         * tooltip 与 aria-label），文字行由官方 PanelRow 用 options.label 自己渲染。
         */
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'session-console',
          order: 10,
          label: () => '会话管理',
        }, SessionConsoleGlyph))

        // 面板内容：keyed main 槽，entryKey 必须与上面的 id 一致
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'session-console',
        }, SessionConsolePanel))
      },
    }
  },
})
