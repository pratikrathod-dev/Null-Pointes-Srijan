// The data model and every mutation that can be applied to it.
//
// Shape:
//   State   { version, spaces: [Space], settings: Settings }
//   Space   { id, title, position, folders: [Folder], widgets: [Sticker] }
//   Folder  { id, title, color, collapsed, position, items: [Item] }
//   Item    { id, type:'bookmark'|'note'|'group', ... }
//   Group   { id, type:'group', title, collapsed, position, groupItems: [Item] }
//   Sticker { id, text, color, fontSize, strikethrough, x, y }
//
// Groups nest exactly one level deep — a group holds bookmarks, never another
// group. Stickers live on the space, not in a folder, so they can sit anywhere
// on the board background.
//
// There are deliberately no count limits anywhere in this file. Spaces, folders,
// bookmarks, groups, stickers and tags are all unbounded; the only ceiling in
// the project is the cross-device sync quota, which is reported honestly in the
// UI (see sync.js) and never blocks a local edit.

import { uid, nextPosition, bySortPosition } from './util.js'

export const STATE_VERSION = 2

// Material 3 tonal containers. Every one carries dark text legibly, because
// these fill a whole folder header rather than sitting in a small swatch.
// Two rows of ten: a full hue wheel, then muted and pastel variants.
export const FOLDER_COLORS = [
  // vivid containers
  '#D3E3FD', '#C2E7FF', '#C4EED0', '#D7E3B4', '#FDE293',
  '#FEDAD1', '#F9D8E4', '#E9DDFF', '#D9D3F5', '#D4E4E1',
  // deeper containers
  '#A8C7FA', '#7FCFFF', '#8FDCA4', '#BBD08A', '#FBC02D',
  '#F8AFA0', '#F2A9C6', '#CBB6FF', '#B6ABEB', '#A6C8C2',
  // neutrals
  '#DDE3EA', '#C4C7C5', '#E8DEF8', '#F2E2D5', '#E0E4D6',
]

export const STICKER_COLORS = [
  // classic paper tones
  '#FFF7B2', '#FFE08A', '#FFD0A6', '#FFC4C4', '#FFC7DE',
  '#E4C8FF', '#C9D4FF', '#B8E6FF', '#B5EFD0', '#DCEDB0',
  // deeper
  '#FFE066', '#FFC24D', '#FFAE7A', '#FF9E9E', '#FFA3C7',
  '#CFA6FF', '#A9BCFF', '#8FD7FF', '#86DFB4', '#C7E389',
  // neutral
  '#F1F3F4', '#DDE3EA',
]

export const STICKER_SIZES = [14, 18, 24, 32]

// Only literal hex colours are allowed to reach CSS.
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * A colour that is safe to hand to CSS.
 *
 * Folder and sticker colours travel inside backup files, and a backup is not
 * necessarily one this user made. Both colours end up in a style declaration --
 * one of them in a custom property, which accepts any token at all -- so a
 * value like `url(https://example.com/pixel)` would turn a restored board into
 * a beacon the moment it rendered. Anything that is not a plain hex colour is
 * replaced by the default for that surface rather than passed through.
 */
export function safeColor(value, fallback) {
  const clean = typeof value === 'string' ? value.trim() : ''
  return HEX_COLOR.test(clean) ? clean : fallback
}

export function defaultSettings() {
  return {
    theme: 'auto',
    currentSpaceId: null,
    openInNewTab: false,
    sidebarCollapsed: false,
    hidePinnedTabs: false,
    hideTagbar: false,
    fontFamily: 'inter',
    onlineFavicons: true,
    syncEnabled: true,
  }
}

// The title a freshly initialised board's single space carries. Sync compares
// against it to tell "nothing has happened yet" from "the user named a space".
export const DEFAULT_SPACE_TITLE = 'My Space'

export function emptyState() {
  const space = makeSpace(DEFAULT_SPACE_TITLE)
  return {
    version: STATE_VERSION,
    spaces: [space],
    settings: { ...defaultSettings(), currentSpaceId: space.id },
  }
}

export function makeSpace(title = 'New space', position = 1000) {
  return { id: uid(), title, position, folders: [], widgets: [] }
}

export function makeFolder(title = 'New folder', position = 1000) {
  return {
    id: uid(),
    title,
    color: FOLDER_COLORS[Math.floor(Math.random() * FOLDER_COLORS.length)],
    collapsed: false,
    position,
    tags: [],
    items: [],
  }
}

