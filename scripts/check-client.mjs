import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Harness concatenates classic scripts. ESM import() would hide a fatal export/import.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const entries = []
const context = vm.createContext({ window: { __ModuleLoader__: { load: (entry) => entries.push(entry) } } })
const script = new vm.Script(source, { filename: 'client.js' })
script.runInContext(context)
script.runInContext(context) // HMR must not collide with top-level lexical declarations.
assert.equal(entries.length, 2)
for (const entry of entries) {
  assert.equal(entry.id, '@dsh-external/session-console')
  assert.equal(typeof entry.factory, 'function')
}
console.log('client: classic script registration + reload PASS')
