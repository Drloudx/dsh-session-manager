/**
 * @dsh-external/session-console — 会话管理器（hybrid 形态，零外部依赖）。
 *
 * 能力：列出全部会话（工作区分组 + 标题 + 活动时间）、查看归档、清理空会话、
 *      删除指定会话（host 工具 + webServer API 供 client 面板消费）。
 *
 * 数据源（全部走 DSH 公开服务，不再直接解析 storage 文件）：
 *   - ctx.sessionQuery.listSessions()      全量语料（live 优先，含冷会话）
 *   - ctx.workspaceRegistry.list()         工作区实体 + 账号内会话 id（已按 cwd 表头校验过滤）
 *   - ctx.sessionProjectionCache           冷会话投影缓存（标题 / 元数据）
 *   - ctx.sessionProjections               活会话投影（标题 / 元数据）
 *   - ctx.sessions / ctx.agents            活会话与运行状态
 *
 * 为什么不用 workspace.json / session_projcache.json：
 *   1. session_projcache 已从「单文件 tables.sessions」改为 per-record 布局
 *      （storages/session_projcache/sessions/<id>.json），旧单文件只剩历史残留；
 *   2. 投影缓存读法以官方实现为准（`dsh-session-projection-cache/lib/index.js`）：
 *      `cachedSnapshot(meta, keys?)`（keys = 要的投影键，可省略）与
 *      `cachedPredecessorTitle(meta)`（只有 meta）。**不要给它们传第二个位置参数**——
 *      早期版本签名里的 inheritedEventCount 会被当成 keys，导致
 *      `TypeError: number 0 is not iterable`、冷会话标题全部读不出来；
 *      旧名 `coldSnapshot` 在当前 DSH 上已不存在；
 *   3. 裸读 workspace.json 会绕过官方的可见性规则（空会话 / 归档 / 子代理），
 *      于是面板里会多出侧边栏根本没有的会话行。
 *
 * 可见性规则与官方侧边栏 (dsh-client-ui-workspace) 完全一致：
 *   visible = origin !== 'subagent' && !archived && (!blank || id === current)
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

/**
 * 本地最小 cordis 上下文契约（刻意不 import 'cordis' / '@deepseek-ai/*'：
 * 插件保持零外部运行时依赖，编译也不需要 DSH 源码 checkout）。
 */
type AppContext = {
  effect: (fn: () => unknown, label?: string) => void
  tools: { register: (tool: unknown) => unknown }
  webServer: { register: (route: unknown, label?: string) => unknown }
  get?: (key: string) => any
  [key: string]: any
}

export const name = '@dsh-external/session-console'
export const inject = ['tools', 'webServer', 'agents']

/** 单行会话信息（client 面板与 host 工具共用）。 */
interface SessionRow {
  id: string
  title: string | null
  /** 工作区 id（未分组为空串）。 */
  groupKey: string
  /** 分组显示名（工作区标题，或未分组时的 cwd 末段）。 */
  groupLabel: string
  /** 工作区根目录（未分组时为空串）。 */
  groupPath: string
  cwd: string
  archived: boolean
  blank: boolean
  subagent: boolean
  parentSessionId: string | null
  live: boolean
  canClose: boolean
  running: boolean
  current: boolean
  seeded: boolean
  /**
   * 磁盘兜底条目：官方语料**不含**这条会话（日志由更新版本的 DSH 写成，
   * 当前进程的 sessionPersistence 认不出这个 generation）。见 {@link diskIndex}。
   */
  diskOnly: boolean
  /** diskOnly 时：日志格式版本 + 为什么读不到。 */
  diskNote: string | null
  createdAt: number
  updatedAt: number
  lastPromptAt: number | null
  turns: number
  steps: number
  sizeBytes: number | null
  fileMtime: number | null
  dir: string | null
}

interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, { type: string; required?: boolean; description?: string; enum?: string[] }>
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (args: any) => unknown
}

