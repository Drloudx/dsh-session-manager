import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

// Isolated host services and an empty temporary home: never use real sessions.
const testHome = mkdtempSync(join(tmpdir(), 'dsh-session-prune-test-'))
try {
  const ids = ['blank', 'content', 'archived', 'live', 'current', 'changed-after-preview']
  const blank = new Set(ids.filter((id) => id !== 'content'))
  const registered = new Map()
  const detached = []
  const liveIds = new Set(['live'])
  const runningIds = new Set(['live'])
  const archivedByApi = []
  const shutdowns = []
  const agentObjects = new Map()
  class TestAgents {
    get(id) { return agentObjects.get(id) ?? (runningIds.has(id) ? { status: 'running' } : undefined) }
    async create({ sessionId }) { return this.resume({ resumeSessionId: sessionId }) }
    async resume({ resumeSessionId: id }) {
      const agent = { id, status: 'idle' }
      liveIds.add(id)
      agentObjects.set(id, agent)
      return { agent, dispose: async () => {
        shutdowns.push(id)
        if (id === 'close-fails') throw new Error('write drain failed')
        // Model a final flush: the deletion must happen AFTER this write.
        const dir = join(testHome, 'sessions', 'test-workspace', id)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'session.v3.jsonl'), 'final buffered event\n')
        liveIds.delete(id)
        agentObjects.delete(id)
      } }
    }
  }
  const values = (id) => ({ sessionListMetadata: { blank: blank.has(id) }, title: id })
  /** 复刻官方 `SessionLogOffset` 的校验：非负安全整数，否则抛错。 */
  function assertNonNegativeOffset(value, who) {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new TypeError(`SessionLogOffset must be a non-negative safe integer, got ${String(value)} (${who})`)
    }
  }
  /** 子代理血缘：parentSession 指向父会话 id。 */
  const parents = new Map([['child-a1', 'parent-a'], ['grandchild-a1a', 'child-a1']])
  const services = {
    sessionQuery: { listSessions: async () => ids.map((id) => ({ header: {
      id, createdAt: 1,
      ...(id.startsWith('sub-') ? { origin: 'subagent' } : {}),
      ...(parents.has(id) ? { parentSession: parents.get(id) } : {}),
    }, live: liveIds.has(id) })) },
    sessions: { get: (id) => liveIds.has(id) ? { id, seq: 0 } : undefined },
    agents: new TestAgents(),
    sessionProjections: { cachedSnapshot: (session) => ({ values: values(session.id) }) },
    /**
     * **忠于 0.1.5-rc.2 真实契约的严格 mock**：
     *   cachedSnapshot(meta, inheritedEventCount, keys)
     *   cachedPredecessorTitle(meta, inheritedEventCount)
     * 两者内部都走 `identityOf(meta, inheritedEventCount)` → `SessionLogOffset(n)`，
     * 传非数字标量（数组 / undefined）就抛 —— 这正是网页端那面 ⚠ 墙的成因。
     * keys 省略时不选任何 unit ⇒ values 为空（对应"标题全丢"）。
     * 以前的 mock 无视所有参数、永远返回值，所以这两类真实故障在测试里完全不可见。
     */
    sessionProjectionCache: {
      cachedSnapshot: (header, inheritedEventCount, keys) => {
        assertNonNegativeOffset(inheritedEventCount, 'cachedSnapshot')
        if (!Array.isArray(keys) || keys.length === 0) return { values: {} }
        const all = values(header.id)
        const picked = {}
        for (const key of keys) if (key in all) picked[key] = all[key]
        return { values: picked }
      },
      cachedPredecessorTitle: (header, inheritedEventCount) => {
        assertNonNegativeOffset(inheritedEventCount, 'cachedPredecessorTitle')
        return { values: { title: values(header.id).title } }
      },
    },
    workspaceRegistry: {
      archivedSessionIds: ['archived'],
      archiveSession: async (id) => { archivedByApi.push(id); services.workspaceRegistry.archivedSessionIds.push(id) },
      list: () => [{ id: 'test-workspace', title: 'Test', sessionIds: ids, detachSession: async (id) => detached.push(id) }],
    },
  }
  let route
  const ctx = {
    effect: (fn) => fn(),
    get: (key) => services[key],
    tools: { register: (tool) => registered.set(tool.name, tool) },
    webServer: { register: (spec) => { route = spec } },
  }
  apply(ctx, { dshHome: testHome })
  /**
   * 写接口带信任栅栏：必须提供 `headers`，且 Host 为回环地址。
   * 这也让"非本机来源被拒"第一次有了测试覆盖（以前栅栏不存在、也没有任何断言）。
   */
  const call = async (body, path = '/prune', expectedStatus = 200, headers = { host: '127.0.0.1:3080' }) => {
    let status, payload
    const req = {
      method: 'POST', url: '/dsh-session-manager/api' + path, headers,
      on: (event, cb) => { if (event === 'data') cb(JSON.stringify(body)); if (event === 'end') cb() },
    }
    await route.handler(req, { writeHead: (code) => { status = code }, end: (value) => { payload = JSON.parse(value) } })
    assert.equal(status, expectedStatus)
    return payload
  }
  const preview = await call({ current: 'current' })
  assert.deepEqual(preview.targets.map((row) => row.id).sort(), ['blank', 'changed-after-preview'])
  assert.equal(detached.length, 0)

  // ── 信任栅栏：非本机来源 / 跨站标记 / 陌生 Origin 一律 403，且不得改动任何数据 ──
  const denied = async (label, headers) => {
    const res = await call({ current: 'current', confirm: true, ids }, '/prune', 403, headers)
    assert.equal(res.ok, false, label + ' 应被拒绝')
    assert.equal(detached.length, 0, label + ' 不得改动数据')
  }
  await denied('局域网 Host', { host: '192.168.1.9:3080' })
  await denied('回环但跨站标记', { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })
  await denied('陌生 Origin', { host: '127.0.0.1:3080', origin: 'https://evil.example' })
  // 回环 + 同源 Origin 放行
  await call({ current: 'current', confirm: false, ids: [] }, '/prune', 200, { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })

  blank.delete('changed-after-preview')
  const result = await call({ current: 'current', confirm: true, ids })
  assert.deepEqual(result.targets.map((row) => row.id), ['blank'])
  assert.deepEqual(detached, ['blank'])
  assert.deepEqual((await call({ confirm: true, ids: [] })).targets, [])

  ids.push('sub-cold', 'sub-live', 'sub-running', 'sub-archived', 'sub-current', 'sub-became-live')
  liveIds.add('sub-live')
  runningIds.add('sub-live')
  runningIds.add('sub-running')
  services.workspaceRegistry.archivedSessionIds.push('sub-archived')
  const subPreview = await call({ current: 'sub-current' }, '/prune-subagents')
  assert.deepEqual(subPreview.targets.map((row) => row.id).sort(), ['sub-became-live', 'sub-cold'])
  liveIds.add('sub-became-live')
  runningIds.add('sub-became-live')
  detached.length = 0
  const subResult = await call({ current: 'sub-current', confirm: true, ids }, '/prune-subagents')
  assert.deepEqual(subResult.deleted.map((row) => row.id), ['sub-cold'])
  assert.deepEqual(detached, ['sub-cold'])

  detached.length = 0
  await call({ ids: ['content'] }, '/delete', 400)
  assert.deepEqual(detached, [])

  // ── 连带删除子代理：默认**不**连带；显式 withSubagents:true 才递归删后代 ──
  ids.push('parent-a', 'child-a1', 'grandchild-a1a', 'unrelated-a')
  detached.length = 0
  // 默认：只删 parent-a，后代留着
  const withoutSub = await call({ ids: ['parent-a'], confirm: true }, '/delete')
  assert.deepEqual(withoutSub.results.filter((r) => r.ok).map((r) => r.id), ['parent-a'])
  assert.deepEqual(detached, ['parent-a'])
  // 显式连带：parent-a + child-a1 + grandchild-a1a 全删，且**不含无关会话**
  detached.length = 0
  const withSub = await call({ ids: ['parent-a'], confirm: true, withSubagents: true }, '/delete')
  const okIds = withSub.results.filter((r) => r.ok).map((r) => r.id).sort()
  assert.deepEqual(okIds, ['child-a1', 'grandchild-a1a', 'parent-a'])
  assert.deepEqual([...detached].sort(), ['child-a1', 'grandchild-a1a', 'parent-a'])
  assert.equal(detached.includes('unrelated-a'), false, '无关会话不得被连带删除')

  detached.length = 0
  const batch = await call({ ids: ['content', 'content', 'live', 'sub-running', 'current', 'unknown', '../escape'], current: 'current', confirm: true, force: true }, '/delete', 400)
  assert.deepEqual(batch.results.filter((r) => r.ok).map((r) => r.id), ['content'])
  assert.deepEqual(detached, ['content'])
  await call({ id: 'content' }, '/archive')
  assert.deepEqual(archivedByApi, ['content'])

  // ── 回退链：主入口**抛错**时也必须继续走 cachedPredecessorTitle（网页版真实故障） ──
  const realSnapshot = services.sessionProjectionCache.cachedSnapshot
  const realPredecessor = services.sessionProjectionCache.cachedPredecessorTitle
  let snapshotThrew = 0
  let predecessorCalls = 0
  services.sessionProjectionCache.cachedSnapshot = () => {
    snapshotThrew += 1
    throw new TypeError('SessionLogOffset must be a non-negative safe integer, got undefined')
  }
  services.sessionProjectionCache.cachedPredecessorTitle = (header) => {
    predecessorCalls += 1
    return { values: { title: values(header.id).title } }
  }
  const fallbackList = await call({}, '/prune', 200, { host: '127.0.0.1:3080' })
  assert.equal(fallbackList.ok, true)
  assert.equal(snapshotThrew > 0, true, '主入口应被尝试过')
  assert.equal(predecessorCalls > 0, true, '主入口抛错后必须继续尝试前驱标题入口（否则标题会全丢）')
  services.sessionProjectionCache.cachedSnapshot = realSnapshot
  services.sessionProjectionCache.cachedPredecessorTitle = realPredecessor
  await call({ id: 'current', current: 'current' }, '/archive')
  await call({ id: 'sub-running' }, '/archive', 400)
  await call({ id: 'unknown' }, '/archive', 404)
  assert.deepEqual(archivedByApi, ['content', 'current'])

  ids.push('opened-idle', 'opened-archived', 'close-fails', 'orphan-live')
  for (const id of ['opened-idle', 'opened-archived', 'close-fails']) await services.agents.resume({ resumeSessionId: id })
  liveIds.add('orphan-live')
  await call({ id: 'opened-archived' }, '/archive')
  detached.length = 0
  const idleResult = await call({ ids: ['opened-idle', 'opened-archived'], confirm: true }, '/delete')
  assert.equal(idleResult.results.every((r) => r.ok), true)
  assert.deepEqual(shutdowns, ['opened-idle', 'opened-archived'])
  for (const id of shutdowns) {
    assert.equal(liveIds.has(id), false)
    assert.equal(existsSync(join(testHome, 'sessions', 'test-workspace', id)), false, 'final flush must not resurrect deleted logs')
  }
  const protectedResult = await call({ ids: ['close-fails', 'orphan-live'], confirm: true, force: true }, '/delete', 400)
  assert.equal(protectedResult.results.every((r) => !r.ok), true)
  assert.deepEqual(detached, ['opened-idle', 'opened-archived'])
  console.log('prune + inactive subagents + batch deletion + archive protections PASS')
} finally {
  rmSync(testHome, { recursive: true, force: true })
}