export function makeBookmark({ title, url, favicon = '', tags = [] }, position = 1000) {
  return { id: uid(), type: 'bookmark', title: title || url, url, favicon, tags, position }
}

export function makeNote(text = '', position = 1000) {
  return { id: uid(), type: 'note', title: text, url: '', favicon: '', tags: [], position }
}

export function makeGroup(title = 'New group', position = 1000) {
  return { id: uid(), type: 'group', title, collapsed: false, position, groupItems: [] }
}

export function makeSticker({ text = '', color, fontSize, x = 40, y = 40 } = {}) {
  return {
    id: uid(),
    text,
    color: safeColor(color, STICKER_COLORS[0]),
    fontSize: fontSize ?? STICKER_SIZES[1],
    strikethrough: false,
    x,
    y,
  }
}

export function isGroup(item) {
  return Boolean(item) && item.type === 'group' && Array.isArray(item.groupItems)
}

// ---------------------------------------------------------------- lookups ---

export function findSpace(state, spaceId) {
  return state.spaces.find((s) => s.id === spaceId) ?? null
}

export function currentSpace(state) {
  return findSpace(state, state.settings.currentSpaceId) ?? state.spaces[0] ?? null
}

export function findFolder(state, folderId) {
  for (const space of state.spaces) {
    const folder = space.folders.find((f) => f.id === folderId)
    if (folder) return { space, folder }
  }
  return null
}

/**
 * Locate an item wherever it lives — directly in a folder, or inside a group.
 * Returns the array that actually holds it, which is what mutations need.
 */
export function findContainer(state, itemId) {
  for (const space of state.spaces) {
    for (const folder of space.folders) {
      const index = folder.items.findIndex((i) => i.id === itemId)
      if (index !== -1) {
        return { space, folder, group: null, container: folder.items, item: folder.items[index], index }
      }
      for (const item of folder.items) {
        if (!isGroup(item)) continue
        const gi = item.groupItems.findIndex((i) => i.id === itemId)
        if (gi !== -1) {
          return { space, folder, group: item, container: item.groupItems, item: item.groupItems[gi], index: gi }
        }
      }
    }
  }
  return null
}

export function findItem(state, itemId) {
  const hit = findContainer(state, itemId)
  return hit ? { space: hit.space, folder: hit.folder, group: hit.group, item: hit.item } : null
}

export function findGroup(state, groupId) {
  for (const space of state.spaces) {
    for (const folder of space.folders) {
      const group = folder.items.find((i) => isGroup(i) && i.id === groupId)
      if (group) return { space, folder, group }
    }
  }
  return null
}

export function findSticker(state, stickerId) {
  for (const space of state.spaces) {
    const sticker = (space.widgets ?? []).find((w) => w.id === stickerId)
    if (sticker) return { space, sticker }
  }
  return null
}

/** Every bookmark and note in the state, groups walked through. */
export function* eachItem(state) {
  for (const space of state.spaces) {
    for (const folder of space.folders) {
      for (const item of folder.items) {
        if (isGroup(item)) {
          for (const child of item.groupItems) yield { space, folder, group: item, item: child }
        } else {
          yield { space, folder, group: null, item }
        }
      }
    }
  }
}

