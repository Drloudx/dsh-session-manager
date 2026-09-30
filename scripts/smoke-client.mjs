#!/usr/bin/env node
/**
 * client 面板冒烟测试（无浏览器、无 react 依赖）：用一个最小 React 运行时
 * 把 lib/client.js 里的面板渲染出来，并真的去调 host 的
 * /dsh-session-manager/api，断言：
 *   · 标题显示出来（而不是退化成工作区名）
 *   · 默认隐藏空会话 / 归档 / 子代理（与左侧列表一致）
 *   · 勾选「显示空会话」后空会话才出现
 *   · 分组数量与「清理空会话」计数正确
 *
 * 用法：node scripts/smoke-client.mjs [baseUrl]
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const ORIGIN = new URL(BASE).origin
let authCookie = process.env.DSH_WEB_COOKIE ?? ''
if (new URL(BASE).searchParams.has('token')) {
  const auth = await fetch(BASE, { redirect: 'manual' })
  authCookie = auth.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
  if (auth.status !== 303 || !authCookie) throw new Error('Harness authentication failed')
}

// ───────── 最小 React 运行时 ─────────
const hookStores = new Map()
let pendingEffects = []
let dirty = false
const rerender = () => { dirty = true }
const depsEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

function withHooks(fn, run) {
  let store = hookStores.get(fn)
  if (store === undefined) { store = { slots: [], cursor: 0 }; hookStores.set(fn, store) }
  store.cursor = 0
  const slots = store.slots
  const hook = {
    useState(init) {
      const i = store.cursor++
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
      return [slots[i], (value) => {
        const next = typeof value === 'function' ? value(slots[i]) : value
        if (!Object.is(next, slots[i])) { slots[i] = next; rerender() }
      }]
    },
    useRef(init) {
      const i = store.cursor++
      if (!(i in slots)) slots[i] = { current: init }
      return slots[i]
    },
    useCallback(fn2, deps) {
      const i = store.cursor++
      const prev = slots[i]
      if (prev === undefined || !depsEqual(prev.deps, deps)) slots[i] = { deps, fn: fn2 }
      return slots[i].fn
    },
    useMemo(fn2, deps) {
      const i = store.cursor++
      const prev = slots[i]
      if (prev === undefined || !depsEqual(prev.deps, deps)) slots[i] = { deps, value: fn2() }
      return slots[i].value
    },
    useEffect(fn2, deps) {
      const i = store.cursor++
      const prev = slots[i]
      if (prev === undefined || !depsEqual(prev.deps, deps)) { slots[i] = { deps }; pendingEffects.push(fn2) }
    },
  }
  return run(hook)
}

const Fragment = Symbol('Fragment')
const React = {
  Fragment,
  useState: undefined,
  createElement(type, props, ...children) {
    const list = children.length === 0 ? [] : children.length === 1 ? [children[0]] : children
    return { type, props: { ...(props ?? {}), children: list } }
  },
}

// 把 hook 注入到组件调用里：函数组件渲染时通过 activeHook 暴露
let activeHook = null
for (const name of ['useState', 'useEffect', 'useCallback', 'useMemo', 'useRef']) {
  React[name] = (...args) => activeHook[name](...args)
}

// ───────── DOM 桩 ─────────
const styleTags = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, set textContent(v) { this._t = v }, get textContent() { return this._t } }),
  head: { appendChild: (tag) => styleTags.push(tag) },
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.window = {
  confirm: () => true,
  alert: (msg) => { throw new Error('unexpected alert: ' + msg) },
}
globalThis.KeyboardEvent = class KeyboardEvent {}

// ───────── fetch 转发到真实 host ─────────
const fetchCalls = []
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)

function httpGet(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    require('node:http').get(url, { headers: { cookie: authCookie } }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => resolvePromise({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(raw) }))
    }).on('error', rejectPromise)
  })
}

function httpPost(url, body) {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(url)
    const req = require('node:http').request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => resolvePromise({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(raw) }))
    })
    req.on('error', rejectPromise)
    req.write(body)
    req.end()
  })
}

globalThis.fetch = async (url, opts) => {
  const absolute = new URL(String(url), ORIGIN).href
  const method = opts?.method ?? 'GET'
  if (method !== 'GET') throw new Error('Smoke test must never mutate real sessions')
  fetchCalls.push({ url: absolute, method, body: opts?.body ?? null })
  return method === 'GET' ? httpGet(absolute) : httpPost(absolute, String(opts?.body ?? '{}'))
}

// ───────── 加载 lib/client.js ─────────
let bundle = null
globalThis.window.__ModuleLoader__ = { load: (entry) => { bundle = entry } }
new vm.Script(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { filename: 'client.js' }).runInThisContext()
if (bundle === null) throw new Error('lib/client.js 没有调用 __ModuleLoader__.load')

/**
 * 图标桩：**用当前真实的导出名**（`...Regular` / `...Medium`）。
 *
 * 这里以前桩的是 `IconListPenOutline16` / `IconCloseOutline16` —— 那两个名字在官方
 * primitives 里**根本不存在**，于是测试永远"通过"，而线上取到 undefined 就炸。
 * 桩名必须与线上一致，否则这个测试测的是空气。
 */
