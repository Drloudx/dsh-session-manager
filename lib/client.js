"use strict";
window.__ModuleLoader__.load({
    id: '@dsh-external/session-console',
    factory: (require) => {
        const API = '/dsh-session-manager/api';
        const React = require('react');
        const { useState, useEffect, useCallback, useMemo, useRef } = React;
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
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
        function resolveIcon(...names) {
            for (const name of names) {
                const candidate = primitives[name];
                if (typeof candidate === 'function' || (candidate !== null && typeof candidate === 'object'))
                    return candidate;
            }
            return null;
        }
        const IconListPen = resolveIcon('IconListPenOutlineRegular', 'IconListPenOutlineMedium', 'IconListPenOutline', 'IconListPenOutline16');
        if (IconListPen === null)
            console.warn('[session-console] 未找到可用的列表图标，入口退化为文字');
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
        ].join('');
        if (typeof document !== 'undefined' && document.querySelector('style[data-dshsm="session-console"]') === null) {
            const tag = document.createElement('style');
            tag.dataset.dshsm = 'session-console';
            tag.textContent = DSH_SM_CSS;
            document.head.appendChild(tag);
        }
        /**
         * 当前选中会话：host 进程没有 DSH_SESSION_ID（那是 agent 子进程的 env），
         * 所以面板把 client 侧 sessions 服务的 current 传给 host：这样「当前」标记与
         * 「不能删当前会话」的判断才准确。服务不可用时返回 null（host 会退回 env）。
         */
        let currentSessionProvider = null;
        function currentSessionId() {
            try {
                return currentSessionProvider === null ? null : currentSessionProvider();
            }
            catch {
                return null;
            }
        }
        async function readResponse(r) {
            if (r.status === 401)
                throw new Error('登录已失效，请从 Harness 启动窗口的链接重新打开页面。');
            let payload;
            try {
                payload = await r.json();
            }
            catch {
                throw new Error(`服务返回了无效数据（HTTP ${r.status}），请刷新重试。`);
            }
            if (!r.ok && !payload.error && !payload.results)
                throw new Error(`请求失败（HTTP ${r.status}）`);
            return payload;
        }
        async function apiGet(signal) {
            const current = currentSessionId();
            const suffix = current === null ? '' : `?current=${encodeURIComponent(current)}`;
            const r = await fetch(API + '/sessions' + suffix, { credentials: 'include', signal });
            return readResponse(r);
        }
        async function apiPost(path, body) {
            const r = await fetch(API + path, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ...body, current: currentSessionId() }),
            });
            return readResponse(r);
        }
        function relTime(ms) {
            if (!ms)
                return '—';
            const delta = Date.now() - ms;
            if (delta < 60_000)
                return '刚刚';
            if (delta < 3_600_000)
                return `${Math.floor(delta / 60_000)} 分钟前`;
            if (delta < 86_400_000)
                return `${Math.floor(delta / 3_600_000)} 小时前`;
            if (delta < 30 * 86_400_000)
                return `${Math.floor(delta / 86_400_000)} 天前`;
            return new Date(ms).toLocaleDateString();
        }
        function fmtSize(bytes) {
            if (bytes === null || bytes === undefined)
                return null;
            if (bytes < 1024)
                return `${bytes} B`;
            if (bytes < 1024 * 1024)
                return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        }
        const chipColors = {
            当前: '#2f7d32',
            运行中: '#1a73e8',
            活动: '#1a73e8',
            空会话: '#b26a00',
            归档: '#777',
            子代理: '#7b1fa2',
        };
        function Chip(props) {
            return React.createElement('span', {
                className: 'dshsm-chip',
                style: { color: chipColors[props.label] ?? 'inherit' },
            }, props.label);
        }
        function rowFlags(s) {
            const out = [];
            if (s.current)
                out.push('当前');
            if (s.running)
                out.push('运行中');
            else if (s.live)
                out.push('已打开');
            if (s.blank)
                out.push('空会话');
            if (s.archived)
                out.push('归档');
            if (s.subagent)
                out.push('子代理');
            return out;
        }
        function SessionRowView(props) {
            const { row, rowBusy, anyBusy, onDelete, onArchive, multiSelect, selected, onSelect, menuOpen, onMenu } = props;
            // 行内控件只看**本行**是否在忙；全局动作（prune/批量）用 anyBusy 兜底。
            const busy = rowBusy === true ? row.id : (anyBusy === true ? 'global' : null);
            const rowRef = useRef(null);
            const menuRef = useRef(null);
            useEffect(() => {
                if (!menuOpen)
                    return;
                const menu = menuRef.current;
                if (menu)
                    menu.showPopover();
                const position = () => {
                    if (!menu || !rowRef.current)
                        return;
                    const trigger = rowRef.current.querySelector('.dshsm-more').getBoundingClientRect();
                    const rect = menu.getBoundingClientRect();
                    menu.style.left = Math.max(8, Math.min(trigger.right - rect.width, window.innerWidth - rect.width - 8)) + 'px';
                    menu.style.top = (trigger.bottom + rect.height + 8 <= window.innerHeight ? trigger.bottom + 4 : Math.max(8, trigger.top - rect.height - 4)) + 'px';
                };
                position();
                const closeOutside = (event) => { if (!rowRef.current?.contains(event.target))
                    onMenu(null); };
                const closeKey = (event) => { if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    onMenu(null);
                    rowRef.current?.querySelector('.dshsm-more')?.focus();
                } };
                document.addEventListener('pointerdown', closeOutside);
                document.addEventListener('scroll', position, true);
                window.addEventListener?.('resize', position);
                rowRef.current?.addEventListener('keydown', closeKey);
                return () => { menu?.hidePopover(); document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('scroll', position, true); window.removeEventListener?.('resize', position); rowRef.current?.removeEventListener('keydown', closeKey); };
            }, [menuOpen]);
            const meta = [];
            meta.push(`最近活动 ${relTime(row.updatedAt)}`);
            if (row.turns > 0)
                meta.push(`${row.turns} 轮`);
            const size = fmtSize(row.sizeBytes);
            if (size !== null)
                meta.push(size);
            if (row.dir === null)
                meta.push('无日志目录');
            const deletable = !row.current && !row.running;
            const blockedReason = row.current
                ? '当前会话不能删除'
                : row.running
                    ? '运行中的会话不能删除或归档。'
                    : null;
            return React.createElement('div', { ref: rowRef, className: 'dshsm-row', 'data-selected': selected ? 'true' : 'false' }, multiSelect && React.createElement('input', { type: 'checkbox', 'aria-label': `选择 ${row.title ?? row.id}`, checked: selected, disabled: !deletable || busy !== null, title: blockedReason ?? undefined, onChange: () => onSelect(row.id) }), React.createElement('div', { style: { flex: '1', minWidth: '0' } }, React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }, React.createElement('span', { className: 'dshsm-title', style: { fontWeight: 600 } }, row.title ?? '（无标题会话）'), ...rowFlags(row).map((f) => React.createElement(Chip, { key: f, label: f }))), React.createElement('div', { className: 'dshsm-muted', style: { marginTop: '2px' } }, meta.join(' · ')), React.createElement('div', { className: 'dshsm-mono dshsm-muted', title: row.dir ? `日志目录: ${row.dir}` : '未找到会话目录' }, row.id)), React.createElement('button', {
                type: 'button',
                className: 'dshsm-more',
                disabled: busy !== null,
                'aria-label': `更多操作 ${row.title ?? row.id}`,
                'aria-expanded': menuOpen,
                'aria-haspopup': 'menu',
                onClick: () => onMenu(menuOpen ? null : row.id),
            }, '⋯'), menuOpen && React.createElement('div', { ref: menuRef, popover: 'manual', className: 'dshsm-menu-wrap' }, React.createElement('div', { className: 'dshsm-menu', role: 'menu', 'aria-label': '会话操作' }, React.createElement('button', { type: 'button', role: 'menuitem', disabled: busy !== null || row.archived || row.running, onClick: () => { onMenu(null); onArchive(row); } }, row.archived ? '已归档' : '归档'), React.createElement('button', { type: 'button', role: 'menuitem', className: 'dshsm-menu-danger', disabled: !deletable || busy !== null, title: row.current ? '当前会话不能删除，请先切换到其他会话' : blockedReason ?? undefined, onClick: () => { onMenu(null); onDelete([row]); } }, '删除'))));
        }
        function SessionConsoleBody(props) {
            const fill = props.fill === true;
            const [data, setData] = useState(null);
            const [status, setStatus] = useState('加载中…');
            const [error, setError] = useState(null);
            /**
             * 忙碌状态：`busyRowIds` 是**按行**的（正在删哪几行），`busy` 是全局动作
             * （prune / archive / 批量删除）。
             *
             * 以前是单一 `busy` 标志：删任意一行都会把**所有**行的「⋯」和工具栏按钮一起
             * 禁用，看起来像整个面板卡住。删一行时其余行不该失去交互能力。
             */
            const [busy, setBusy] = useState(null);
            // 不能写 useState<string[]>([])：React 是 any，未类型化调用不接受类型参数。
            const [busyRowIds, setBusyRowIds] = useState([]);
            /**
             * 删除时是否连带删除子代理会话（默认关）。
             *
             * 默认关是刻意的：删父会话时子代理目录会变成孤儿（parentSession 指向已不存在的 id），
             * 但"连带删掉"是破坏性更强的行为，必须由人显式选择。打开时确认框里会写明。
             */
            const [withSubagents, setWithSubagents] = useState(false);
            const [loading, setLoading] = useState(false);
            const [query, setQuery] = useState('');
            const [showBlank, setShowBlank] = useState(false);
            const [showArchived, setShowArchived] = useState(false);
            const [showSubagents, setShowSubagents] = useState(false);
            const [groupFilter, setGroupFilter] = useState('');
            const [collapsed, setCollapsed] = useState({});
            const [multiSelect, setMultiSelect] = useState(false);
            const [selected, setSelected] = useState([]);
            const [menuId, setMenuId] = useState(null);
            const mounted = useRef(true);
            const loadController = useRef(null);
            const actionLock = useRef(false);
            const load = useCallback(() => {
                loadController.current?.abort();
                const controller = new AbortController();
                loadController.current = controller;
                setLoading(true);
                return apiGet(controller.signal)
                    .then((p) => {
                    if (!mounted.current || controller.signal.aborted)
                        return;
                    if (!p.ok) {
                        setError(p.error || '读取失败');
                        setStatus('读取失败');
                        return;
                    }
                    setData(p);
                    setSelected((previous) => previous.filter((id) => p.sessions?.some((s) => s.id === id && !s.current && !s.running)));
                    setError(null);
                    const st = p.stats ?? {};
                    const parts = [`共 ${st.total ?? 0} 个会话`, `可见 ${st.visible ?? 0}`];
                    if (st.blank)
                        parts.push(`空会话 ${st.blank}`);
                    if (st.archived)
                        parts.push(`归档 ${st.archived}`);
                    if (st.subagent)
                        parts.push(`子代理 ${st.subagent}`);
                    if (st.ungrouped)
                        parts.push(`未分组 ${st.ungrouped}`);
                    setStatus(parts.join(' · '));
                    if (Array.isArray(p.warnings) && p.warnings.length > 0)
                        setError(p.warnings.join('；'));
                })
                    .catch((e) => { if (mounted.current && !controller.signal.aborted) {
                    setError(e.message ?? String(e));
                    setStatus('读取失败');
                } })
                    .finally(() => { if (mounted.current && !controller.signal.aborted)
                    setLoading(false); });
            }, []);
            useEffect(() => {
                mounted.current = true;
                load();
                return () => { mounted.current = false; loadController.current?.abort(); };
            }, [load]);
            useEffect(() => { setSelected([]); setMenuId(null); }, [query, showBlank, showArchived, showSubagents, groupFilter]);
            const onDelete = async (rows) => {
                if (actionLock.current)
                    return;
                if (rows.length === 0)
                    return;
                // 确认框里**不再静默截断**：以前只列前 20 行就写"其余 N 个"，容易误删。
                // 全列出来（confirm 本身可滚动），批量很大时明确写清总数。
                const list = rows.map((row) => `· ${row.title ?? '（无标题）'}  ${row.id}`).join('\n');
                const subNote = withSubagents ? '\n\n⚠ 已勾选「连带删子代理」：这些会话的子代理会话会一并删除。' : '';
                if (!window.confirm(`确定删除 ${rows.length} 个会话？\n\n${list}${subNote}\n\n将关闭已打开的空闲会话并删除会话目录与工作区记录，不可恢复。`))
                    return;
                actionLock.current = true;
                const ids = rows.map((row) => row.id);
                setBusy('delete');
                setBusyRowIds(ids);
                try {
                    const r = await apiPost('/delete', { ids, confirm: true, withSubagents });
                    const successes = (r.results ?? []).filter((x) => x.ok).map((x) => x.id);
                    setSelected((previous) => previous.filter((id) => !successes.includes(id)));
                    const failures = (r.results ?? []).filter((x) => !x.ok);
                    if (!r.ok || failures.length)
                        window.alert(`已删除 ${successes.length}/${rows.length} 个会话\n` + (failures.map((x) => `${x.id}: ${x.error}`).join('\n') || r.error || '删除失败'));
                    await load();
                }
                catch (e) {
                    window.alert('删除失败: ' + String(e));
                }
                finally {
                    actionLock.current = false;
                    if (mounted.current) {
                        setBusy(null);
                        setBusyRowIds([]);
                    }
                }
            };
            const onArchive = async (row) => {
                if (actionLock.current)
                    return;
                actionLock.current = true;
                setBusy('archive');
                setBusyRowIds([row.id]);
                try {
                    const r = await apiPost('/archive', { id: row.id });
                    if (!r.ok)
                        throw new Error(r.error || '归档失败');
                    setSelected((previous) => previous.filter((id) => id !== row.id));
                    await load();
                }
                catch (e) {
                    window.alert('归档失败: ' + String(e));
                }
                finally {
                    actionLock.current = false;
                    if (mounted.current) {
                        setBusy(null);
                        setBusyRowIds([]);
                    }
                }
            };
            const onPrune = async (kind) => {
                if (actionLock.current)
                    return;
                actionLock.current = true;
                setBusy(kind);
                const label = kind === 'subagents' ? '非活跃子代理' : '空会话';
                const endpoint = kind === 'subagents' ? '/prune-subagents' : '/prune';
                try {
                    const preview = await apiPost(endpoint, {});
                    if (!preview.ok)
                        throw new Error(preview.error || '无法预览待清理会话');
                    const targets = preview.targets ?? [];
                    if (targets.length === 0) {
                        window.alert(`没有可清理的${label}`);
                        return;
                    }
                    const list = targets.slice(0, 20).map((t) => `· ${t.title ?? '（无标题）'}  ${t.id}`).join('\n');
                    const more = targets.length > 20 ? `\n… 其余 ${targets.length - 20} 个` : '';
                    if (!window.confirm(`清理全部工作区的 ${targets.length} 个${label}（非当前、非运行、非归档）？\n\n${list}${more}\n\n${kind === 'subagents' ? '将删除子代理的会话日志，主会话不会删除。\n' : ''}不可恢复。`))
                        return;
                    const r = await apiPost(endpoint, { confirm: true, ids: targets.map((t) => t.id) });
                    if (!r.ok)
                        throw new Error(r.error || '清理失败');
                    const okCount = (r.deleted ?? []).filter((d) => d.ok).length;
                    const failed = (r.deleted ?? []).filter((d) => !d.ok);
                    window.alert(`已清理 ${okCount}/${targets.length} 个${label}` + (failed.length ? '\n' + failed.map((d) => `${d.id}: ${d.error}`).join('\n') : ''));
                    await load();
                }
                catch (e) {
                    window.alert('清理失败: ' + String(e));
                }
                finally {
                    actionLock.current = false;
                    if (mounted.current)
                        setBusy(null);
                }
            };
            const sessions = data?.sessions ?? [];
            const current = data?.current ?? null;
            const filtered = useMemo(() => {
                const q = query.trim().toLowerCase();
                return sessions.filter((s) => {
                    if (s.subagent && !showSubagents)
                        return false;
                    if (s.archived && !showArchived)
                        return false;
                    if (s.blank && !s.current && !showBlank)
                        return false;
                    if (groupFilter === '~~~') {
                        if (s.groupKey !== '')
                            return false;
                    }
                    else if (groupFilter && s.groupKey !== groupFilter)
                        return false;
                    if (q) {
                        const hay = `${s.title ?? ''} ${s.id} ${s.groupLabel} ${s.cwd}`.toLowerCase();
                        if (!hay.includes(q))
                            return false;
                    }
                    return true;
                });
            }, [sessions, query, showBlank, showArchived, showSubagents, groupFilter]);
            const groups = useMemo(() => {
                const map = new Map();
                for (const s of filtered) {
                    const gkey = s.groupKey === '' ? `~${s.groupLabel}` : s.groupKey;
                    const bucket = map.get(gkey);
                    if (bucket)
                        bucket.rows.push(s);
                    else
                        map.set(gkey, {
                            key: gkey,
                            label: s.groupKey === '' ? `未分组 · ${s.groupLabel}` : s.groupLabel,
                            path: s.groupPath,
                            rows: [s],
                        });
                }
                // 工作区顺序沿用 host 的注册顺序（workspaces 数组），未分组置底
                const order = new Map();
                (data?.workspaces ?? []).forEach((w, i) => order.set(w.id, i));
                return [...map.values()].sort((a, b) => {
                    const ai = order.has(a.key) ? order.get(a.key) : 10_000;
                    const bi = order.has(b.key) ? order.get(b.key) : 10_000;
                    return ai - bi;
                });
            }, [filtered, data]);
            const toggleGroup = (key) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
            const selectable = filtered.filter((s) => !s.current && !s.running);
            const selectedRows = selectable.filter((s) => selected.includes(s.id));
            const toggleSelected = (id) => setSelected((previous) => previous.includes(id) ? previous.filter((x) => x !== id) : [...previous, id]);
            const nodes = [];
            for (const group of groups) {
                const isCollapsed = collapsed[group.key] === true;
                nodes.push(React.createElement('button', {
                    key: 'g-' + group.key,
                    type: 'button',
                    'aria-expanded': !isCollapsed,
                    className: 'dshsm-group',
                    onClick: () => toggleGroup(group.key),
                    title: group.path,
                }, React.createElement('span', null, isCollapsed ? '▸' : '▾'), React.createElement('span', null, group.label), React.createElement('span', { className: 'dshsm-muted' }, `${group.rows.length} 个`), React.createElement('span', { style: { flex: '1' } }), React.createElement('span', { className: 'dshsm-muted dshsm-group-path' }, group.path)));
                if (isCollapsed)
                    continue;
                for (const row of group.rows) {
                    nodes.push(React.createElement(SessionRowView, {
                        key: row.id,
                        row,
                        rowBusy: busyRowIds.includes(row.id),
                        // 全局动作（prune/清理子代理/批量删除）期间整表只读，避免并发写
                        anyBusy: busy === 'blank' || busy === 'subagents' || busy === 'delete',
                        onDelete,
                        onArchive,
                        multiSelect,
                        selected: selected.includes(row.id),
                        onSelect: toggleSelected,
                        menuOpen: menuId === row.id,
                        onMenu: setMenuId,
                    }));
                }
            }
            if (nodes.length === 0 && data !== null) {
                nodes.push(React.createElement('div', { key: 'empty', className: 'dshsm-muted', style: { padding: '12px 4px' } }, query || groupFilter ? '没有匹配的会话' : '（没有可见会话）'));
            }
            const listWrap = fill
                ? { flex: '1', minHeight: '0', overflowY: 'auto', paddingRight: '2px' }
                : { overflowY: 'auto', maxHeight: '420px', paddingRight: '2px' };
            const rootStyle = fill
                ? { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' }
                : {};
            const blankCount = sessions.filter((s) => s.blank && !s.running && !s.archived && !s.current).length;
            const inactiveCount = sessions.filter((s) => s.subagent && !s.running && !s.archived && !s.current).length;
            const toggle = (label, checked, onChange) => React.createElement('label', { className: 'dshsm-toggle' }, React.createElement('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }), label);
            return React.createElement('div', { className: 'dshsm-body', style: rootStyle }, React.createElement('div', { role: 'status', 'aria-live': 'polite', style: { opacity: 0.75, marginBottom: '6px' } }, status), error !== null ? React.createElement('div', { role: 'alert', style: { color: '#c0392b', marginBottom: '6px', fontSize: '12px' } }, '⚠ ' + error) : null, React.createElement('div', { className: 'dshsm-toolbar' }, React.createElement('input', {
                className: 'dshsm-input',
                style: { flex: '1 1 200px', width: 'auto' },
                placeholder: '搜索标题 / id / 路径…',
                'aria-label': '搜索会话',
                value: query,
                onChange: (e) => setQuery(e.target.value),
            }), React.createElement('select', {
                className: 'dshsm-input',
                style: { width: 'auto' },
                value: groupFilter,
                'aria-label': '筛选工作区',
                onChange: (e) => setGroupFilter(e.target.value),
            }, React.createElement('option', { value: '' }, '全部工作区'), ...(data?.workspaces ?? []).map((w) => React.createElement('option', { key: w.id, value: w.id }, `${w.title}（${w.count}）`)), React.createElement('option', { value: '~~~' }, '（仅未分组）')), React.createElement('button', { type: 'button', className: 'dshsm-btn', disabled: loading || busy !== null, onClick: load }, loading ? '刷新中…' : '刷新')), React.createElement('div', { className: 'dshsm-toolbar', style: { marginBottom: '8px' } }, React.createElement('button', { type: 'button', className: 'dshsm-btn', disabled: busy !== null, 'aria-pressed': multiSelect, onClick: () => { setMultiSelect(!multiSelect); setSelected([]); setMenuId(null); } }, multiSelect ? '取消多选' : '多选'), multiSelect && React.createElement('label', { className: 'dshsm-toggle' }, React.createElement('input', { type: 'checkbox', checked: selectable.length > 0 && selectedRows.length === selectable.length, disabled: busy !== null || !selectable.length, onChange: (e) => setSelected(e.target.checked ? selectable.map((s) => s.id) : []) }), '全选当前结果'), multiSelect && React.createElement('button', { type: 'button', className: 'dshsm-btn dshsm-btn-danger', disabled: !selectedRows.length || busy !== null || loading, onClick: () => onDelete(selectedRows) }, busy === 'delete' ? '删除中…' : `删除所选（${selectedRows.length}）`), React.createElement('button', {
                type: 'button',
                className: 'dshsm-btn',
                disabled: blankCount === 0 || loading || busy !== null,
                title: blankCount === 0 ? '没有可清理的空会话' : `清理全部工作区的 ${blankCount} 个空会话（不受当前筛选影响，执行前会再次确认）`,
                onClick: () => onPrune('blank'),
            }, busy === 'blank' ? '清理中…' : `清理空会话${blankCount > 0 ? `（${blankCount}）` : ''}`), React.createElement('button', { type: 'button', className: 'dshsm-btn', disabled: !inactiveCount || loading || busy !== null, title: '清理全部工作区的非活跃子代理，执行前预览并确认；主会话不会删除', onClick: () => onPrune('subagents') }, busy === 'subagents' ? '清理中…' : `清理非活跃子代理（${inactiveCount}）`)), React.createElement('div', { className: 'dshsm-toolbar', style: { marginTop: 0 } }, toggle('显示空会话', showBlank, setShowBlank), toggle('显示归档', showArchived, setShowArchived), toggle('显示子代理', showSubagents, setShowSubagents), toggle('删除时连带子代理', withSubagents, setWithSubagents), React.createElement('span', { className: 'dshsm-muted' }, `列出 ${filtered.length} 行`)), React.createElement('div', { style: listWrap }, nodes));
        }
        /**
         * `sidebar.panellist` 的图标。
         *
         * 官方 `PluginsPanelIcon` 的写法就是**直接返回图标**，不自己套尺寸容器 ——
         * 28×28 的居中盒子由官方 `.panelGlyph` 提供。照抄这个写法，图标大小与
         * 文字起点才会和「插件」那一行逐像素一致（自己再加 width/height/line-height
         * 反而会和官方盒子的 flex 居中打架，出现基线偏移）。
         */
        function SessionConsoleGlyph(props) {
            const size = typeof props?.size === 'number' ? props.size : 16;
            if (IconListPen === null)
                return React.createElement('span', { 'aria-hidden': 'true' }, '≡');
            return React.createElement(IconListPen, { size });
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
            return React.createElement('div', { className: 'dshsm-panel', role: 'region', 'aria-label': '会话管理' }, React.createElement('div', { className: 'dshsm-panel-head' }, React.createElement('span', { className: 'dshsm-panel-title' }, '会话管理')), React.createElement('div', { className: 'dshsm-panel-body' }, React.createElement(SessionConsoleBody, { fill: true })));
        }
        return {
            inject: ['slots'],
            apply: (ctx) => {
                currentSessionProvider = () => {
                    let sessions = undefined;
                    try {
                        sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
                    }
                    catch { /* 未注入 */ }
                    if (sessions === undefined || sessions === null) {
                        try {
                            sessions = ctx.sessions;
                        }
                        catch { /* 需要 inject：忽略 */ }
                    }
                    const snapshot = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
                        ? sessions.list.getSnapshot()
                        : null;
                    const cur = snapshot ? snapshot.current : null;
                    return typeof cur === 'string' && cur !== '' ? cur : null;
                };
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
                }, SessionConsoleGlyph));
                // 面板内容：keyed main 槽，entryKey 必须与上面的 id 一致
                ctx.slots.inject('main', () => ctx.slots.register({
                    name: 'main',
                    key: 'session-console',
                }, SessionConsolePanel));
            },
        };
    },
});
//# sourceMappingURL=client.js.map