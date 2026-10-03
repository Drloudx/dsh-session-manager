#!/usr/bin/env node
/**
 * 一次性修复脚本：清掉 workspace.json 里「已经没有任何会话目录」的归档标记。
 *
 * 为什么会有这些标记：DSH 只提供 `archiveSession()`、**没有 unarchive**。会话目录被删除
 * 之后，`archivedSessionIds` 里那条 id 会永久残留——它既不产生任何可见行（官方列举里
 * 没有这个 id），又让面板统计的「归档 N」和实际能看到的归档行数对不上
 * （用户反馈："为什么有的归档的我看不见"）。
 *
 * 判定口径（必须与 host 插件一致，避免误删**仍可读**的归档）：
 *   归档集里的 id，如果在
 *     1. 官方语料（sessionQuery.listSessions()）里没有，且
 *     2. 磁盘 `sessions/<项目目录>/<id>/session.vN.jsonl.zstd` 也不存在
 *   才算幽灵。任何一边还在（哪怕是当前 DSH 读不出的更高版本日志），都保留。
 *
 * 用法：
 *   node scripts/clean-ghost-archives.mjs            # 只预览（dry-run）
 *   node scripts/clean-ghost-archives.mjs --apply    # 备份后写入
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const APPLY = process.argv.includes('--apply')
const API = 'http://127.0.0.1:3080/dsh-session-manager/api/sessions'
const dshHome = (process.env.DSH_HOME || join(homedir(), '.dsh')).replace(/[\\/]+$/, '')
const workspaceFile = join(dshHome, 'storages', 'workspace.json')
const sessionsRoot = join(dshHome, 'sessions')

/** 磁盘上所有会话 id（目录名即 id；目录名可能不带 session- 前缀）。 */
function diskSessionIds() {
  const ids = new Set()
  if (!existsSync(sessionsRoot)) return ids
  for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectPath = join(sessionsRoot, project.name)
    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name)
    }
  }
  return ids
}

const response = await fetch(API)
if (!response.ok) {
  console.error(`读取会话语料失败：HTTP ${response.status}（请确认 dsh web 正在运行）`)
  process.exit(1)
}
const corpus = await response.json()
const corpusIds = new Set((corpus.sessions ?? []).map((row) => String(row.id)))
const onDisk = diskSessionIds()

const raw = readFileSync(workspaceFile, 'utf8')
const data = JSON.parse(raw)
const archived = Array.isArray(data?.global?.archivedSessionIds) ? data.global.archivedSessionIds.map(String) : []
if (archived.length === 0) {
  console.log('归档集为空，无需修复。')
  process.exit(0)
}

const ghosts = archived.filter((id) => !corpusIds.has(id) && !onDisk.has(id))
const kept = archived.filter((id) => !ghosts.includes(id))

console.log(`归档集共 ${archived.length} 条：语料/磁盘仍可找到 ${kept.length} 条，幽灵标记 ${ghosts.length} 条`)
for (const id of ghosts) console.log(`  幽灵  ${id}`)
for (const id of kept) {
  const why = corpusIds.has(id) ? '语料可见' : '仅磁盘可见（当前 DSH 读不出，保留）'
  console.log(`  保留  ${id}  ← ${why}`)
}

if (ghosts.length === 0) {
  console.log('没有需要清理的幽灵归档标记。')
  process.exit(0)
}
if (!APPLY) {
  console.log('\n（dry-run）加 --apply 才会写入。')
  process.exit(0)
}

const backup = `${workspaceFile}.bak-ghost-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
copyFileSync(workspaceFile, backup)
data.global.archivedSessionIds = kept
writeFileSync(workspaceFile, JSON.stringify(data, null, 2) + '\n', 'utf8')
console.log(`\n已写入 ${workspaceFile}`)
console.log(`备份：${backup}`)
console.log(`归档集 ${archived.length} → ${kept.length}`)
console.log('\n注意：内存里的 workspaceRegistry 仍然持有旧集合，需要重启 dsh web（或用面板的 /repair-archives）才会完全一致。')
