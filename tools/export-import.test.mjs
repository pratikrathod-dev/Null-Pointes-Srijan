// Round-trips the dashboard's board export through the extension's real
// importer. The bug this pins down: tabspace_export returns a database row with
// the board nested under `state`, while parseLegacyBackup reads `spaces` off the
// top level, so downloading a row and importing it failed with
// 'Not a recognised backup: no "spaces" array.'
//
//   node tools/export-import.test.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLegacyBackup } from '../src/lib/model.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Pull toBackup out of the shipped page, so this tests the real code rather
// than a copy of it that could drift.
const html = readFileSync(join(ROOT, 'dashboard', 'index.html'), 'utf8')
const src = html.match(/function toBackup\(row\) \{[\s\S]*?\n\}/)?.[0]
if (!src) throw new Error('toBackup not found in dashboard/index.html')
const toBackup = new Function(`${src}; return toBackup`)()

// Exactly the shape tabspace_export returns.
const row = {
  email: 'someone@example.com',
  exported_at: '2026-08-29T00:00:00Z',
  rev: 7,
  updated_at: '2026-08-28T18:00:00Z',
  state: {
    version: 2,
    settings: { theme: 'dark', openInNewTab: true },
    spaces: [{
      id: 's1', title: 'Research', position: 1000,
      widgets: [{ text: 'read later', color: '#FFF7B2', fontSize: 18, x: 40, y: 60 }],
      folders: [{
        id: 'f1', title: 'Papers', color: '#C4EED0', collapsed: false, position: 1000, tags: ['work'],
        items: [
          { id: 'b1', type: 'bookmark', title: 'Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762', tags: ['ml'], position: 1000 },
          { id: 'g1', type: 'group', title: 'To read', collapsed: false, position: 2000, groupItems: [
            { id: 'b2', type: 'bookmark', title: 'MDN', url: 'https://developer.mozilla.org', tags: [], position: 1000 },
          ] },
          { id: 'n1', type: 'note', title: 'ask about GPUs', position: 3000 },
        ],
      }],
    }],
  },
}

const results = []
const check = (label, pass, extra = '') =>
  results.push(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '  - ' + extra : ''}`)

// The regression itself: the raw row must not be importable.
let rawFailed = false
let rawMessage = ''
try {
  parseLegacyBackup(JSON.stringify(row))
} catch (err) {
  rawFailed = true
  rawMessage = err.message
}
check('the raw database row is what produced the reported error', rawFailed, rawMessage)

// The fix.
const file = toBackup(row)
check('the file carries spaces at the top level', Array.isArray(file.spaces))
check('it is marked as a Tabspace backup', file.isTabspace === true)
check('the state version is carried over', file.version === 2, String(file.version))
check('the account is recorded alongside', file.account?.email === 'someone@example.com')

const out = parseLegacyBackup(JSON.stringify(file))
const space = out.spaces[0]
const folder = space.folders[0]
const items = folder.items
const group = items.find((i) => i.type === 'group')

check('it imports without throwing', out.spaces.length === 1, `${out.spaces.length} spaces`)
check('the space keeps its name', space.title === 'Research', space.title)
check('the folder keeps its name', folder.title === 'Papers', folder.title)
check('the folder keeps its colour', folder.color === '#C4EED0', folder.color)
check('the folder keeps its tags', JSON.stringify(folder.tags) === '["work"]', JSON.stringify(folder.tags))
check('the bookmark survives with its URL',
  items.some((i) => i.url === 'https://arxiv.org/abs/1706.03762'),
  items.map((i) => i.type).join(', '))
check('the note survives', items.some((i) => i.type === 'note' && i.title === 'ask about GPUs'))
check('the group survives', Boolean(group), group?.title ?? 'missing')
check('the nested bookmark inside the group survives',
  group?.groupItems?.[0]?.title === 'MDN', group?.groupItems?.[0]?.title ?? 'missing')
check('the sticky note survives', space.widgets?.[0]?.text === 'read later',
  space.widgets?.[0]?.text ?? 'missing')
// importStats counts a group's children as items and the group itself
// separately, so this board is: 1 folder, 3 items (loose bookmark + note +
// the bookmark inside the group), 1 group, 1 sticker.
check('the reported stats match what went in',
  out.stats.spaces === 1 && out.stats.folders === 1 && out.stats.items === 3
  && out.stats.groups === 1 && out.stats.stickers === 1,
  JSON.stringify(out.stats))

// An empty board must not blow up either.
const empty = toBackup({ email: 'nobody@example.com', state: {} })
let emptyOk = true
try { parseLegacyBackup(JSON.stringify(empty)) } catch { emptyOk = false }
check('a board with no state still produces an importable file', emptyOk)

console.log('\n--- dashboard export -> extension import ---')
console.log(results.join('\n'))
const failed = results.filter((r) => r.includes('FAIL')).length
console.log(`\n${results.length - failed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