const primitives = {
  IconListPenOutlineRegular: () => null,
  IconListPenOutlineMedium: () => null,
}
const plugin = bundle.factory((spec) => {
  if (spec === 'react') return React
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error('unexpected require: ' + spec)
})
if (typeof plugin?.apply !== 'function') throw new Error('factory 没有返回 { apply }')

// ───────── 收集 slot 组件 ─────────
// 现在的形态：sidebar.panellist 放图标，main 放面板本体。
let GlyphComponent = null
let PanelComponent = null
const registeredSlots = []
const ctx = {
  get: () => undefined,
  slots: {
    inject: (_name, fn) => fn(),
    register: (spec, component) => {
      registeredSlots.push(spec)
      if (spec.name === 'sidebar.panellist' && spec.id === 'session-console') GlyphComponent = component
      if (spec.name === 'main' && spec.key === 'session-console') PanelComponent = component
      return () => {}
    },
  },
}
plugin.apply(ctx)
if (GlyphComponent === null) throw new Error('没有注册 sidebar.panellist 图标（id 应为 session-console）')
if (PanelComponent === null) throw new Error('没有注册 main 面板（key 应为 session-console）')
check('注册进官方主面板槽', registeredSlots.some((s) => s.name === 'main' && s.key === 'session-console'), JSON.stringify(registeredSlots))

// ───────── 迷你渲染器 ─────────
function renderTree(element, out) {
  if (element === null || element === undefined || element === false || element === true) return
  if (typeof element === 'string' || typeof element === 'number') { out.push(String(element)); return }
  if (Array.isArray(element)) { for (const child of element) renderTree(child, out); return }
  const { type, props } = element
  if (type === Fragment) { renderTree(props.children, out); return }
  if (typeof type === 'function') {
    const previous = activeHook
    const rendered = withHooks(type, (hook) => { activeHook = hook; const value = type(props); activeHook = null; return value })
    activeHook = previous
    renderTree(rendered, out)
    return
  }
  if (typeof type === 'string') {
    // 标记交互元素，便于按类型查找
    out.push({ tag: type, props: props ?? {} })
    renderTree(props?.children ?? [], out)
  }
}

function findElements(nodes, tag) {
  return nodes.filter((n) => typeof n === 'object' && n !== null && n.tag === tag)
}

let tree = null
function flush() {
  for (let round = 0; round < 20; round++) {
    pendingEffects = []
    const out = []
    renderTree(React.createElement(PanelComponent, {}), out)
    tree = out
    const effects = pendingEffects
    pendingEffects = []
    for (const effect of effects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') { /* 测试不关心清理 */ }
    }
    if (!dirty && effects.length === 0) break
    dirty = false
  }
}