export function allTags(state) {
  const counts = new Map()
  for (const { item } of eachItem(state)) {
    for (const tag of item.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  for (const space of state.spaces) {
    for (const folder of space.folders) {
      for (const tag of folder.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

export function countItems(state) {
  let n = 0
  for (const _ of eachItem(state)) n += 1
  return n
}

/** Where a new item should go: into a group if one was named, else the folder. */
function containerFor(state, { folderId, groupId }) {
  if (groupId) {
    const hit = findGroup(state, groupId)
    if (hit) return { container: hit.group.groupItems, folder: hit.folder }
  }
  const hit = findFolder(state, folderId)
  return hit ? { container: hit.folder.items, folder: hit.folder } : null
}

// -------------------------------------------------------------- mutations ---

export const mutations = {
  addSpace(state, { title }) {
    const space = makeSpace(title || 'New space', nextPosition(state.spaces))
    state.spaces.push(space)
    state.settings.currentSpaceId = space.id
    return space.id
  },

  renameSpace(state, { spaceId, title }) {
    const space = findSpace(state, spaceId)
    if (space) space.title = title
  },

  deleteSpace(state, { spaceId }) {
    const i = state.spaces.findIndex((s) => s.id === spaceId)
    if (i === -1) return
    state.spaces.splice(i, 1)
    if (state.spaces.length === 0) state.spaces.push(makeSpace(DEFAULT_SPACE_TITLE))
    if (state.settings.currentSpaceId === spaceId) {
      state.settings.currentSpaceId = state.spaces[0].id
    }
  },

  duplicateSpace(state, { spaceId }) {
    const space = findSpace(state, spaceId)
    if (!space) return
    const copy = JSON.parse(JSON.stringify(space))
    copy.id = uid()
    copy.title = `${space.title} copy`
    copy.position = nextPosition(state.spaces)
    reidSpace(copy)
    state.spaces.push(copy)
    return copy.id
  },

  selectSpace(state, { spaceId }) {
    if (findSpace(state, spaceId)) state.settings.currentSpaceId = spaceId
  },

  moveSpace(state, { spaceId, position }) {
    const space = findSpace(state, spaceId)
    if (space) space.position = position
  },

  addFolder(state, { spaceId, title }) {
    const space = findSpace(state, spaceId) ?? currentSpace(state)
    if (!space) return
    const folder = makeFolder(title || 'New folder', nextPosition(space.folders))
    space.folders.push(folder)
    return folder.id
  },

  renameFolder(state, { folderId, title }) {
    const hit = findFolder(state, folderId)
    if (hit) hit.folder.title = title
  },

  setFolderColor(state, { folderId, color }) {
    const hit = findFolder(state, folderId)
    if (hit) hit.folder.color = safeColor(color, hit.folder.color)
  },

  addFolderTag(state, { folderId, tag }) {
    const clean = String(tag).trim()
    if (!clean) return
    const hit = findFolder(state, folderId)
    if (!hit) return
    hit.folder.tags ??= []
    if (!hit.folder.tags.includes(clean)) hit.folder.tags.push(clean)
  },

  removeFolderTag(state, { folderId, tag }) {
    const hit = findFolder(state, folderId)
    if (!hit?.folder.tags) return
    hit.folder.tags = hit.folder.tags.filter((t) => t !== tag)
  },

  toggleFolderCollapsed(state, { folderId, collapsed }) {
    const hit = findFolder(state, folderId)
    if (!hit) return
    hit.folder.collapsed = collapsed ?? !hit.folder.collapsed
  },

  setAllFoldersCollapsed(state, { spaceId, collapsed }) {
    const space = findSpace(state, spaceId) ?? currentSpace(state)
    if (!space) return
    for (const folder of space.folders) {
      folder.collapsed = collapsed
      for (const item of folder.items) if (isGroup(item)) item.collapsed = collapsed
    }
  },

  deleteFolder(state, { folderId }) {
    const hit = findFolder(state, folderId)
    if (!hit) return
    hit.space.folders.splice(hit.space.folders.indexOf(hit.folder), 1)
  },

  duplicateFolder(state, { folderId }) {
    const hit = findFolder(state, folderId)
    if (!hit) return
    const copy = JSON.parse(JSON.stringify(hit.folder))
    copy.id = uid()
    copy.title = `${hit.folder.title} copy`
    copy.position = hit.folder.position + 1
    reidFolder(copy)
    hit.space.folders.push(copy)
    return copy.id
  },

  moveFolder(state, { folderId, spaceId, position }) {
    const hit = findFolder(state, folderId)
    if (!hit) return
    hit.folder.position = position
    if (spaceId && spaceId !== hit.space.id) {
      const target = findSpace(state, spaceId)
      if (target) {
        hit.space.folders.splice(hit.space.folders.indexOf(hit.folder), 1)
        target.folders.push(hit.folder)
      }
    }
  },

  addItem(state, { folderId, groupId, item, position }) {
    const target = containerFor(state, { folderId, groupId })
    if (!target) return
    const pos = position ?? nextPosition(target.container)
    const created = item.type === 'note' ? makeNote(item.title, pos) : makeBookmark(item, pos)
    target.container.push(created)
    return created.id
  },

  updateItem(state, { itemId, patch }) {
    const hit = findContainer(state, itemId)
    if (hit) Object.assign(hit.item, patch)
  },

  deleteItem(state, { itemId }) {
    const hit = findContainer(state, itemId)
    if (!hit) return
    hit.container.splice(hit.index, 1)
  },

  moveItem(state, { itemId, folderId, groupId, position }) {
    const hit = findContainer(state, itemId)
    if (!hit) return
    if (isGroup(hit.item) && groupId) return          // groups never nest
    const target = containerFor(state, { folderId, groupId })
    if (!target) return
    hit.container.splice(hit.index, 1)
    hit.item.position = position ?? nextPosition(target.container)
    target.container.push(hit.item)
  },

  // ------------------------------------------------------------- groups ---

  /** Turn loose bookmarks into a group, in place, keeping their order. */
  createGroup(state, { folderId, itemIds = [], title = 'New group' }) {
    const hit = findFolder(state, folderId)
    if (!hit) return
    const chosen = hit.folder.items.filter((i) => itemIds.includes(i.id) && !isGroup(i))
    const anchor = chosen.length
      ? Math.min(...chosen.map((i) => i.position ?? 0))
      : nextPosition(hit.folder.items)

    const group = makeGroup(title, anchor)
    let pos = 1000
    for (const item of chosen) {
      hit.folder.items.splice(hit.folder.items.indexOf(item), 1)
      item.position = pos
      pos += 1000
      group.groupItems.push(item)
    }
    hit.folder.items.push(group)
    return group.id
  },

  renameGroup(state, { groupId, title }) {
    const hit = findGroup(state, groupId)
    if (hit) hit.group.title = title
  },

  toggleGroupCollapsed(state, { groupId, collapsed }) {
    const hit = findGroup(state, groupId)
    if (!hit) return
    hit.group.collapsed = collapsed ?? !hit.group.collapsed
  },

  /** Dissolve a group, leaving its bookmarks in the folder where it stood. */
  ungroup(state, { groupId }) {
    const hit = findGroup(state, groupId)
    if (!hit) return
    const at = hit.folder.items.indexOf(hit.group)
    const base = hit.group.position ?? 0
    const freed = hit.group.groupItems.map((item, i) => ({ ...item, position: base + i }))
    hit.folder.items.splice(at, 1, ...freed)
  },

  deleteGroup(state, { groupId }) {
    const hit = findGroup(state, groupId)
    if (!hit) return
    hit.folder.items.splice(hit.folder.items.indexOf(hit.group), 1)
  },

  // ----------------------------------------------------------- stickers ---

  addSticker(state, { spaceId, sticker }) {
    const space = findSpace(state, spaceId) ?? currentSpace(state)
    if (!space) return
    space.widgets ??= []
    const created = makeSticker(sticker)
    space.widgets.push(created)
    return created.id
  },

  updateSticker(state, { stickerId, patch }) {
    const hit = findSticker(state, stickerId)
    if (hit) Object.assign(hit.sticker, patch)
  },

  moveSticker(state, { stickerId, x, y }) {
    const hit = findSticker(state, stickerId)
    if (!hit) return
    hit.sticker.x = Math.max(0, Math.round(x))
    hit.sticker.y = Math.max(0, Math.round(y))
  },

  deleteSticker(state, { stickerId }) {
    const hit = findSticker(state, stickerId)
    if (!hit) return
    hit.space.widgets.splice(hit.space.widgets.indexOf(hit.sticker), 1)
  },

  // --------------------------------------------------------------- tags ---

  addTag(state, { itemId, tag }) {
    const clean = String(tag).trim()
    if (!clean) return
    const hit = findContainer(state, itemId)
    if (!hit) return
    hit.item.tags ??= []
    if (!hit.item.tags.includes(clean)) hit.item.tags.push(clean)
  },

  removeTag(state, { itemId, tag }) {
    const hit = findContainer(state, itemId)
    if (!hit?.item.tags) return
    hit.item.tags = hit.item.tags.filter((t) => t !== tag)
  },

  renameTagEverywhere(state, { from, to }) {
    const clean = String(to).trim()
    if (!clean) return
    const swap = (tags) => [...new Set(tags.map((t) => (t === from ? clean : t)))]

    for (const { item } of eachItem(state)) {
      if (item.tags?.includes(from)) item.tags = swap(item.tags)
    }
    for (const space of state.spaces) {
      for (const folder of space.folders) {
        if (folder.tags?.includes(from)) folder.tags = swap(folder.tags)
      }
    }
  },

  deleteTagEverywhere(state, { tag }) {
    for (const { item } of eachItem(state)) {
      if (item.tags?.length) item.tags = item.tags.filter((t) => t !== tag)
    }
    for (const space of state.spaces) {
      for (const folder of space.folders) {
        if (folder.tags?.length) folder.tags = folder.tags.filter((t) => t !== tag)
      }
    }
  },

  // ----------------------------------------------------------- upkeep ---

  updateSettings(state, { patch }) {
    Object.assign(state.settings, patch)
  },

  replaceState(state, { next }) {
    state.version = STATE_VERSION
    state.spaces = (next.spaces ?? []).map((s) => ({ ...s, widgets: s.widgets ?? [] }))
    state.settings = { ...defaultSettings(), ...(next.settings ?? {}) }
    if (!state.spaces.length) state.spaces.push(makeSpace(DEFAULT_SPACE_TITLE))
    if (!findSpace(state, state.settings.currentSpaceId)) {
      state.settings.currentSpaceId = state.spaces[0].id
    }
  },

  mergeSpaces(state, { spaces }) {
    for (const space of spaces) state.spaces.push({ ...space, widgets: space.widgets ?? [] })
  },

  removeDuplicateBookmarks(state, { spaceId }) {
    const space = findSpace(state, spaceId) ?? currentSpace(state)
    if (!space) return 0
    const seen = new Set()
    let removed = 0

    const sift = (list) => list.filter((item) => {
      if (isGroup(item)) {
        item.groupItems = sift(item.groupItems)
        return true
      }
      if (item.type !== 'bookmark') return true
      const key = (item.url || '').replace(/\/+$/, '')
      if (seen.has(key)) { removed += 1; return false }
      seen.add(key)
      return true
    })

    for (const folder of space.folders) folder.items = sift(folder.items)
    return removed
  },

  /**
   * Clear stored favicon URLs so every bookmark re-resolves from scratch.
   *
   * A stored URL is the most common cause of a missing icon: sites like Notion,
   * Grok and v0 serve their icon from a build-hashed path that 404s after their
   * next deploy. Dropping it lets the resolution chain find a live one instead.
   */
  repairFavicons(state, { spaceId }) {
    const space = findSpace(state, spaceId) ?? currentSpace(state)
    if (!space) return 0
    let repaired = 0
    for (const { space: owner, item } of eachItem(state)) {
      if (owner !== space || item.type !== 'bookmark' || !item.favicon) continue
      item.favicon = ''
      repaired += 1
    }
    return repaired
  },
}

/** Give a duplicated subtree fresh ids so nothing collides. */
function reidFolder(folder) {
  folder.items = folder.items.map((item) => {
    if (isGroup(item)) {
      return { ...item, id: uid(), groupItems: item.groupItems.map((c) => ({ ...c, id: uid() })) }
    }
    return { ...item, id: uid() }
  })
  return folder
}

function reidSpace(space) {
  space.folders = space.folders.map((folder) => reidFolder({ ...folder, id: uid() }))
  space.widgets = (space.widgets ?? []).map((w) => ({ ...w, id: uid() }))
  return space
}

// ------------------------------------------------------------------ import ---

/**
 * Import a JSON board export — ours, or the `{ version: 3, spaces: [...] }`
 * shape other tab managers write. Groups stay groups and sticker widgets
 * are carried across, so an import is never lossy.
 */
export function parseLegacyBackup(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json
  if (!data || !Array.isArray(data.spaces)) {
    throw new Error('Not a recognised backup: no "spaces" array.')
  }

  // Some exports order with lexicographic fractional-index strings; sorting
  // by them preserves the arrangement before we renumber.
  const byPos = (a, b) => String(a.position ?? '').localeCompare(String(b.position ?? ''))

  const spaces = data.spaces.map((rawSpace, si) => {
    const space = makeSpace(rawSpace.title || 'Imported space', (si + 1) * 1000)

    space.folders = [...(rawSpace.folders ?? [])].sort(byPos).map((rawFolder, fi) => {
      const folder = makeFolder(rawFolder.title?.trim() || 'Imported folder', (fi + 1) * 1000)
      folder.tags = normaliseTags(rawFolder.tags)
      folder.color = safeColor(rawFolder.color, folder.color)
      folder.collapsed = Boolean(rawFolder.collapsed)
      folder.items = [...(rawFolder.items ?? [])]
        .sort(byPos)
        .flatMap((rawItem, ii) => importItem(rawItem, (ii + 1) * 1000))
      return folder
    })

    space.widgets = [...(rawSpace.widgets ?? [])].map((raw) => makeSticker({
      text: raw.content?.text ?? raw.text ?? '',
      color: raw.content?.color ?? raw.color,
      fontSize: raw.content?.fontSize ?? raw.fontSize,
      x: raw.positionX ?? raw.pos?.point?.x ?? 40,
      y: raw.positionY ?? raw.pos?.point?.y ?? 40,
    }))
    for (const [i, w] of space.widgets.entries()) {
      const raw = rawSpace.widgets[i]
      w.strikethrough = Boolean(raw?.content?.strikethrough ?? raw?.strikethrough)
    }

    return space
  })

  return { spaces, stats: importStats(spaces) }
}

function importStats(spaces) {
  let folders = 0
  let items = 0
  let groups = 0
  let stickers = 0
  for (const space of spaces) {
    folders += space.folders.length
    stickers += (space.widgets ?? []).length
    for (const folder of space.folders) {
      for (const item of folder.items) {
        if (isGroup(item)) { groups += 1; items += item.groupItems.length } else items += 1
      }
    }
  }
  return { spaces: spaces.length, folders, items, groups, stickers }
}

function importItem(raw, position) {
  if (raw.type === 'group' && Array.isArray(raw.groupItems)) {
    const group = makeGroup(raw.title?.trim() || 'Group', position)
    group.collapsed = Boolean(raw.collapsed)
    group.groupItems = raw.groupItems.map((child, i) => importOneItem(child, (i + 1) * 1000))
    return [group]
  }
  if (raw.type === 'bookmark' || raw.url) return [importOneItem(raw, position)]
  if (raw.type === 'sticker' || raw.type === 'note') {
    return [makeNote(raw.title || raw.text || '', position)]
  }
  return []
}

function importOneItem(raw, position) {
  return makeBookmark({
    title: raw.title || raw.url || 'Untitled',
    url: raw.url || '',
    favicon: raw.favIconUrl || raw.favicon || '',
    tags: normaliseTags(raw.tags),
  }, position)
}

function normaliseTags(tags) {
  if (!Array.isArray(tags)) return []
  return [...new Set(
    tags
      .map((t) => (typeof t === 'string' ? t : t?.text ?? ''))
      .map((t) => t.trim())
      .filter(Boolean),
  )]
}

export function parseBrowserBookmarks(tree, spaceTitle = 'Chrome bookmarks') {
  const space = makeSpace(spaceTitle, 1000)
  let position = 1000

  const walk = (nodes, path) => {
    const direct = nodes.filter((n) => n.url)
    if (direct.length) {
      const folder = makeFolder(path || 'Bookmarks', position)
      position += 1000
      folder.items = direct.map((n, i) => makeBookmark({
        title: n.title || n.url,
        url: n.url,
      }, (i + 1) * 1000))
      space.folders.push(folder)
    }
    for (const node of nodes.filter((n) => n.children)) {
      walk(node.children, node.title ? `${path ? `${path} / ` : ''}${node.title}` : path)
    }
  }

  walk(tree, '')
  return { spaces: [space], stats: importStats([space]) }
}

// ------------------------------------------------------------------ export ---

export function toBackupJson(state) {
  return JSON.stringify({
    isTabspace: true,
    version: STATE_VERSION,
    exportedAt: new Date().toISOString(),
    spaces: state.spaces,
    settings: state.settings,
  }, null, 2)
}

export function toBookmarksHtml(state) {
  const rows = []
  rows.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>')
  rows.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">')
  rows.push('<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>')

  const link = (item, indent) => {
    if (item.type !== 'bookmark') return
    const tags = item.tags?.length ? ` TAGS="${escapeHtml(item.tags.join(','))}"` : ''
    rows.push(`${indent}<DT><A HREF="${escapeHtml(item.url)}"${tags}>${escapeHtml(item.title)}</A>`)
  }

  for (const space of [...state.spaces].sort(bySortPosition)) {
    rows.push(`  <DT><H3>${escapeHtml(space.title)}</H3>`, '  <DL><p>')
    for (const folder of [...space.folders].sort(bySortPosition)) {
      rows.push(`    <DT><H3>${escapeHtml(folder.title)}</H3>`, '    <DL><p>')
      for (const item of [...folder.items].sort(bySortPosition)) {
        if (isGroup(item)) {
          rows.push(`      <DT><H3>${escapeHtml(item.title)}</H3>`, '      <DL><p>')
          for (const child of [...item.groupItems].sort(bySortPosition)) link(child, '        ')
          rows.push('      </DL><p>')
        } else {
          link(item, '      ')
        }
      }
      rows.push('    </DL><p>')
    }
    rows.push('  </DL><p>')
  }
  rows.push('</DL><p>')
  return rows.join('\n')
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ))
}