/** Minimal spec → JSON Schema（defineTool 子集）。 */
function toJsonSchema(spec: Record<string, { type: string; enum?: string[]; description?: string; required?: boolean }>): {
  type: string
  properties: Record<string, unknown>
  required: string[]
  additionalProperties: boolean
} {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop: Record<string, unknown> = { type: meta.type }
    if (meta.type === 'array') prop.items = { type: 'string' }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** 取服务：优先 cordis 的 ctx.get（不需要 inject 声明），失败再退回属性访问。 */
function svc(ctx: AppContext, key: string): any {
  try {
    if (typeof (ctx as any).get === 'function') {
      const value = (ctx as any).get(key)
      if (value !== undefined && value !== null) return value
    }
  } catch { /* 未装配 */ }
  try {
    return (ctx as any)[key]
  } catch {
    return undefined
  }
}

function sessionDirName(cwd: string): string {
  // DSH 会话目录名：非字母数字全部折叠为 '-'，并在两端补 '-'（E:\Desktop\html → --E-Desktop-html--）。
  return '--' + cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '--'
}

export function apply(ctx: AppContext, config: { dshHome?: string } = {}): void {
  const dshHome = (config.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')).replace(/[\\/]+$/, '')
  const sessionsRoot = join(dshHome, 'sessions')
  const projCacheShards = join(dshHome, 'storages', 'session_projcache', 'sessions')

  /**
   * 列表面板需要的投影键（跟 `values.xxx` 的读取一一对应）。
   * 冷会话必须**显式**传这个数组给 `cachedSnapshot`，省略就拿不到标题/元数据。
   */
  const LISTING_KEYS = ['title', 'sessionListMetadata', 'sessionStats']

  // Compatibility adapter: preserve the caller's `this` and returned AgentHandle.
  // Harness lookup exposes only Agent; retain handles from public create/resume
  // so an explicit deletion can await the complete ordered lifecycle shutdown.
  const handles = new Map<string, any>()
  const deleting = new Set<string>()
  const agentRegistry = svc(ctx, 'agents')
  if (agentRegistry) ctx.effect(() => {
    const restores: Array<() => void> = []
    for (const method of ['create', 'resume']) {
      let owner = Object.getPrototypeOf(agentRegistry)
      while (owner && !Object.prototype.hasOwnProperty.call(owner, method)) owner = Object.getPrototypeOf(owner)
      if (!owner) continue
      const descriptor = Object.getOwnPropertyDescriptor(owner, method)!
      const original = descriptor.value
      if (typeof original !== 'function') continue
      const wrapped = async function (this: any, ...args: any[]) {
        const id = args[0]?.resumeSessionId ?? args[0]?.sessionId
        if (id && deleting.has(id)) throw new Error('会话正在删除，请稍后刷新列表')
        const handle = await original.apply(this, args)
        if (handle?.agent && typeof handle.dispose === 'function' && agentRegistry.get(handle.agent.id) === handle.agent) {
          handles.set(handle.agent.id, handle)
        }
        return handle
      }
      Object.defineProperty(owner, method, { ...descriptor, value: wrapped })
      restores.push(() => { if (owner[method] === wrapped) Object.defineProperty(owner, method, descriptor) })
    }
    const off = typeof ctx.on === 'function' ? ctx.on('agent/disposed', ({ agent }: any) => {
      if (handles.get(agent.id)?.agent === agent) handles.delete(agent.id)
    }) : undefined
    return () => { restores.reverse().forEach((restore) => restore()); off?.(); handles.clear() }
  }, 'session-console: agent lifecycle handles')

  const log = (level: 'info' | 'warn', message: string, ...args: unknown[]): void => {
    const logger = svc(ctx, 'logger')
    try {
      if (logger && typeof logger[level] === 'function') logger[level](message, ...args)
    } catch { /* 日志不可用 */ }
  }

  // ───────── 磁盘索引（会话目录 / 日志文件），5s 缓存避免逐行 stat ─────────
  let dirIndexAt = 0
  let dirIndex = new Map<string, string>()

  function scanSessionDirs(): Map<string, string> {
    const now = Date.now()
    if (now - dirIndexAt < 5000 && dirIndex.size > 0) return dirIndex
    const found = new Map<string, string>()
    try {
      for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const groupDir = join(sessionsRoot, entry.name)
        // 新布局：sessions/<workspace-dir>/<sessionId>/ ；兼容扁平布局：sessions/<sessionId>/
        if (entry.name.startsWith('session-')) found.set(entry.name, groupDir)
        let children: any[] = []
        try {
          children = readdirSync(groupDir, { withFileTypes: true })
        } catch { continue }
        for (const child of children) {
          if (child.isDirectory()) found.set(child.name, join(groupDir, child.name))
        }
      }
      dirIndex = found
      dirIndexAt = now
    } catch { /* sessions 根目录不存在 */ }
    return dirIndex
  }

  /** 会话日志文件：v1/v2 = session.jsonl.zstd，v3 = session.v3.jsonl.zstd（旧代码只认前者）。 */
  function logFileOf(dir: string): string | null {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return null
    }
    const logs = names.filter((n) => /^session(\.[^.]+)*\.jsonl(\.zstd)?$/.test(n))
    if (logs.length === 0) return null
    logs.sort((a, b) => {
      const av = a.includes('.v') ? Number(a.match(/\.v(\d+)\./)?.[1] ?? 0) : 0
      const bv = b.includes('.v') ? Number(b.match(/\.v(\d+)\./)?.[1] ?? 0) : 0
      return bv - av
    })
    return join(dir, logs[0])
  }

  function diskInfo(id: string): { dir: string | null; sizeBytes: number | null; fileMtime: number | null } {
    const dir = scanSessionDirs().get(id) ?? null
    if (dir === null) return { dir: null, sizeBytes: null, fileMtime: null }
    const file = logFileOf(dir)
    if (file === null) return { dir, sizeBytes: null, fileMtime: null }
    try {
      const st = statSync(file)
      return { dir, sizeBytes: st.size, fileMtime: st.mtimeMs }
    } catch {
      return { dir, sizeBytes: null, fileMtime: null }
    }
  }

  // ───────── 磁盘兜底索引：官方语料读不到的会话（更新版本的日志） ─────────
  /**
   * 为什么需要这一层（真实故障复盘）：
   *
   * 会话日志是**带格式版本**的：`session.v<N>.jsonl.zstd`。官方列举只在
   * `sessionPersistence.listArtifacts()` 里接受 ≤ 自己 `SESSION_FORMAT_VERSION`
   * 的 generation —— 版本更高的文件会被 `readGenerationHeader()` 判为
   * "future format" 返回 undefined 然后**整条会话被跳过**。更坑的是
   * `resolveGenerationInDirectory()` 只取版本号最大的那个文件，所以一个目录里
   * 即使并排放着可读的 v3 和更高版本的 v4，也会因为选中 v4 而把整条会话
   * 从语料里抹掉（v3 就在旁边也不看）。
   *
   * 结果：网页端 DSH 0.1.5-rc.2（只认 v3）打开时，桌面端 0.2.0-rc.2 写过的
   * 16 条 v4 会话在侧边栏和本面板里**全部消失**——不是被归档、也不是被删除，
   * 而是"读不出来"。归档标记（workspaceRegistry.archivedSessionIds）却仍留着，
   * 于是出现"归档 10 条但我找不到"的错位。
   *
   * 这一层直接按目录约定读回 header（`sessions/<projectKey(cwd)>/<encodeSegment(id)>/`），
   * 把这类会话作为**只读**条目放回面板：看得见、看得清原因，但不可删/不可归档
   * （当前进程连它的正文都解析不了，更不该去动它）。
   */
  const SESSION_FORMAT_READABLE = 3
  const DISK_SCAN_TTL_MS = 5000
  let diskIndexAt = 0
  let diskIndexCache: Map<string, DiskEntry> | null = null

  interface DiskEntry {
    id: string
    header: any
    dir: string
    /** 最新 generation 的文件名与版本号（例如 session.v4.jsonl.zstd / 4）。 */
    fileName: string
    version: number
    /** 该目录里存在、但版本高于本进程可读上限的最大版本（= 为什么被跳过）。 */
    futureVersion: number | null
    mtimeMs: number | null
    sizeBytes: number | null
  }

  /** 解析 `session.v<N>.jsonl[.zstd]`；非规范名返回 undefined。 */
  function parseGenerationName(name: string): { version: number; compressed: boolean } | undefined {
    const match = /^session\.v([1-9][0-9]*)\.jsonl(\.zstd)?$/.exec(name)
    if (match === null) return undefined
    return { version: Number(match[1]), compressed: match[2] !== undefined }
  }

  /** 只读 header：v3 是明文帧、更高版本首个 zstd 帧解出来就是完整 header。 */
  function readLogHeader(file: string, compressed: boolean): any | null {
    let buf: Buffer
    try {
      buf = readFileSync(file)
    } catch {
      return null
    }
    let text: string
    if (compressed) {
      try {
        text = zstdDecompressSync(buf).toString('utf8')
      } catch {
        try {
          text = zstdDecompressSync(buf.subarray(0, Math.min(buf.length, 1 << 18))).toString('utf8')
        } catch {
          return null
        }
      }
    } else {
      text = buf.toString('utf8')
    }
    const line = text.split('\n', 1)[0]
    if (!line) return null
    try {
      const parsed = JSON.parse(line)
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /** 磁盘兜底索引：只扫一层 project / session 目录，5s 缓存，任何异常都降级为空。 */
  function diskIndex(): Map<string, DiskEntry> {
    const now = Date.now()
    if (diskIndexCache !== null && now - diskIndexAt < DISK_SCAN_TTL_MS) return diskIndexCache
    const found = new Map<string, DiskEntry>()
    try {
      for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!project.isDirectory()) continue
        const projectPath = join(sessionsRoot, project.name)
        let sessionDirs: any[] = []
        try {
          sessionDirs = readdirSync(projectPath, { withFileTypes: true })
        } catch { continue }
        for (const entry of sessionDirs) {
          if (!entry.isDirectory()) continue
          const dir = join(projectPath, entry.name)
          let names: string[] = []
          try {
            names = readdirSync(dir)
          } catch { continue }
          const generations = names
            .map((name) => ({ name, parsed: parseGenerationName(name) }))
            .filter((item): item is { name: string; parsed: { version: number; compressed: boolean } } => item.parsed !== undefined)
            .sort((a, b) => b.parsed.version - a.parsed.version)
          const latest = generations[0]
          if (latest === undefined) continue
          const header = readLogHeader(join(dir, latest.name), latest.parsed.compressed)
          const id = typeof header?.id === 'string' ? header.id : entry.name
          if (!id) continue
          let mtimeMs: number | null = null
          let sizeBytes: number | null = null
          try {
            const st = statSync(join(dir, latest.name))
            mtimeMs = st.mtimeMs
            sizeBytes = st.size
          } catch { /* 文件刚被移走：留空 */ }
          const future = generations.filter((g) => g.parsed.version > SESSION_FORMAT_READABLE)
          found.set(id, {
            id,
            header,
            dir,
            fileName: latest.name,
            version: latest.parsed.version,
            futureVersion: future.length > 0 ? future[0].parsed.version : null,
            mtimeMs,
            sizeBytes,
          })
        }
      }
    } catch { /* sessions 根目录不可读：退回官方语料 */ }
    diskIndexCache = found
    diskIndexAt = now
    return found
  }

  /** 本进程读不到的会话（磁盘有、官方语料没有），按新→旧排序。 */
  function unreachableEntries(officialIds: Set<string>): DiskEntry[] {
    const out: DiskEntry[] = []
    for (const entry of diskIndex().values()) {
      if (officialIds.has(entry.id)) continue
      if (!entry.header || typeof entry.header.id !== 'string') continue
      out.push(entry)
    }
    return out
  }

  // ───────── 官方服务读取 ─────────
  interface Corpus {
    rows: SessionRow[]
    workspaces: Array<{ id: string; title: string; path: string; count: number }>
    archivedIds: string[]
    /** 归档集里已经没有任何会话目录、也没有语料的 id（"幽灵归档标记"）。 */
    orphanArchivedIds: string[]
    current: string | null
    warnings: string[]
  }

  async function collect(options: { current?: string | null } = {}): Promise<Corpus> {
    const warnings: string[] = []
    // 当前会话：host 进程通常没有 DSH_SESSION_ID（那是 agent 子进程的 env），
    // 所以优先用 client 传上来的「当前选中会话」，env 只作兜底。
    const envCurrent = process.env.DSH_SESSION_ID || null
    const current = options.current || envCurrent
    const registry = svc(ctx, 'workspaceRegistry')
    const query = svc(ctx, 'sessionQuery')
    const cache = svc(ctx, 'sessionProjectionCache')
    const projections = svc(ctx, 'sessionProjections')
    const store = svc(ctx, 'sessions')
    const agents = svc(ctx, 'agents')

    // 工作区实体（sessionIds 已被官方按 cwd 表头校验过滤）
    const workspaces: Array<{ id: string; title: string; path: string; count: number }> = []
    const owner = new Map<string, { key: string; label: string; path: string }>()
    try {
      for (const ws of registry?.list?.() ?? []) {
        const ids: string[] = Array.isArray(ws.sessionIds) ? [...ws.sessionIds] : []
        workspaces.push({ id: String(ws.id), title: String(ws.title ?? ws.id), path: String(ws.path ?? ''), count: ids.length })
        for (const sid of ids) {
          if (!owner.has(sid)) owner.set(sid, { key: String(ws.id), label: String(ws.title ?? ws.id), path: String(ws.path ?? '') })
        }
      }
    } catch (e) {
      warnings.push('workspaceRegistry 读取失败: ' + String(e))
    }

    let archivedIds: string[] = []
    try {
      archivedIds = [...(registry?.archivedSessionIds ?? [])].map(String)
    } catch (e) {
      warnings.push('归档集读取失败: ' + String(e))
    }
    const archived = new Set(archivedIds)

    /**
     * 工作区路径 → 分组（Windows 路径大小写不敏感）。
     *
     * 官方 `Workspace.sessionIds` 是**校验过 cwd 的**投影，所以磁盘兜底条目和
     * 源目录被移动过的会话都不在里面。只按 sessionIds 分组会让它们全掉进"未分组"，
     * 把真正"没有归属"的会话淹掉。这里补一层 cwd → 工作区路径的等价匹配，
     * 让"日志写在某工作区目录里的会话"仍然显示在对应工作区分组下。
     */
    const byCwd = new Map<string, { key: string; label: string; path: string }>()
    const normCwd = (value: string): string => value.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
    for (const ws of workspaces) {
      const key = normCwd(String(ws.path ?? ''))
      if (key === '') continue
      if (!byCwd.has(key)) byCwd.set(key, { key: String(ws.id), label: String(ws.title ?? ws.id), path: String(ws.path ?? '') })
    }

    // 语料：live 优先的完整逻辑会话集；服务缺失时退回持久层列举
    let records: Array<{ header: any; live: boolean; persisted: boolean }> = []
    try {
      if (query && typeof query.listSessions === 'function') {
        records = await query.listSessions()
      } else {
        const persistence = svc(ctx, 'sessionPersistence')
        const snapshots = (await persistence?.list?.()) ?? []
        records = snapshots.map((s: any) => ({ header: s.header, live: false, persisted: true }))
        warnings.push('sessionQuery 未装配，已退回 sessionPersistence.list()')
      }
    } catch (e) {
      warnings.push('会话列举失败: ' + String(e))
    }

    const rows: SessionRow[] = []
    for (const record of records) {
      const header = record?.header
      const id = header?.id ? String(header.id) : ''
      if (!id) continue
      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      const live = store && typeof store.get === 'function' ? store.get(id) : undefined

      // 投影值：活会话走 sessionProjections，冷会话走 projection cache（官方同款回退链）。
      // 每个来源独立 try：曾经整段共用一个 try，cachedSnapshot 一抛错就直接跳 catch，
      // 后面的 cachedPredecessorTitle 永远没机会执行 —— 回退链形同不存在。
      let values: Record<string, any> = {}
      if (live !== undefined && projections && typeof projections.cachedSnapshot === 'function') {
        try {
          values = projections.cachedSnapshot(live, LISTING_KEYS)?.values ?? {}
        } catch (e) {
          warnings.push(`活会话投影读取失败 ${id}: ${String(e)}`)
        }
      }
      if (Object.keys(values).length === 0 && live === undefined && header.isSeeded !== true && cache) {
        lastProjectionError = null
        const block = readColdBlock(cache, header)
        values = block?.values ?? {}
        // 同一个失败原因在所有冷会话上会重复出现，只上报一次。
        if (lastProjectionError !== null && !warnings.some((w) => w.includes(lastProjectionError!))) {
          warnings.push(`冷会话投影读取失败（三种签名均不可用）: ${lastProjectionError}`)
        }
      }

      const meta = values.sessionListMetadata ?? null
      const stats = values.sessionStats ?? null
      const title = typeof values.title === 'string' && values.title.trim() ? values.title : null
      const createdAt = Number(header.createdAt ?? 0) || 0
      const lastPromptAt = typeof meta?.lastPromptAt === 'number' ? meta.lastPromptAt : null
      const updatedAt = Math.max(createdAt, lastPromptAt ?? 0)
      const disk = diskInfo(id)
      const group = owner.get(id)
      const diskCwd = cwd || group?.path || ''

      rows.push({
        id,
        title,
        groupKey: group?.key ?? '',
        groupLabel: group?.label ?? (diskCwd ? basename(diskCwd) || diskCwd : '未分组'),
        groupPath: group?.path ?? diskCwd,
        cwd,
        archived: archived.has(id),
        blank: meta?.blank ?? (live !== undefined ? live.seq === 0 : false),
        subagent: header.origin === 'subagent' || header.parentSession !== undefined,
        parentSessionId: header.parentSession ? String(header.parentSession) : null,
        live: live !== undefined || record.live === true,
        canClose: handles.has(id),
        running: agents && typeof agents.get === 'function' ? agents.get(id)?.status === 'running' : false,
        current: current !== null && id === current,
        seeded: header.isSeeded === true,
        diskOnly: false,
        diskNote: null,
        createdAt,
        updatedAt,
        lastPromptAt,
        turns: Number(stats?.turns ?? 0) || 0,
        steps: Number(stats?.steps ?? 0) || 0,
        sizeBytes: disk.sizeBytes,
        fileMtime: disk.fileMtime,
        dir: disk.dir,
      })
    }

    // ── 磁盘兜底：把官方读不到的会话（更高版本日志）作为只读条目补回来 ──
    // 不补的话，面板行数会**少于**真实会话数，而且归档集里的这类 id 会变成
    // "看不见的归档"——正是用户反馈的那个现象。
    const officialIds = new Set(rows.map((r) => r.id))
    let unreachable = 0
    for (const entry of unreachableEntries(officialIds)) {
      unreachable += 1
      const header = entry.header ?? {}
      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      // 分组：先按官方 sessionIds 归属；没有归属的留到下面统一次级匹配
      const group = owner.get(entry.id)
      const diskCwd = cwd || group?.path || ''
      const createdAt = Number(header.createdAt ?? 0) || 0
      const updatedAt = Math.max(createdAt, entry.mtimeMs ?? 0)
      const future = entry.futureVersion ?? entry.version
      rows.push({
        id: entry.id,
        title: null,
        groupKey: group?.key ?? '',
        groupLabel: group?.label ?? (diskCwd ? basename(diskCwd) || diskCwd : '未分组'),
        groupPath: group?.path ?? diskCwd,
        cwd,
        archived: archived.has(entry.id),
        blank: false,
        subagent: header.origin === 'subagent' || header.parentSession !== undefined,
        parentSessionId: header.parentSession ? String(header.parentSession) : null,
        live: false,
        canClose: false,
        running: false,
        current: current !== null && entry.id === current,
        seeded: header.isSeeded === true,
        diskOnly: true,
        diskNote: `日志为 v${future} 格式，当前 DSH 只认到 v${SESSION_FORMAT_READABLE}`,
        createdAt,
        updatedAt,
        lastPromptAt: null,
        turns: 0,
        steps: 0,
        sizeBytes: entry.sizeBytes,
        fileMtime: entry.mtimeMs,
        dir: entry.dir,
      })
    }

    if (unreachable > 0) {
      warnings.push(`另有 ${unreachable} 条会话的日志格式更新（由桌面端等更高版本 DSH 写入），当前 DSH 读不出正文，已在列表中标注为只读`)
    }

    /**
     * 统一的次级分组：对**所有**没有工作区归属的行做 cwd → 工作区路径等价匹配。
     *
     * 为什么必须对所有行都做，而不是只给磁盘兜底条目做：一旦网页端升到 0.2.0-rc.2，
     * 那些原本被格式版本挡住的会话就进入官方语料了，但它们的 id **仍然不在**
     * 任何 `workspaceRegistry.sessionIds` 里（sessionIds 是启动时按 header 索引
     * 校验出来的投影，新能读出来的会话要下一轮才进得去）。如果只按 sessionIds
     * 分组，这 20 条会全砸进"未分组"，把真正没有归属的会话淹掉——而且面板
     * （按 cwd 兜底）与 host 统计（按 sessionIds）会显示两个不同的未分组数，
     * 这正是"数字对不上"这类困惑的来源。口径统一在 host 这一层。
     */
    for (const row of rows) {
      if (row.groupKey !== '') continue
      const match = byCwd.get(normCwd(row.cwd))
      if (match === undefined) continue
      row.groupKey = match.key
      row.groupLabel = match.label
      row.groupPath = match.path
    }

    // 与官方侧边栏一致：新→旧排序（补回来的条目一起参与排序，不能简单追加到末尾）
    rows.sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id))
    const orphanArchivedIds = archivedIds.filter((id) => !officialIds.has(id) && !diskIndex().has(id))
    return { rows, workspaces, archivedIds, orphanArchivedIds, current, warnings: condenseWarnings(warnings) }
  }

  /** 单条告警的展示上限（避免一个反复失败的原因刷屏几千行）。 */
  const MAX_WARNINGS = 4
  /**
   * 收敛告警：同类消息只留前几条，其余折叠成一行计数。
   *
   * 为什么必须做：投影读取在**每个会话**上各失败一次，58 个会话就是 58 行
   * `⚠ 投影读取失败 …`，面板顶部直接被淹没，反而看不见真正的问题。
   */
  function condenseWarnings(list: string[]): string[] {
    if (list.length <= MAX_WARNINGS) return list
    const head = list.slice(0, MAX_WARNINGS)
    return [...head, `…另有 ${list.length - MAX_WARNINGS} 条同类提示（同一个原因会按会话重复出现）`]
  }

  /**
   * 冷会话投影读取：跨版本适配器。
   *
   * 同一个服务、同一个方法名，两个 DSH 版本的位置参数**不兼容**：
   *
   * | 版本 | 签名 | 第二个参数 |
   * | --- | --- | --- |
   * | 桌面端 0.2.0-rc.2 | `cachedSnapshot(meta, keys)` | `keys` = 投影键数组 |
   * | 网页端 0.1.5-rc.2 | `cachedSnapshot(meta, inheritedEventCount, keys)` | `inheritedEventCount` = 数字 |
   *
   * 两者的共同点是**最后那个位置是 keys**，且官方都会
   * `identityOf(meta, inheritedEventCount)` → `SessionLogOffset(inheritedEventCount)`，
   * 传非数字标量（比如数组、undefined）就会抛
   * `SessionLogOffset must be a non-negative safe integer, got ...`。
   * 所以：
   *   1. 先按 0.1.5 的三参形式调（`0` 对两种实现都合法：0.2 忽略它、0.1.5 拿它当 offset）
   *   2. 再按 0.2 的两参形式调（把 keys 放第二个位置）
   *   3. 最后用 `cachedPredecessorTitle`（两种版本都存在，只取 title 一个键）
   *
   * 0.2.0 的 `cachedSnapshot(meta)` 在缺 keys 时 `viewRecord(record, undefined)`
   * 会不选任何 unit、返回空 values —— **标题会全部变成 null**，这正是最初"标题全丢"
   * 的原因之一，所以每一档都要按真实签名传参，不能图省事省略。
   *
   * @param cache - `ctx.sessionProjectionCache`。
   * @param header - 权威会话 header（身份见证）。
   * @returns 投影块（含 `values`），全部路径失败时返回 undefined。
   */
  function readColdBlock(cache: any, header: any): { values?: Record<string, any> } | undefined {
    const attempts: Array<() => unknown> = [
      // 0.1.5-rc.2 及以后：offset 在前、keys 在后
      () => cache.cachedSnapshot(header, 0, LISTING_KEYS),
      // 0.2.0-rc.2：keys 直接是第二个参数
      () => cache.cachedSnapshot(header, LISTING_KEYS),
      // 最后兜底：只取 title（内部固定 PREDECESSOR_TITLE_KEY）
      () => { try { return cache.cachedPredecessorTitle(header, 0) } catch { return cache.cachedPredecessorTitle(header) } },
    ]
    let lastError: unknown
    for (const attempt of attempts) {
      if (typeof cache !== 'object' || cache === null) break
      let result: any
      try {
        result = attempt()
      } catch (e) {
        lastError = e
        continue
      }
      if (result === undefined || result === null) continue
      if (Object.keys(result.values ?? {}).length === 0) continue
      return result
    }
    if (lastError !== undefined) lastProjectionError = String(lastError)
    return undefined
  }

  /** 最近一次投影读取失败的原因；仅用于把告警**去重**成一条。 */
  let lastProjectionError: string | null = null

  // ───────── 可见性（官方同款） ─────────
  function visible(row: SessionRow, opts: { archived?: boolean; blank?: boolean; subagents?: boolean; workspace?: string | null }): boolean {
    if (row.subagent && opts.subagents !== true) return false
    if (row.archived && opts.archived !== true) return false
    if (row.blank && !row.current && opts.blank !== true) return false
    if (opts.workspace && row.groupKey !== opts.workspace) return false
    return true
  }

  function summarize(rows: SessionRow[]): Record<string, number> {
    return {
      total: rows.length,
      visible: rows.filter((r) => visible(r, {})).length,
      archived: rows.filter((r) => r.archived).length,
      blank: rows.filter((r) => r.blank).length,
      subagent: rows.filter((r) => r.subagent).length,
      ungrouped: rows.filter((r) => r.groupKey === '').length,
      live: rows.filter((r) => r.live).length,
      running: rows.filter((r) => r.running).length,
      /** 官方语料读不到、由磁盘兜底补回来的只读条目。 */
      unreachable: rows.filter((r) => r.diskOnly).length,
      /** 归档集里已经没有会话目录的幽灵 id（面板会单列一栏）。 */
      orphanArchived: 0,
    }
  }

  // ───────── 删除 / 清理 ─────────
  interface DeleteResult { ok: boolean; id: string; title: string | null; steps: string[]; error?: string }

  /**
   * 收集某会话的全部后代（子代理会话，递归到叶子）。
   *
   * 为什么需要：官方的会话日志是"只追加"的，删父会话时子代理目录会变成孤儿
   * （`parentSession` 指向一个已不存在的 id）。插件以前只能靠「清理非活跃子代理」
   * 手动收，这里给出显式的"连带删除"能力；**默认仍然不连带**（见 withSubagents），
   * 因为删父会话时连带删掉还可能有用的子代理记录是破坏性更强的行为。
   *
   * @param root - 已收集的语料（含 parentSessionId）。
   * @param rootId - 父会话 id。
   * @returns 后代 id（不含 rootId，按层级由近到远）。
   */
  function collectDescendants(rows: SessionRow[], rootId: string): string[] {
    const byParent = new Map<string, string[]>()
    for (const row of rows) {
      if (row.parentSessionId === null) continue
      const bucket = byParent.get(row.parentSessionId)
      if (bucket) bucket.push(row.id)
      else byParent.set(row.parentSessionId, [row.id])
    }
    const out: string[] = []
    const seen = new Set<string>([rootId])
    const queue = [...(byParent.get(rootId) ?? [])]
    while (queue.length > 0) {
      const id = queue.shift()!
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
      queue.push(...(byParent.get(id) ?? []))
    }
    return out
  }

  async function deleteSessionById(id: string, opts: { current?: string | null } = {}): Promise<DeleteResult> {
    if (deleting.has(id)) return { ok: false, id, title: null, steps: [], error: '该会话正在删除' }
    deleting.add(id)
    try { return await deleteSessionUnlocked(id, opts) } finally { deleting.delete(id) }
  }

  async function deleteSessionUnlocked(id: string, opts: { current?: string | null } = {}): Promise<DeleteResult> {
    const title = null as string | null
    const steps: string[] = []
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return { ok: false, id, title, steps, error: '无效的会话 ID' }
    const current = opts.current || process.env.DSH_SESSION_ID || null
    if (current && id === current) {
      return { ok: false, id, title, steps, error: `不能删除当前正在使用的会话 ${id}（先切换到别的会话）` }
    }

    const store = svc(ctx, 'sessions')
    if (svc(ctx, 'agents')?.get?.(id)?.status === 'running') return { ok: false, id, title, steps, error: '运行中的会话不能删除' }
    const live = store && typeof store.get === 'function' ? store.get(id) : undefined
    if (live !== undefined) {
      const handle = handles.get(id)
      if (!handle || agentRegistry?.get?.(id) !== handle.agent) return { ok: false, id, title, steps, error: '该会话早于插件加载，无法安全关闭；请重启 Harness 一次后重试。' }
      if (handle.agent.status !== 'idle') return { ok: false, id, title, steps, error: '会话尚未空闲，请等待当前操作完成' }
      try { await handle.dispose() } catch (e) { return { ok: false, id, title, steps, error: `关闭会话失败，未删除日志: ${String(e)}` } }
      if (store.get(id) !== undefined || agentRegistry.get(id) !== undefined) return { ok: false, id, title, steps, error: '会话未完全关闭，未删除日志' }
      handles.delete(id)
      dirIndexAt = 0
      steps.push('已关闭空闲会话并完成待写入数据')
    }

    // 1) 从所有占有它的工作区账号里摘除（官方领域写链：内存 + workspace.json + UI 事件）
    const registry = svc(ctx, 'workspaceRegistry')
    let detached = 0
    try {
      for (const ws of registry?.list?.() ?? []) {
        const ids: string[] = Array.isArray(ws.sessionIds) ? [...ws.sessionIds] : []
        if (!ids.includes(id)) continue
        await ws.detachSession(id)
        detached += 1
        steps.push(`已从工作区「${ws.title ?? ws.id}」移除会话记录`)
      }
      if (detached === 0) steps.push('该会话不在任何工作区账号中（无需摘除）')
    } catch (e) {
      return { ok: false, id, title, steps, error: `从工作区摘除失败: ${String(e)}` }
    }

    // 2) 归档集：DSH 只有 archiveSession，没有公开的 unarchive。
    //    目录删除后该 id 会同时离开语料，残留标记不会再产生任何可见行，故仅提示。
    try {
      const archivedIds: string[] = [...(registry?.archivedSessionIds ?? [])].map(String)
      if (archivedIds.includes(id)) steps.push('提示：该会话仍在归档集（DSH 无公开取消归档 API，目录删除后不会再出现在任何列表）')
    } catch { /* 归档集不可读 */ }

    // 3) 删除会话目录
    const dir = scanSessionDirs().get(id) ?? null
    if (dir && existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true })
        steps.push(`已删除会话目录: ${dir}`)
      } catch (e) {
        return { ok: false, id, title, steps, error: `会话目录删除失败: ${String(e)}` }
      }
    } else {
      steps.push('未找到会话目录（可能此前已删除）')
    }

    // 4) 顺手清掉投影缓存分片（否则同 id 重建时缓存里留着上一条会话的标题）
    try {
      const shard = join(projCacheShards, `${id}.json`)
      if (existsSync(shard)) {
        rmSync(shard, { force: true })
        steps.push('已清理投影缓存分片')
      }
    } catch { /* 缓存清理失败无碍（缓存本身按 identity 校验） */ }

    dirIndexAt = 0
    return { ok: true, id, title, steps }
  }

  /** 空会话（创建后从未提问过）——侧边栏本来就隐藏它们，属于「多余」的那类。 */
  function pruneCandidates(rows: SessionRow[]): SessionRow[] {
    return rows.filter((r) => r.blank && !r.archived && !r.running && !r.current)
  }

  async function pruneBlank(opts: { confirm?: boolean; ids?: string[]; current?: string | null }): Promise<{ ok: boolean; targets: SessionRow[]; deleted: DeleteResult[]; error?: string }> {
    const { rows } = await collect({ current: opts.current ?? null })
    const explicit = Array.isArray(opts.ids)
    // Revalidate after preview: a session may have gained content or been archived.
    const candidates = pruneCandidates(rows)
    const targets = explicit ? candidates.filter((r) => opts.ids!.includes(r.id)) : candidates
    if (opts.confirm !== true) return { ok: true, targets, deleted: [] }
    const deleted: DeleteResult[] = []
    for (const row of targets) deleted.push(await deleteSessionById(row.id, { current: opts.current ?? null }))
    return { ok: true, targets, deleted }
  }

  async function pruneSubagents(opts: { confirm?: boolean; ids?: string[]; current?: string | null }) {
    const { rows } = await collect({ current: opts.current ?? null })
    const targets = rows.filter((r) => r.subagent && !r.running && !r.current && !r.archived
      && (!Array.isArray(opts.ids) || opts.ids.includes(r.id)))
    const deleted: DeleteResult[] = []
    if (opts.confirm === true) {
      for (const row of targets) deleted.push(await deleteSessionById(row.id, { current: opts.current }))
    }
    return { targets, deleted }
  }

  // ───────── 文本渲染（host 工具） ─────────
  function fmtTime(ms: number | null): string {
    if (!ms) return '—'
    const delta = Date.now() - ms
    if (delta < 60_000) return '刚刚'
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
    return new Date(ms).toLocaleString()
  }

  function fmtSize(bytes: number | null): string {
    if (bytes === null) return '—'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  function flags(row: SessionRow): string {
    const out: string[] = []
    if (row.current) out.push('当前')
    if (row.running) out.push('运行中')
    else if (row.live) out.push('已打开')
    if (row.blank) out.push('空会话')
    if (row.archived) out.push('归档')
    if (row.subagent) out.push('子代理')
    if (row.diskOnly) out.push('只读·新版日志')
    return out.length > 0 ? ` [${out.join('·')}]` : ''
  }

  function formatList(rows: SessionRow[], opts: { archived?: boolean; blank?: boolean; subagents?: boolean; workspace?: string | null }): string {
    const list = rows.filter((r) => visible(r, opts))
    if (list.length === 0) return '（无会话）'
    const groups = new Map<string, SessionRow[]>()
    for (const row of list) {
      const key = row.groupKey === '' ? `未分组 · ${row.groupLabel}` : row.groupLabel
      const bucket = groups.get(key)
      if (bucket) bucket.push(row)
      else groups.set(key, [row])
    }
    const out: string[] = []
    for (const [label, members] of groups) {
      out.push(`▸ ${label}（${members.length}）`)
      for (const row of members) {
        out.push(`  ${row.title ?? '（无标题）'}${flags(row)}`)
        out.push(`    ${row.id}`)
        out.push(`    最近活动=${fmtTime(row.updatedAt)} 创建=${new Date(row.createdAt).toLocaleString()} 轮次=${row.turns} 步数=${row.steps} 日志=${fmtSize(row.sizeBytes)}`)
      }
    }
    return out.join('\n')
  }

  // ═══════ host 工具 ═══════
  const registerTool = (tool: ToolSpec): void => {
    ctx.effect(() => ctx.tools.register({
      ...tool,
      parameters: toJsonSchema(tool.parameters),
    }))
  }

  const renderText = (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }]

  registerTool({
    name: 'dsh_session_list',
    description: '列出 DSH 会话（按工作区分组，含标题 / 最近活动 / 轮次 / 日志大小）。默认与左侧列表可见性一致：隐藏空会话、归档会话与子代理会话',
    parameters: {
      showArchived: { type: 'boolean', description: '包含归档会话（默认 false）' },
      showBlank: { type: 'boolean', description: '包含空会话（创建后从未提问，默认 false）' },
      showSubagents: { type: 'boolean', description: '包含子代理会话（默认 false）' },
      workspace: { type: 'string', description: '只列某个工作区 id（见每个分组名后的 id 提示）' },
      all: { type: 'boolean', description: '等价于同时打开上面三个开关' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: { showArchived?: boolean; showBlank?: boolean; showSubagents?: boolean; workspace?: string; all?: boolean }) {
      const { rows, workspaces, warnings } = await collect()
      const text = formatList(rows, {
        archived: args?.all === true || args?.showArchived === true,
        blank: args?.all === true || args?.showBlank === true,
        subagents: args?.all === true || args?.showSubagents === true,
        workspace: args?.workspace ?? null,
      })
      const wsText = workspaces.length > 0
        ? '\n\n工作区：' + workspaces.map((w) => `${w.title}(${w.id.slice(0, 8)}…, ${w.count} 个)`).join('、')
        : ''
      const warnText = warnings.length > 0 ? '\n\n⚠ ' + warnings.join('\n⚠ ') : ''
      return text + wsText + warnText
    },
  })

  registerTool({
    name: 'dsh_session_archived',
    description: '列出归档会话（workspaceRegistry.archivedSessionIds 中仍存在的会话）',
    parameters: {},
    output: { schema: { type: 'string' }, render: renderText },
    async execute() {
      const { rows, archivedIds } = await collect()
      const list = rows.filter((r) => r.archived)
      const missing = archivedIds.filter((id) => !rows.some((r) => r.id === id))
      const text = list.length === 0 ? '（无归档会话）' : formatList(list, { archived: true, blank: true, subagents: true })
      const tail = missing.length > 0 ? `\n\n归档集中有 ${missing.length} 条已无对应会话（目录已删除）：\n  ${missing.join('\n  ')}` : ''
      return text + tail
    },
  })

  registerTool({
    name: 'dsh_session_delete',
    description: '删除指定 DSH 会话：先关闭已打开的空闲会话并等待写入结束，再删除工作区记录、日志及缓存。不能删当前或运行中的会话。需 confirm=true；withSubagents=true 时连带删除其子代理会话（默认只删指定会话）',
    parameters: {
      id: { type: 'string', description: '完整会话 id' },
      ids: { type: 'array', description: '批量删除：多个完整会话 id（与 id 二选一）' },
      confirm: { type: 'boolean', required: false, description: '确认删除，必须为 true' },
      withSubagents: { type: 'boolean', required: false, description: 'true = 连带删除这些会话的子代理会话（递归后代）；默认 false 只删指定会话' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: { id?: string; ids?: string[]; confirm?: boolean; withSubagents?: boolean }) {
      const targets = [...(args?.ids ?? []), ...(args?.id ? [args.id] : [])].filter((x) => typeof x === 'string' && x.trim() !== '')
      if (targets.length === 0) return 'ERROR: 缺少 id / ids 参数'
      if (args?.confirm !== true) return 'ERROR: 请确认删除（confirm=true）后再执行'
      const queue: string[] = []
      const queued = new Set<string>()
      for (const target of targets) { const id = target.trim(); queue.push(id); queued.add(id) }
      if (args?.withSubagents === true) {
        const { rows } = await collect()
        const expanded: string[] = []
        for (const id of [...queued]) {
          for (const child of collectDescendants(rows, id)) {
            if (queued.has(child)) continue
            queued.add(child)
            expanded.push(child)
          }
        }
        queue.push(...expanded)
      }
      const results: string[] = []
      let failed = 0
      for (const id of queue) {
        const res = await deleteSessionById(id)
        if (res.ok) results.push(`OK ${res.id}\n- ` + res.steps.join('\n- '))
        else { failed += 1; results.push(`FAIL ${res.id}: ${res.error}`) }
      }
      const head = failed === 0 ? `OK: 已处理 ${queue.length} 个会话\n\n` : `部分失败（${failed}/${queue.length}）\n\n`
      const note = args?.withSubagents === true ? `（含连带删除的子代理会话）\n\n` : ''
      return head + note + results.join('\n\n')
    },
  })

  registerTool({
    name: 'dsh_session_prune',
    description: '清理「空会话」（创建后从未提问、非运行、非当前、非归档）。已打开的空闲会话会先关闭。默认只预览（dryRun），confirm=true 才真删',
    parameters: {
      confirm: { type: 'boolean', description: 'true = 真删；省略/false = 只预览' },
      ids: { type: 'array', description: '只清理指定 id（默认：全部空会话）' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: { confirm?: boolean; ids?: string[] }) {
      const res = await pruneBlank({ confirm: args?.confirm === true, ids: args?.ids })
      if (res.targets.length === 0) return '没有可清理的空会话'
      const preview = res.targets.map((r) => `  ${r.id}  工作区=${r.groupLabel}  创建=${new Date(r.createdAt).toLocaleString()}`).join('\n')
      if (args?.confirm !== true) return `预览：将清理 ${res.targets.length} 个空会话（confirm=true 执行）\n${preview}`
      const ok = res.deleted.filter((d) => d.ok).length
      const bad = res.deleted.filter((d) => !d.ok)
      const tail = bad.length > 0 ? '\n失败：\n' + bad.map((d) => `  ${d.id}: ${d.error}`).join('\n') : ''
      return `已清理 ${ok}/${res.targets.length} 个空会话\n${preview}${tail}`
    },
  })

  // ═══════ webServer API（供 client 面板消费） ═══════
  /**
   * 本机来源判定（与 dsh-whale-widget 0.3.15 的加固同思路）。
   *
   * 这些路由里有 `POST /delete`、`/prune`、`/archive` 这类**破坏性写操作**，
   * 而 DSH 的 HTTP 端口在同一个环回地址上对所有本机进程开放。若不校验来源，
   * 任何本机程序（或浏览器里一段指向 127.0.0.1 的脚本）都能 POST 一下把会话删掉。
   * 所以：写操作必须来自回环 Host，且拒绝带跨站标记的请求。
   * 需要经反向代理/局域网访问时用 DSHW_ADMIN_HOSTS 显式放行（逗号分隔，可带端口）。
   */
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
  function trustedOrigins(): Set<string> {
    const extra = (process.env.DSHW_ADMIN_HOSTS ?? '').split(',').map((v) => v.trim().toLowerCase()).filter((v) => v !== '')
    const set = new Set<string>(['127.0.0.1', 'localhost', '[::1]', '::1'])
    for (const host of extra) set.add(host)
    return set
  }
  function isTrustedLocal(req: any): boolean {
    try {
      const headers = req?.headers ?? {}
      const hostHeader = String(headers.host ?? '').toLowerCase()
      const host = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0]
      if (!trustedOrigins().has(host)) return false
      // 浏览器跨站请求：即使 Host 是回环，也要拒绝（防 DNS rebinding / 恶意网页）。
      if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false
      const origin = headers.origin
      if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
        let originHost: string
        try { originHost = new URL(origin).host.toLowerCase() } catch { return false }
        const originName = originHost.startsWith('[') ? originHost.slice(0, originHost.indexOf(']') + 1) : originHost.split(':')[0]
        if (!trustedOrigins().has(originName)) return false
      }
      return true
    } catch {
      return false
    }
  }

  const registerApi = (webCtx: AppContext): void => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/dsh-session-manager/api',
      handler: async (req: any, res: any) => {
        const send = (code: number, obj: unknown): void => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(obj))
        }
        const readBody = (): Promise<string> => new Promise((resolve) => {
          let raw = ''
          req.on('data', (chunk: string) => { raw += chunk })
          req.on('end', () => resolve(raw))
          req.on('error', () => resolve(''))
        })
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const path = url.pathname.replace(/^\/dsh-session-manager\/api/, '') || '/'

          // 只读放行；写操作（归档/删除/清理）必须来自可信本机来源。
          const isRead = req.method === 'GET' || req.method === 'HEAD'
          if (!isRead && !isTrustedLocal(req)) {
            return send(403, { ok: false, error: '仅允许本机来源的写操作（如需远端管理请设置 DSHW_ADMIN_HOSTS）' })
          }
          if (req.method === 'GET' && path === '/sessions') {
            const currentFromClient = url.searchParams.get('current')
            const corpus = await collect({ current: currentFromClient })
            const stats = summarize(corpus.rows)
            stats.orphanArchived = corpus.orphanArchivedIds.length
            return send(200, {
              ok: true,
              generatedAt: Date.now(),
              current: corpus.current,
              sessions: corpus.rows,
              workspaces: corpus.workspaces,
              archivedIds: corpus.archivedIds,
              orphanArchivedIds: corpus.orphanArchivedIds,
              stats,
              warnings: corpus.warnings,
            })
          }
          if (req.method === 'POST' && path === '/archive') {
            let body: any = {}
            try { body = JSON.parse(await readBody()) } catch { /* malformed body */ }
            if (typeof body.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(body.id)) return send(400, { ok: false, error: '无效的会话 ID' })
            const { rows } = await collect({ current: typeof body.current === 'string' ? body.current : null })
            const row = rows.find((r) => r.id === body.id)
            if (!row) return send(404, { ok: false, error: '会话不存在' })
            if (row.diskOnly) return send(400, { ok: false, error: `${row.diskNote ?? '该会话日志格式更新'}；当前 DSH 无法读取，已跳过归档以免产生看不见的归档标记` })
            if (row.running) return send(400, { ok: false, error: '运行中的会话不能归档' })
            const registry = svc(ctx, 'workspaceRegistry')
            if (typeof registry?.archiveSession !== 'function') return send(503, { ok: false, error: '当前 Harness 未提供归档接口' })
            await registry.archiveSession(row.id)
            return send(200, { ok: true, id: row.id })
          }
          if (req.method === 'POST' && path === '/attach') {
            let body: any = {}
            try { body = JSON.parse(await readBody()) } catch { /* 空 body */ }
            const id = typeof body.id === 'string' ? body.id.trim() : ''
            const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : ''
            if (!/^[a-zA-Z0-9_-]+$/.test(id)) return send(400, { ok: false, error: '无效的会话 ID' })
            if (workspaceId === '') return send(400, { ok: false, error: '缺少 workspaceId' })
            const registry = svc(ctx, 'workspaceRegistry')
            if (registry === undefined || typeof registry.get !== 'function') return send(503, { ok: false, error: '当前 Harness 未提供工作区接口' })
            const { rows } = await collect({ current: typeof body.current === 'string' ? body.current : null })
            const row = rows.find((r) => r.id === id)
            if (!row) return send(404, { ok: false, error: '会话不存在' })
            if (row.diskOnly) return send(400, { ok: false, error: `${row.diskNote ?? '该会话日志格式更新'}；当前 DSH 读不出它的 header，无法校验归属，已拒绝` })
            const workspace = registry.get(workspaceId)
            if (!workspace || typeof workspace.attachSession !== 'function') return send(404, { ok: false, error: '工作区不存在或不可写' })
            if (String(workspace.id) === row.groupKey) return send(409, { ok: false, error: `该会话已在工作区「${workspace.title ?? workspace.id}」中` })
            try {
              await workspace.attachSession(id)
            } catch (e) {
              // 官方 attachSession 的硬约束：会话 header 的 cwd 必须 realpath 到工作区路径，
              // 且该目录必须真实存在。分叉会话之所以长期留在"未分组"，就是因为它的
              // cwd 与任何已登记工作区都不相等（例如 cwd=E:\Desktop\langyangyang\WORD，
              // 而工作区是 E:\Desktop\WORD）。这里把官方原话透出去，避免用户以为点了没反应。
              return send(400, { ok: false, error: `归入失败：${String(e instanceof Error ? e.message : e)}` })
            }
            dirIndexAt = 0
            return send(200, { ok: true, id, workspaceId, workspace: String(workspace.title ?? workspace.id) })
          }
          if (req.method === 'POST' && path === '/repair-archives') {
            let body: any = {}
            try { body = JSON.parse(await readBody()) } catch { /* 空 body */ }
            // 幽灵归档标记自愈：DSH 只提供 archiveSession、没有 unarchive，而删除会话目录
            // 之后归档标记会永久残留——面板统计的"归档 N"于是永远大于能看到的归档行数。
            // 这里把「既不在语料、也不在磁盘」的 id 从归档集里摘掉，并同步内存状态
            // （setState 同时写库并更新 registry 的内存快照，所以不需要重启）。
            const registry = svc(ctx, 'workspaceRegistry')
            if (registry === undefined || typeof registry.setState !== 'function') {
              return send(503, { ok: false, error: '当前 Harness 未提供可写的工作区状态（需要 setState）' })
            }
            const { rows, archivedIds } = await collect({ current: typeof body?.current === 'string' ? body.current : null })
            const known = new Set(rows.map((r) => r.id))
            const disk = diskIndex()
            const ghosts = archivedIds.filter((id) => !known.has(id) && !disk.has(id))
            if (ghosts.length === 0) return send(200, { ok: true, removed: [], archived: archivedIds.length })
            const keep = archivedIds.filter((id) => !ghosts.includes(id))
            try {
              await registry.setState({ ...registry.requireState(), archivedSessionIds: keep })
            } catch (e) {
              return send(500, { ok: false, error: `写归档集失败：${String(e)}` })
            }
            return send(200, { ok: true, removed: ghosts, archived: keep.length })
          }
          if (req.method === 'POST' && path === '/delete') {
            let body: any = {}
            try { body = JSON.parse(await readBody()) } catch { /* 空 body */ }
            const ids: string[] = [...(Array.isArray(body.ids) ? body.ids : []), ...(body.id ? [String(body.id)] : [])]
              .map((x: unknown) => String(x).trim())
              .filter((x: string) => x !== '')
            if (ids.length === 0) return send(400, { ok: false, error: 'id 必填' })
            if (body.confirm !== true) return send(400, { ok: false, error: '请确认删除（confirm=true）' })
            const currentFromClient = typeof body.current === 'string' ? body.current : null
            const results = [] as DeleteResult[]
            const { rows } = await collect({ current: currentFromClient })
            // withSubagents: 显式选择"连带删除子代理会话"时才把后代一起删（默认不连带）。
            const withSubagents = body.withSubagents === true
            const queue: string[] = []
            const queued = new Set<string>()
            for (const raw of new Set(ids)) { queue.push(raw); queued.add(raw) }
            while (queue.length > 0) {
              const id = queue.shift()!
              const row = rows.find((r) => r.id === id)
              if (row && withSubagents) {
                for (const child of collectDescendants(rows, id)) {
                  if (queued.has(child)) continue
                  queued.add(child)
                  queue.push(child)
                }
              }
              if (!row || row.current || row.running) {
                results.push({ ok: false, id, title: row?.title ?? null, steps: [], error: row ? (row.current ? '当前会话不能删除，请先切换到其他会话' : '运行中的会话不能删除') : '会话不存在' })
              } else if (row.diskOnly) {
                // 只读兜底条目：当前进程解析不了它的正文，删目录是不可逆的破坏，
                // 明确拒绝并说明原因（想删就在能读这个格式的 DSH 里删）。
                results.push({ ok: false, id, title: row.title, steps: [], error: `${row.diskNote ?? '该会话日志格式更新'}；为避免误删更高版本 DSH 的会话记录，面板不删除这类条目` })
              } else results.push(await deleteSessionById(id, { current: currentFromClient }))
            }
            const failed = results.filter((r) => !r.ok)
            return send(failed.length === 0 ? 200 : 400, { ok: failed.length === 0, results })
          }
          if (req.method === 'POST' && (path === '/prune' || path === '/prune-subagents')) {
            let body: any = {}
            try { body = JSON.parse(await readBody()) } catch { /* 空 body */ }
            const res = await (path === '/prune-subagents' ? pruneSubagents : pruneBlank)({
              confirm: body.confirm === true,
              ids: Array.isArray(body.ids) ? body.ids : undefined,
              current: typeof body.current === 'string' ? body.current : null,
            })
            return send(200, {
              ok: true,
              dryRun: body.confirm !== true,
              targets: res.targets.map((r) => ({ id: r.id, title: r.title, groupLabel: r.groupLabel, createdAt: r.createdAt })),
              deleted: res.deleted.map((d) => ({ id: d.id, ok: d.ok, error: d.error ?? null })),
            })
          }
          return send(404, { ok: false, error: '接口不存在' })
        } catch (e) {
          log('warn', '[session-console] API 处理失败: %s', String(e))
          return send(500, { ok: false, error: String(e) })
        }
      },
    }), 'session-console: api')
  }
  try {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (webServer !== undefined && webServer !== null) registerApi(ctx)
    else if (typeof (ctx as any).inject === 'function') (ctx as any).inject(['webServer'], registerApi)
    else registerApi(ctx)
  } catch (e) {
    log('warn', '[session-console] webServer API 注册失败: %s', String(e))
  }
}