const text = () => tree.filter((n) => typeof n === 'string').join(' | ')
/** 渲染 → 跑 effect → 每 25ms 重渲染一次，直到 predicate 成立或超时。 */
const settle = async (predicate = () => true, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    flush()
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 25))
  }
}

// ───────── 断言 ─────────
let failures = 0
function check(label, condition, detail = '') {
  if (condition) { console.log('  ✓ ' + label) } else { failures += 1; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

flush()
// 图标槽不再自己渲染文字（文字由官方 PanelRow 用 options.label 画），
// 所以断言改为：面板本体已挂载并显示标题。
check('面板本体渲染（标题「会话管理」）', text().includes('会话管理'), text().slice(0, 120))

const loaded = await settle(() => !text().includes('加载中'))
check('面板从 host API 载入数据', loaded && /共 \d+ 个会话/.test(text()), text().slice(0, 200))

const panel = text()
if (process.env.SMOKE_DEBUG === '1') {
  console.error('[debug] fetches:', JSON.stringify(fetchCalls))
  for (const [fn, store] of hookStores) console.error('[debug] component', fn.name, 'slots', JSON.stringify(store.slots.map((s) => (s && typeof s === 'object' && 'current' in s ? s.current : s))).slice(0, 300))
}
console.log('\n--- 面板文本（前 1200 字）---\n' + panel.slice(0, 1200) + '\n')

check('弹窗标题「会话管理」', panel.includes('会话管理'))
check('统计行含会话总数与可见数', /共 \d+ 个会话/.test(panel) && /· 可见 \d+/.test(panel), panel.slice(0, 200))
check('真实标题出现（Vue游戏项目资源与规范梳理）', panel.includes('Vue游戏项目资源与规范梳理'))
check('真实标题出现（基元律动自定义思考强度）', panel.includes('基元律动自定义思考强度'))
check('空会话默认隐藏（session-0d3c1453…）', !panel.includes('session-0d3c1453-80b4-45de-8dd6-90560d7e9811'))
check('子代理会话默认隐藏（76c31b14…）', !panel.includes('76c31b14-a201-457f-8d9c-f5ee425e13ef'))
check('未显示工作区名当作标题', !panel.includes('（myrzg）myrzg'))
check('「清理空会话」按钮显示可清理数量', /清理空会话（\d+）/.test(panel), panel.match(/清理空会话[^|]*/)?.[0] ?? '')

// 勾选「显示空会话」——现在有四个开关（空会话/归档/子代理/删除时连带子代理），
// 空会话是第一个，所以下面仍按 checkboxes[0] 取。
const checkboxes = tree.filter((n) => typeof n === 'object' && n !== null && n.props?.type === 'checkbox')
check('渲染出四个可见性/删除选项开关', checkboxes.length === 4, `count=${checkboxes.length}`)
if (checkboxes.length >= 4) {
  /**
   * 不写死具体会话 id：空会话是**运行期数据**，某个会话一旦被提问就不再是空会话，
   * 写死 id 的断言会随用户使用而失效（这条以前就是这么烂掉的）。
   * 改为比较开关前后的「空会话」标记数量：打开后必须**增加**。
   */
  const blankMarks = (t) => (t.match(/空会话/g) ?? []).length
  const before = blankMarks(text())
  checkboxes[0].props.onChange({ target: { checked: true } })
  await settle(() => blankMarks(text()) > before, 2000)
  const withBlank = text()
  check('勾选后空会话行出现（标记数增加）', blankMarks(withBlank) > before, `before=${before} after=${blankMarks(withBlank)}`)
  check('勾选后空会话带「空会话」标记', withBlank.includes('空会话'))
}

check('至少请求过一次 host API', fetchCalls.some((c) => String(c.url ?? c).includes('/dsh-session-manager/api/sessions')), JSON.stringify(fetchCalls.slice(0, 2)))

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL（${failures} 项）`)
process.exit(failures === 0 ? 0 : 1)
