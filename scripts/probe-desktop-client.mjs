#!/usr/bin/env node
/**
 * 桌面端/网页端客户端插件加载探测（只读，不改任何状态）。
 *
 * 用法：在 DSH 界面的 DevTools Console 里粘贴 build/probe.js 的内容并回车。
 * 本脚本负责把探测代码写到 build/probe.js，并把结果同时 console.log + 复制到剪贴板。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const probe = String.raw`(() => {
  const ID = '@dsh-external/session-console'
  const out = {}
  try {
    const boot = globalThis.__DSH_BOOT__
    const entries = (boot && boot.entries) || []
    out.bootPresent = !!boot
    out.bootEntryIds = entries.map((e) => e.id)
    out.sessionConsoleInGraph = entries.some((e) => e.id === ID)
    out.sessionConsoleRow = entries.find((e) => e.id === ID) || null
    out.batches = ((boot && boot.batches) || []).map((b) => ({ phase: b.phase, entries: b.entries }))
    out.bootRev = boot ? boot.rev : null
  } catch (e) { out.bootError = String(e) }
  out.moduleLoader = typeof globalThis.__ModuleLoader__
  out.bootReady = typeof globalThis.__DSH_BOOT_READY__
  out.origin = location.origin
  out.hasSlotsService = (() => { try { return typeof document !== 'undefined' } catch { return false } })()
  out.sidebarFooterButtons = Array.from(document.querySelectorAll('button'))
    .filter((b) => (b.getAttribute('aria-label') || '') === '会话管理')
    .length
  out.registeredStyleTags = document.querySelectorAll('style[data-dshsm]').length
  out.errorOverlay = Array.from(document.querySelectorAll('*'))
    .filter((el) => /模块|module|failed|失败/i.test(el.textContent || '') && el.children.length === 0)
    .slice(0, 5)
    .map((el) => (el.textContent || '').trim().slice(0, 120))
  return JSON.stringify(out, null, 2)
})()`

mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build', 'probe.js'), probe + '\n')
console.log('wrote ' + join(root, 'build', 'probe.js'))
console.log('--- paste this into the DSH DevTools console ---')
console.log(probe)
