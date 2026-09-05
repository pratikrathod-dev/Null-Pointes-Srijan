// Tests for groups, the sticker canvas, and the v2 import path.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  emptyState, mutations, allTags, countItems,
  findFolder, findItem, findGroup, findSpace, findSticker,
  parseLegacyBackup, toBookmarksHtml,
} from '../src/lib/model.js'
import { encodeState, decodeState } from '../src/lib/sync.js'

function seed() {
  const state = emptyState()
  const spaceId = state.spaces[0].id
  const folderId = mutations.addFolder(state, { spaceId, title: 'Reading' })
  mutations.addItem(state, { folderId, item: { title: 'Example', url: 'https://example.com' } })
  return { state, spaceId, folderId }
}

// ------------------------------------------------------------------ groups ---

test('bookmarks group in place and keep their order', () => {
  const { state, folderId } = seed()
  const b = mutations.addItem(state, { folderId, item: { title: 'B', url: 'https://b.test' } })
  mutations.addItem(state, { folderId, item: { title: 'C', url: 'https://c.test' } })
  const items = findFolder(state, folderId).folder.items
  const a = items[0].id
  const c = items[2].id

  const groupId = mutations.createGroup(state, { folderId, itemIds: [a, c], title: 'Pair' })
  const folder = findFolder(state, folderId).folder

  assert.equal(folder.items.length, 2)                  // B, plus the new group
  const group = folder.items.find((i) => i.id === groupId)
  assert.deepEqual(group.groupItems.map((i) => i.title), ['Example', 'C'])
  assert.ok(folder.items.some((i) => i.id === b))       // the ungrouped one stays
  assert.equal(countItems(state), 3)                    // nothing lost
})

test('items inside groups are found, tagged and counted', () => {
  const { state, folderId } = seed()
  const a = findFolder(state, folderId).folder.items[0].id
  const groupId = mutations.createGroup(state, { folderId, itemIds: [a], title: 'G' })

  mutations.addTag(state, { itemId: a, tag: 'inside' })
  assert.deepEqual(findItem(state, a).item.tags, ['inside'])
  assert.equal(findItem(state, a).group.id, groupId)
  assert.equal(allTags(state).length, 1)
  assert.equal(countItems(state), 1)
})

test('ungrouping returns bookmarks to the folder', () => {
  const { state, folderId } = seed()
  const a = findFolder(state, folderId).folder.items[0].id
  const groupId = mutations.createGroup(state, { folderId, itemIds: [a], title: 'G' })

  mutations.ungroup(state, { groupId })
  const folder = findFolder(state, folderId).folder
  assert.equal(folder.items.length, 1)
  assert.equal(folder.items[0].id, a)
  assert.equal(countItems(state), 1)
})

test('groups never nest inside each other', () => {
  const { state, folderId } = seed()
  const a = findFolder(state, folderId).folder.items[0].id
  const outer = mutations.createGroup(state, { folderId, itemIds: [], title: 'Outer' })
  const inner = mutations.createGroup(state, { folderId, itemIds: [a], title: 'Inner' })

  mutations.moveItem(state, { itemId: inner, folderId, groupId: outer })
  assert.equal(findGroup(state, outer).group.groupItems.length, 0)
  assert.ok(findFolder(state, folderId).folder.items.some((i) => i.id === inner))
})

test('moving a bookmark out of a group leaves it in the folder once', () => {
  const { state, folderId } = seed()
  const a = findFolder(state, folderId).folder.items[0].id
  mutations.createGroup(state, { folderId, itemIds: [a], title: 'G' })

  mutations.moveItem(state, { itemId: a, folderId })
  assert.equal(findItem(state, a).group, null)
  assert.equal(countItems(state), 1)
})

test('collapse-all reaches groups as well as folders', () => {
  const { state, spaceId, folderId } = seed()
  const a = findFolder(state, folderId).folder.items[0].id
  const groupId = mutations.createGroup(state, { folderId, itemIds: [a], title: 'G' })

  mutations.setAllFoldersCollapsed(state, { spaceId, collapsed: true })
  assert.equal(findFolder(state, folderId).folder.collapsed, true)
  assert.equal(findGroup(state, groupId).group.collapsed, true)
})

test('duplicate removal reaches inside groups', () => {
  const { state, spaceId, folderId } = seed()
  const dup = mutations.addItem(state, { folderId, item: { title: 'Dup', url: 'https://example.com/' } })
  mutations.createGroup(state, { folderId, itemIds: [dup], title: 'G' })

  assert.equal(mutations.removeDuplicateBookmarks(state, { spaceId }), 1)
  assert.equal(countItems(state), 1)
})

test('duplicating a folder gives every copied item a fresh id', () => {
  const { state, folderId } = seed()
  const a = findFolder(state, folderId).folder.items[0].id
  mutations.createGroup(state, { folderId, itemIds: [a], title: 'G' })

  const copyId = mutations.duplicateFolder(state, { folderId })
  const copy = findFolder(state, copyId).folder
  const original = findFolder(state, folderId).folder

  assert.notEqual(copy.id, original.id)
  assert.notEqual(copy.items[0].id, original.items[0].id)
  assert.notEqual(copy.items[0].groupItems[0].id, original.items[0].groupItems[0].id)
  assert.equal(countItems(state), 2)
})

// ---------------------------------------------------------------- stickers ---

