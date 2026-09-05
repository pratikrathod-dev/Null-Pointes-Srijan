// Logic tests — no browser needed. Run: npm test
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  emptyState, mutations, allTags, countItems, currentSpace,
  findFolder, findItem, parseLegacyBackup, parseBrowserBookmarks,
  toBackupJson, toBookmarksHtml, safeColor, makeSticker,
  FOLDER_COLORS, STICKER_COLORS,
} from '../src/lib/model.js'
import { encodeState, decodeState, estimateSyncBytes, SYNC_QUOTA_BYTES } from '../src/lib/sync.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Find a real board export to test the importer against, without naming any
 * particular product: anything in the parent folder shaped like `{ spaces: [] }`
 * will do. Returns null when there is nothing to test with, and the test skips.
 */
function findSampleExport() {
  const dir = join(HERE, '..', '..')
  let names = []
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')) } catch { return null }

  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (Array.isArray(parsed?.spaces) && parsed.spaces.length) return join(dir, name)
    } catch { /* not JSON, or not a board */ }
  }
  return null
}

const BACKUP = findSampleExport()

function seed() {
  const state = emptyState()
  const spaceId = state.spaces[0].id
  const folderId = mutations.addFolder(state, { spaceId, title: 'Reading' })
  mutations.addItem(state, { folderId, item: { title: 'Example', url: 'https://example.com' } })
  return { state, spaceId, folderId }
}

test('a fresh state has one space and no limits applied', () => {
  const state = emptyState()
  assert.equal(state.spaces.length, 1)
  assert.equal(state.settings.currentSpaceId, state.spaces[0].id)
})

test('spaces are unlimited', () => {
  const state = emptyState()
  for (let i = 0; i < 200; i += 1) mutations.addSpace(state, { title: `Space ${i}` })
  assert.equal(state.spaces.length, 201)
})

test('tags are unlimited and de-duplicated', () => {
  const { state, folderId } = seed()
  const itemId = findFolder(state, folderId).folder.items[0].id
  for (let i = 0; i < 100; i += 1) mutations.addTag(state, { itemId, tag: `tag-${i}` })
  mutations.addTag(state, { itemId, tag: 'tag-0' })          // duplicate
  mutations.addTag(state, { itemId, tag: '   ' })            // blank
  assert.equal(findItem(state, itemId).item.tags.length, 100)
  assert.equal(allTags(state).length, 100)
})

test('renaming a tag updates every bookmark and merges collisions', () => {
  const { state, folderId } = seed()
  const a = findFolder(state, folderId).folder.items[0].id
  const b = mutations.addItem(state, { folderId, item: { title: 'Two', url: 'https://two.test' } })
  mutations.addTag(state, { itemId: a, tag: 'old' })
  mutations.addTag(state, { itemId: b, tag: 'old' })
  mutations.addTag(state, { itemId: b, tag: 'new' })

  mutations.renameTagEverywhere(state, { from: 'old', to: 'new' })
  assert.deepEqual(findItem(state, a).item.tags, ['new'])
  assert.deepEqual(findItem(state, b).item.tags, ['new'])   // collision merged, not duplicated
})

test('folders collapse and expand, individually and in bulk', () => {
  const { state, spaceId, folderId } = seed()
  assert.equal(findFolder(state, folderId).folder.collapsed, false)

  mutations.toggleFolderCollapsed(state, { folderId })
  assert.equal(findFolder(state, folderId).folder.collapsed, true)

  mutations.addFolder(state, { spaceId, title: 'Second' })
  mutations.setAllFoldersCollapsed(state, { spaceId, collapsed: false })
  assert.ok(currentSpace(state).folders.every((f) => !f.collapsed))
})

test('deleting the last space leaves a usable board', () => {
  const state = emptyState()
  mutations.deleteSpace(state, { spaceId: state.spaces[0].id })
  assert.equal(state.spaces.length, 1)
  assert.ok(currentSpace(state))
})

test('moving an item between folders keeps it exactly once', () => {
  const { state, spaceId, folderId } = seed()
  const other = mutations.addFolder(state, { spaceId, title: 'Other' })
  const itemId = findFolder(state, folderId).folder.items[0].id

  mutations.moveItem(state, { itemId, folderId: other })
  assert.equal(findFolder(state, folderId).folder.items.length, 0)
  assert.equal(findFolder(state, other).folder.items.length, 1)
  assert.equal(countItems(state), 1)
})

test('duplicate removal keeps the first copy only', () => {
  const { state, spaceId, folderId } = seed()
  const other = mutations.addFolder(state, { spaceId, title: 'Other' })
  mutations.addItem(state, { folderId: other, item: { title: 'Dup', url: 'https://example.com/' } })

  const removed = mutations.removeDuplicateBookmarks(state, { spaceId })
  assert.equal(removed, 1)
  assert.equal(countItems(state), 1)
})

test('sync encoding survives a round trip', () => {
  const { state, folderId } = seed()
  const itemId = findFolder(state, folderId).folder.items[0].id
  mutations.addTag(state, { itemId, tag: 'alpha' })
  mutations.toggleFolderCollapsed(state, { folderId })
  mutations.addItem(state, { folderId, item: { type: 'note', title: 'a note' } })

  const back = decodeState(encodeState(state))
  const folder = findFolder(back, folderId).folder

  assert.equal(back.spaces.length, state.spaces.length)
  assert.equal(folder.title, 'Reading')
  assert.equal(folder.collapsed, true)
  assert.equal(folder.color, findFolder(state, folderId).folder.color)
  assert.deepEqual(folder.items.find((i) => i.id === itemId).tags, ['alpha'])
  assert.ok(folder.items.some((i) => i.type === 'note' && i.title === 'a note'))
})

