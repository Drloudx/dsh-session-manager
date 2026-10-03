/**
 * 一次性诊断脚本：把磁盘上的每个会话目录/日志与 host API 的语料对照。
 *
 * 目的：解释「归档会话在面板里看不见」这类"行数对不上"的现象——
 * 到底是没有日志文件、编码不匹配、还是 header 的 id/cwd 与目录路径不一致。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const root = join(homedir(), '.dsh', 'sessions')

const decompress = (buf) => zstdDecompressSync(buf)

// 与官方 projectKey 一致：/ \ : 折叠成一个 '-'，其余非 [A-Za-z0-9._-~] 用 ~XXXX
function projectDir(cwd) {
  let readable = ''
  let separatorRun = false
  for (const ch of cwd) {
    const code = ch.charCodeAt(0)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

const rows = []
for (const project of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  const projectPath = join(root, project.name)
  for (const dir of readdirSync(projectPath, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const dirPath = join(projectPath, dir.name)
    const files = readdirSync(dirPath).filter((n) => /\.jsonl(\.zstd)?$/.test(n))
    const generations = files.map((n) => ({ n, v: Number(n.match(/\.v(\d+)\./)?.[1] ?? 0) })).sort((a, b) => b.v - a.v)
    let header = null
    let err = null
    const chosen = generations[0]
    if (chosen) {
      try {
        const buf = readFileSync(join(dirPath, chosen.n))
        let text
        if (chosen.n.endsWith('.zstd')) {
          if (decompress === null) throw new Error('no zstd decoder')
          text = Buffer.from(decompress(new Uint8Array(buf))).toString('utf8')
        } else text = buf.toString('utf8')
        header = JSON.parse(text.split('\n', 1)[0])
      } catch (e) { err = String(e) }
    }
    const expectProject = header?.cwd ? projectDir(header.cwd) : null
    rows.push({
      project: project.name,
      dir: dir.name,
      file: chosen?.n ?? '(none)',
      gens: generations.map((g) => g.n).join(','),
      id: header?.id ?? null,
      idMatch: header?.id ? header.id === dir.name : null,
      cwd: header?.cwd ?? null,
      seeded: header?.isSeeded ?? null,
      parent: header?.parentSession ?? null,
      origin: header?.origin ?? null,
      createdAt: header?.createdAt ?? null,
      pathOk: expectProject === null ? null : expectProject === project.name,
      expectProject,
      err,
    })
  }
}

console.log('磁盘会话目录总数:', rows.length)
const bad = rows.filter((r) => r.err || r.idMatch === false || r.pathOk === false)
console.log('异常条目:', bad.length)
for (const r of bad) {
  console.log('---')
  console.log('  project   :', r.project)
  console.log('  dir       :', r.dir)
  console.log('  file      :', r.file, '| gens:', r.gens)
  console.log('  header.id :', r.id, '| id===dir:', r.idMatch)
  console.log('  header.cwd:', r.cwd, '| 期望 project:', r.expectProject, '| pathOk:', r.pathOk)
  console.log('  isSeeded:', r.seeded, '| parent:', r.parent, '| origin:', r.origin)
  if (r.err) console.log('  ERROR:', r.err)
}
console.log('\n全部条目:')
for (const r of rows) {
  console.log(`  [${r.idMatch === false || r.pathOk === false || r.err ? 'BAD' : ' ok'}] ${r.project} / ${r.dir} / ${r.file} id=${r.id} cwd=${r.cwd}`)
}
