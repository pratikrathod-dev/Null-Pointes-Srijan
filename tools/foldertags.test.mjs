// Folder-level tags, and the settings migration that goes with this version.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  emptyState, mutations, allTags, findFolder, defaultSettings, parseLegacyBackup,
} from '../src/lib/model.js'
import { encodeState, decodeState } from '../src/lib/sync.js'

function seed() {
  const state = emptyState()
  const spaceId = state.spaces[0].id
  const folderId = mutations.addFolder(state, { spaceId, title: 'Work' })
  mutations.addItem(state, { folderId, item: { title: 'A', url: 'https://a.test' } })
  return { state, spaceId, folderId }
}

test('a folder starts with an empty tag list', () => {
  const { state, folderId } = seed()
  assert.deepEqual(findFolder(state, folderId).folder.tags, [])
})

test('folder tags add, de-duplicate and remove', () => {
  const { state, folderId } = seed()

  mutations.addFolderTag(state, { folderId, tag: 'work' })
  mutations.addFolderTag(state, { folderId, tag: 'work' })      // duplicate
  mutations.addFolderTag(state, { folderId, tag: '  ' })        // blank
  mutations.addFolderTag(state, { folderId, tag: 'urgent' })

  assert.deepEqual(findFolder(state, folderId).folder.tags, ['work', 'urgent'])

  mutations.removeFolderTag(state, { folderId, tag: 'work' })
  assert.deepEqual(findFolder(state, folderId).folder.tags, ['urgent'])
})

test('folder tags are unlimited', () => {
  const { state, folderId } = seed()
  for (let i = 0; i < 80; i += 1) mutations.addFolderTag(state, { folderId, tag: `t${i}` })
  assert.equal(findFolder(state, folderId).folder.tags.length, 80)
})

test('the tag bar counts folder tags alongside bookmark tags', () => {
  const { state, folderId } = seed()
  const itemId = findFolder(state, folderId).folder.items[0].id

  mutations.addFolderTag(state, { folderId, tag: 'shared' })
  mutations.addTag(state, { itemId, tag: 'shared' })
  mutations.addFolderTag(state, { folderId, tag: 'folder-only' })

  const counts = Object.fromEntries(allTags(state).map(({ tag, count }) => [tag, count]))
  assert.equal(counts.shared, 2, 'one folder + one bookmark')
  assert.equal(counts['folder-only'], 1)
})

test('renaming a tag reaches folders as well as bookmarks', () => {
  const { state, folderId } = seed()
  const itemId = findFolder(state, folderId).folder.items[0].id
  mutations.addFolderTag(state, { folderId, tag: 'old' })
  mutations.addTag(state, { itemId, tag: 'old' })

  mutations.renameTagEverywhere(state, { from: 'old', to: 'new' })

  assert.deepEqual(findFolder(state, folderId).folder.tags, ['new'])
  assert.deepEqual(findFolder(state, folderId).folder.items[0].tags, ['new'])
})

test('renaming into an existing folder tag merges rather than duplicating', () => {
  const { state, folderId } = seed()
  mutations.addFolderTag(state, { folderId, tag: 'old' })
  mutations.addFolderTag(state, { folderId, tag: 'new' })

  mutations.renameTagEverywhere(state, { from: 'old', to: 'new' })
  assert.deepEqual(findFolder(state, folderId).folder.tags, ['new'])
})

test('deleting a tag reaches folders as well as bookmarks', () => {
  const { state, folderId } = seed()
  const itemId = findFolder(state, folderId).folder.items[0].id
  mutations.addFolderTag(state, { folderId, tag: 'gone' })
  mutations.addTag(state, { itemId, tag: 'gone' })

  mutations.deleteTagEverywhere(state, { tag: 'gone' })

  assert.deepEqual(findFolder(state, folderId).folder.tags, [])
  assert.deepEqual(findFolder(state, folderId).folder.items[0].tags, [])
  assert.equal(allTags(state).length, 0)
})

test('folder tags survive a sync round trip', () => {
  const { state, folderId } = seed()
  mutations.addFolderTag(state, { folderId, tag: 'work' })
  mutations.addFolderTag(state, { folderId, tag: 'urgent' })

  const back = decodeState(encodeState(state))
  assert.deepEqual(findFolder(back, folderId).folder.tags, ['work', 'urgent'])
})

test('a folder with no tags costs nothing in the synced payload', () => {
  const { state } = seed()
  const encoded = JSON.stringify(encodeState(state))
  assert.ok(!encoded.includes('"g":[]'), 'empty tag arrays should not be written')
})

test('the default font is one the settings dropdown actually offers', () => {
  const OFFERED = ['inter', 'manrope', 'system']
  assert.ok(OFFERED.includes(defaultSettings().fontFamily),
    `default "${defaultSettings().fontFamily}" is not in the picker`)
})

test('imported folders get a tag list', () => {
  const raw = {
    version: 3,
    spaces: [{ title: 'S', position: 'a', folders: [{ title: 'F', position: 'a', items: [] }] }],
  }
  const { spaces } = parseLegacyBackup(raw)
  assert.deepEqual(spaces[0].folders[0].tags, [])
})
