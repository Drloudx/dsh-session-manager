#!/usr/bin/env node
/**
 * 构建：src/**\/*.ts → lib/（tsc 直编，src 是唯一真源，不再手工同步 lib）。
 *
 * tsc 位置解析顺序：
 *   1. 插件自带 node_modules/typescript（npm i 即可，无需 DSH 源码 checkout）
 *   2. DSH_CHECKOUT 指向的源码 checkout（$CHECKOUT/node_modules/.bin/tsc）
 *   3. 常见 checkout 路径（~/dsh-harness 等）
 *
 * 用法：node scripts/build.mjs [--watch]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'

function tscIn(nodeModulesDir) {
  const candidates = [
    join(nodeModulesDir, 'typescript', 'bin', 'tsc'),
    join(nodeModulesDir, 'typescript', 'lib', 'tsc.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function findTsc() {
  const local = tscIn(join(root, 'node_modules'))
  if (local !== null) return { path: local, via: 'plugin node_modules' }

  const checkouts = [process.env.DSH_CHECKOUT, join(homedir(), 'dsh-harness'), join(homedir(), 'dsh'), join(homedir(), '.dsh', 'dsh-harness')]
    .filter((v) => typeof v === 'string' && v !== '')
  for (const checkout of checkouts) {
    if (!existsSync(join(checkout, 'packages'))) continue
    const binDir = join(checkout, 'node_modules', '.bin')
    if (!existsSync(binDir)) continue
    const names = readdirSync(binDir)
    const tscName = names.find((n) => n === 'tsc' || n === 'tsc.cmd' || n === 'tsc.ps1')
    if (tscName) return { path: join(binDir, tscName), via: `checkout ${checkout}` }
    const viaNodeModules = tscIn(join(checkout, 'node_modules'))
    if (viaNodeModules !== null) return { path: viaNodeModules, via: `checkout ${checkout}` }
  }
  return null
}

const found = findTsc()
if (found === null) {
  console.error('build: 找不到 tsc。请在插件目录执行 `npm i -D typescript @types/node`（或设置 DSH_CHECKOUT 指向 DSH 源码 checkout）。')
  process.exit(1)
}

const configs = ['tsconfig.json', 'tsconfig.client.json']
const flags = process.argv.slice(2)
if (flags.includes('--watch')) {
  const children = configs.map((config) => spawn(process.execPath,
    [found.path, '-p', join(root, config), ...flags], { cwd: root, stdio: 'inherit' }))
  const stop = () => children.forEach((child) => child.kill())
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  for (const child of children) child.on('error', (error) => {
    console.error(error)
    stop()
    process.exitCode = 1
  })
} else {
  for (const config of configs) {
    const result = spawnSync(process.execPath,
      [found.path, '-p', join(root, config), ...flags], { cwd: root, stdio: 'inherit' })
    if (result.error) {
      console.error('build: tsc 执行失败:', result.error.message)
      process.exit(1)
    }
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
  if (!flags.includes('--noEmit')) {
    const check = spawnSync(process.execPath, [join(root, 'scripts/check-client.mjs')], { cwd: root, stdio: 'inherit' })
    if (check.status !== 0) process.exit(check.status ?? 1)
  }
  console.log(`build: ok (tsc via ${found.via}; host ESM + client classic script)`)
}