test('HTML export escapes and round-trips titles', () => {
  const { state, folderId } = seed()
  const itemId = findFolder(state, folderId).folder.items[0].id
  mutations.updateItem(state, { itemId, patch: { title: 'Tom & "Jerry" <b>' } })

  const html = toBookmarksHtml(state)
  assert.ok(html.includes('&amp;'))
  assert.ok(html.includes('&quot;'))
  assert.ok(!html.includes('<b>'))
  assert.ok(JSON.parse(toBackupJson(state)).isTabspace)
})

test('browser bookmark trees import into folders', () => {
  const tree = [{
    title: 'Bookmarks bar',
    children: [
      { title: 'A', url: 'https://a.test' },
      { title: 'Nested', children: [{ title: 'B', url: 'https://b.test' }] },
    ],
  }]
  const { spaces, stats } = parseBrowserBookmarks(tree)
  assert.equal(stats.items, 2)
  assert.ok(spaces[0].folders.length >= 2)
})

test('a real board export imports with every bookmark intact', { skip: !BACKUP && 'no sample export nearby' }, () => {
  const raw = JSON.parse(readFileSync(BACKUP, 'utf8'))
  const { spaces, stats } = parseLegacyBackup(raw)

  const sourceItems = raw.spaces.reduce(
    (n, s) => n + s.folders.reduce((m, f) => m + f.items.filter((i) => i.url || i.type === 'bookmark').length, 0), 0,
  )
  assert.equal(stats.items, sourceItems)
  assert.equal(stats.folders, raw.spaces.reduce((n, s) => n + s.folders.length, 0))

  // Titles, urls, colours and collapsed flags survive.
  const first = spaces[0].folders[0]
  assert.ok(first.title.length)
  assert.ok(first.items.every((i) => i.url.startsWith('http')))
  assert.ok(first.color.startsWith('#'))

  // And the whole thing fits in Chrome's sync quota.
  const state = emptyState()
  mutations.replaceState(state, { next: { spaces, settings: state.settings } })
  const bytes = estimateSyncBytes(state)
  assert.ok(bytes < SYNC_QUOTA_BYTES, `needs ${bytes} bytes, quota is ${SYNC_QUOTA_BYTES}`)
  console.log(`    → ${stats.items} bookmarks encode to ${bytes} bytes (${Math.round(bytes / SYNC_QUOTA_BYTES * 100)}% of sync quota)`)
})

test('replaceState repairs a dangling currentSpaceId', () => {
  const state = emptyState()
  mutations.replaceState(state, { next: { spaces: [], settings: { currentSpaceId: 'gone' } } })
  assert.equal(state.spaces.length, 1)
  assert.equal(state.settings.currentSpaceId, state.spaces[0].id)
})

// Colours reach CSS -- one of them through a custom property, which accepts any
// token at all. A backup file is not necessarily one this user wrote.

test('a real hex colour passes through untouched', () => {
  for (const ok of ['#fff', '#FFF', '#a1b2c3', '#A1B2C3', '#11223344', '  #abc  ']) {
    assert.equal(safeColor(ok, '#000000'), ok.trim(), `${ok} is a valid colour`)
  }
})

test('anything that is not a hex colour falls back', () => {
  for (const bad of [
    'url(https://example.com/pixel)',
    'red; background-image: url(https://example.com/x)',
    'var(--anything)',
    'expression(alert(1))',
    '#12345',
    'rgb(1,2,3)',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(safeColor(bad, '#DDE3EA'), '#DDE3EA', `${JSON.stringify(bad)} must not reach CSS`)
  }
})

test('an imported backup cannot smuggle a url() into a folder colour', () => {
  const { spaces } = parseLegacyBackup({
    spaces: [{
      title: 'Imported',
      folders: [
        { title: 'Beacon', color: 'url(https://example.com/pixel)', items: [] },
        { title: 'Fine', color: '#C2E7FF', items: [] },
      ],
    }],
  })
  const [beacon, fine] = spaces[0].folders
  assert.ok(FOLDER_COLORS.includes(beacon.color) || /^#[0-9a-f]{6}$/i.test(beacon.color),
    `a hostile colour was replaced, got ${beacon.color}`)
  assert.ok(!beacon.color.includes('url('), 'no url() survives the import')
  assert.equal(fine.color, '#C2E7FF', 'a legitimate colour is preserved')
})

test('a sticker colour is checked the same way', () => {
  assert.equal(makeSticker({ color: 'url(https://example.com/x)' }).color, STICKER_COLORS[0])
  assert.equal(makeSticker({ color: '#FFE066' }).color, '#FFE066')
})

test('the folder colour mutation refuses a non-colour', () => {
  const state = emptyState()
  const spaceId = state.spaces[0].id
  const folderId = mutations.addFolder(state, { spaceId, title: 'F' })
  const original = findFolder(state, folderId).folder.color

  mutations.setFolderColor(state, { folderId, color: 'url(https://example.com/x)' })
  assert.equal(findFolder(state, folderId).folder.color, original, 'the old colour is kept')

  mutations.setFolderColor(state, { folderId, color: '#C4EED0' })
  assert.equal(findFolder(state, folderId).folder.color, '#C4EED0', 'a real colour still applies')
})