test('stickers live on the space and move freely', () => {
  const { state, spaceId } = seed()
  const id = mutations.addSticker(state, { spaceId, sticker: { text: 'hello', x: 10, y: 20 } })
  assert.equal(findSpace(state, spaceId).widgets.length, 1)

  mutations.moveSticker(state, { stickerId: id, x: 300.6, y: -50 })
  const sticker = findSticker(state, id).sticker
  assert.equal(sticker.x, 301)                          // rounded
  assert.equal(sticker.y, 0)                            // clamped, never off-board

  mutations.updateSticker(state, { stickerId: id, patch: { strikethrough: true } })
  assert.equal(findSticker(state, id).sticker.strikethrough, true)

  mutations.deleteSticker(state, { stickerId: id })
  assert.equal(findSpace(state, spaceId).widgets.length, 0)
})

test('stickers are unlimited', () => {
  const { state, spaceId } = seed()
  for (let i = 0; i < 150; i += 1) mutations.addSticker(state, { spaceId, sticker: { text: `n${i}` } })
  assert.equal(findSpace(state, spaceId).widgets.length, 150)
})

// ----------------------------------------------------------------- upkeep ---

test('repairFavicons clears stored icons in the current space only', () => {
  const { state, spaceId, folderId } = seed()
  const otherSpace = mutations.addSpace(state, { title: 'Other' })
  const otherFolder = mutations.addFolder(state, { spaceId: otherSpace, title: 'F' })
  mutations.addItem(state, {
    folderId: otherFolder,
    item: { title: 'X', url: 'https://x.test', favicon: 'https://x.test/f.ico' },
  })
  mutations.updateItem(state, {
    itemId: findFolder(state, folderId).folder.items[0].id,
    patch: { favicon: 'https://stale.example/icon.png' },
  })

  assert.equal(mutations.repairFavicons(state, { spaceId }), 1)
  assert.equal(findFolder(state, folderId).folder.items[0].favicon, '')
  assert.equal(findFolder(state, otherFolder).folder.items[0].favicon, 'https://x.test/f.ico')
})

// ------------------------------------------------------------------- sync ---

test('sync round trip preserves groups and stickers', () => {
  const { state, spaceId, folderId } = seed()
  const a = findFolder(state, folderId).folder.items[0].id
  const groupId = mutations.createGroup(state, { folderId, itemIds: [a], title: 'Kept' })
  mutations.toggleGroupCollapsed(state, { groupId })
  mutations.addTag(state, { itemId: a, tag: 'deep' })
  mutations.addSticker(state, { spaceId, sticker: { text: 'note', x: 12, y: 34 } })

  const back = decodeState(encodeState(state))
  const group = findGroup(back, groupId).group

  assert.equal(group.title, 'Kept')
  assert.equal(group.collapsed, true)
  assert.deepEqual(group.groupItems[0].tags, ['deep'])
  assert.equal(findSpace(back, spaceId).widgets[0].text, 'note')
  assert.equal(findSpace(back, spaceId).widgets[0].x, 12)
  assert.equal(findSpace(back, spaceId).widgets[0].y, 34)
  assert.equal(countItems(back), 1)
})

// ----------------------------------------------------------------- import ---

test('legacy groups and sticker widgets import without flattening', () => {
  const raw = {
    version: 3,
    spaces: [{
      title: 'S',
      position: 'a',
      folders: [{
        title: 'F',
        position: 'a',
        color: '#ffffff',
        collapsed: true,
        items: [
          { type: 'bookmark', title: 'Loose', url: 'https://loose.test', position: 'a', tags: [] },
          {
            type: 'group',
            title: 'Grouped',
            position: 'b',
            collapsed: true,
            groupItems: [{ type: 'bookmark', title: 'In', url: 'https://in.test', tags: [{ text: 'x' }] }],
          },
        ],
      }],
      widgets: [{
        content: { text: 'sticky', color: '#fff8c5', fontSize: 24, strikethrough: true },
        positionX: 5,
        positionY: 6,
      }],
    }],
  }

  const { spaces, stats } = parseLegacyBackup(raw)
  assert.equal(stats.items, 2)
  assert.equal(stats.groups, 1)
  assert.equal(stats.stickers, 1)

  const folder = spaces[0].folders[0]
  assert.equal(folder.collapsed, true)
  const group = folder.items.find((i) => i.type === 'group')
  assert.equal(group.title, 'Grouped')
  assert.equal(group.collapsed, true)
  assert.deepEqual(group.groupItems[0].tags, ['x'])     // {text} tag objects normalised

  const sticker = spaces[0].widgets[0]
  assert.equal(sticker.text, 'sticky')
  assert.equal(sticker.fontSize, 24)
  assert.equal(sticker.strikethrough, true)
  assert.equal(sticker.x, 5)
  assert.equal(sticker.y, 6)
})

test('HTML export nests groups as sub-folders', () => {
  const { state, folderId } = seed()
  const a = findFolder(state, folderId).folder.items[0].id
  mutations.createGroup(state, { folderId, itemIds: [a], title: 'Inner group' })

  const html = toBookmarksHtml(state)
  assert.ok(html.includes('<H3>Inner group</H3>'))
  assert.ok(html.includes('https://example.com'))
})

test('imported bookmarks keep the favicon URL the backup carried', () => {
  const raw = {
    version: 3,
    spaces: [{
      title: 'S',
      position: 'a',
      folders: [{
        title: 'F',
        position: 'a',
        items: [
          { type: 'bookmark', title: 'With', url: 'https://a.test', favIconUrl: 'https://a.test/fav.ico', position: 'a' },
          { type: 'bookmark', title: 'Without', url: 'https://b.test', position: 'b' },
        ],
      }],
    }],
  }

  const { spaces } = parseLegacyBackup(raw)
  const [withIcon, without] = spaces[0].folders[0].items

  assert.equal(withIcon.favicon, 'https://a.test/fav.ico', 'favIconUrl must survive the import')
  assert.equal(without.favicon, '', 'a missing icon becomes empty, and the UI falls back to a tile')
})
