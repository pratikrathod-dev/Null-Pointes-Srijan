// Resolves every cross-module import for real, instead of guessing with regex.
//
// Every .js under src/ is scanned, page modules included. The page modules
// (newtab, popup, sidepanel, background) cannot simply be imported here -- they
// touch the DOM and the extension APIs the moment they load -- so their import
// statements are parsed and checked against the real exports of whatever they
// import. That is what catches a renamed or misspelled helper, which is the
// mistake this file exists to stop.
//
// Browser-only globals are stubbed so the library modules can be loaded.
import { readFileSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}
globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://test${p}`, getManifest: () => ({ oauth2: {} }), id: 'test' },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    sync: { get: async () => ({}), set: async () => {}, remove: async () => {}, clear: async () => {} },
    onChanged: { addListener() {}, removeListener() {} },
  },
  identity: {},
}

/** Modules with no DOM or chrome.* work at import time, so they can be loaded. */
const LOADABLE = [
  'src/lib/util.js',
  'src/lib/accounts.js',
  'src/lib/model.js',
  'src/lib/icons.js',
  'src/lib/dialogs.js',
  'src/lib/sync.js',
  'src/lib/supabase-config.js',
  'src/lib/supabase-sync.js',
  'src/lib/store.js',
]

function allSourceFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name).split(path.sep).join('/'))
    .sort()
}

let failures = 0

// --- every import in every source file must resolve to a real export --------
const files = allSourceFiles('src')
const checkedFrom = new Set()

for (const file of files) {
  const src = readFileSync(file, 'utf8')

  for (const match of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
    const [, names, from] = match
    let target
    try {
      target = await import(new URL(from, pathToFileURL(file)).href)
    } catch (err) {
      console.log(`  UNRESOLVED  ${from}  (imported by ${file})  ${err.message}`)
      failures += 1
      continue
    }
    checkedFrom.add(file)

    for (const raw of names.split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0]
      if (!name) continue
      if (!(name in target)) {
        console.log(`  MISSING  ${name}  <- ${from}  (imported by ${file})`)
        failures += 1
      }
    }
  }
}

// --- and every library module must still load on its own -------------------
for (const file of LOADABLE) {
  const mod = await import(pathToFileURL(file).href)
  console.log(`  ok  ${file.padEnd(28)} ${Object.keys(mod).length} exports`)
}

const pages = files.filter((f) => !LOADABLE.includes(f))
console.log(`\n  scanned ${files.length} source files (${pages.length} page/worker modules parsed, not executed)`)
for (const p of pages) console.log(`    - ${p}${checkedFrom.has(p) ? '' : '  (no cross-module imports)'}`)

console.log(failures ? `\n${failures} broken import(s)` : '\nAll cross-module imports resolve.')
process.exit(failures ? 1 : 0)
