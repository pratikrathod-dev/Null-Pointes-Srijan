// Cross-device sync over chrome.storage.sync.
//
// chrome.storage.sync is free, needs no account and no server, but it is small:
//   QUOTA_BYTES          102,400   total
//   QUOTA_BYTES_PER_ITEM   8,192   per key
//   MAX_ITEMS                512   keys
//   writes                 1,800 / hour, 120 / minute
//
// So this module does three things:
//   1. Encodes the state compactly (short keys, favicons dropped — Chrome can
//      regenerate those locally) to fit far more bookmarks into the quota.
//   2. Splits the payload across numbered chunk keys and writes them as one
//      atomic-ish set, behind a debounce that keeps us well under the write rate.
//   3. Reports remaining quota honestly. Running out never blocks an edit — the
//      local copy is always authoritative and complete; sync simply reports
//      "paused, over quota" until the board is smaller.
//
// Conflict resolution is last-write-wins on a logical revision counter, with the
// writing device stamped so a device ignores the echo of its own push.

import { deviceId, debounce, byteLength } from './util.js'
import { defaultSettings } from './model.js'

const META_KEY = 'm'
const CHUNK_PREFIX = 'c'
const CHUNK_BYTES = 7000            // under the 8,192 per-item ceiling, with headroom
export const SYNC_QUOTA_BYTES = 102400
const PUSH_DEBOUNCE_MS = 4000

export const SyncStatus = {
  IDLE: 'idle',
  PUSHING: 'pushing',
  PULLING: 'pulling',
  OVER_QUOTA: 'over-quota',
  DISABLED: 'disabled',
  ERROR: 'error',
}

// ------------------------------------------------------- compact encoding ---

// Type tag: absent = bookmark, 1 = note, 2 = group.
function encodeItem(item) {
  const out = { i: item.id, t: item.title, p: item.position }
  if (item.type === 'group') {
    out.y = 2
    if (item.collapsed) out.k = 1
    out.m = (item.groupItems ?? []).map(encodeItem)
    return out
  }
  if (item.type === 'note') out.y = 1
  if (item.url) out.u = item.url
  if (item.tags?.length) out.g = item.tags
  return out
}

function decodeItem(raw) {
  if (raw.y === 2) {
    return {
      id: raw.i,
      type: 'group',
      title: raw.t ?? '',
      collapsed: raw.k === 1,
      position: raw.p ?? 0,
      groupItems: (raw.m ?? []).map(decodeItem),
    }
  }
  return {
    id: raw.i,
    type: raw.y === 1 ? 'note' : 'bookmark',
    title: raw.t ?? '',
    url: raw.u ?? '',
    favicon: '',                     // regenerated locally, never synced
    tags: raw.g ?? [],
    position: raw.p ?? 0,
  }
}

function encodeSticker(s) {
  const out = { i: s.id, t: s.text, c: s.color, z: s.fontSize, a: s.x, b: s.y }
  if (s.strikethrough) out.k = 1
  return out
}

function decodeSticker(raw) {
  return {
    id: raw.i,
    text: raw.t ?? '',
    color: raw.c ?? '#fff8c5',
    fontSize: raw.z ?? 18,
    strikethrough: raw.k === 1,
    x: raw.a ?? 40,
    y: raw.b ?? 40,
  }
}

function encodeFolder(folder) {
  const out = {
    i: folder.id,
    t: folder.title,
    p: folder.position,
    m: folder.items.map(encodeItem),
  }
  if (folder.color) out.c = folder.color
  if (folder.collapsed) out.k = 1
  if (folder.tags?.length) out.g = folder.tags
  return out
}

function decodeFolder(raw) {
  return {
    id: raw.i,
    title: raw.t ?? '',
    color: raw.c ?? '#cfd8dc',
    collapsed: raw.k === 1,
    position: raw.p ?? 0,
    tags: raw.g ?? [],
    items: (raw.m ?? []).map(decodeItem),
  }
}

export function encodeState(state) {
  return {
    v: state.version,
    s: state.spaces.map((space) => {
      const out = {
        i: space.id,
        t: space.title,
        p: space.position,
        f: space.folders.map(encodeFolder),
      }
      if (space.widgets?.length) out.w = space.widgets.map(encodeSticker)
      return out
    }),
    o: {
      th: state.settings.theme,
      cs: state.settings.currentSpaceId,
      nt: state.settings.openInNewTab ? 1 : 0,
      sc: state.settings.sidebarCollapsed ? 1 : 0,
      hp: state.settings.hidePinnedTabs ? 1 : 0,
    },
  }
}

export function decodeState(payload) {
  return {
    version: payload.v ?? 1,
    spaces: (payload.s ?? []).map((raw) => ({
      id: raw.i,
      title: raw.t ?? '',
      position: raw.p ?? 0,
      folders: (raw.f ?? []).map(decodeFolder),
      widgets: (raw.w ?? []).map(decodeSticker),
    })),
    settings: {
      ...defaultSettings(),
      theme: payload.o?.th ?? 'auto',
      currentSpaceId: payload.o?.cs ?? null,
      openInNewTab: payload.o?.nt === 1,
      sidebarCollapsed: payload.o?.sc === 1,
      hidePinnedTabs: payload.o?.hp === 1,
    },
  }
}

function chunk(str, size) {
  const parts = []
  for (let i = 0; i < str.length; i += size) parts.push(str.slice(i, i + size))
  return parts
}

/** Bytes this state would occupy in sync storage, including chunk key overhead. */
export function estimateSyncBytes(state) {
  const json = JSON.stringify(encodeState(state))
  const parts = chunk(json, CHUNK_BYTES)
  // Each stored item costs key + value; meta is small and near-constant.
  return byteLength(json) + parts.length * 8 + 120
}

// ------------------------------------------------------------ the engine ---

export class SyncEngine extends EventTarget {
  constructor({ getState, applyRemote }) {
    super()
    this.getState = getState
    this.applyRemote = applyRemote
    this.device = deviceId()
    this.rev = Number(localStorage.getItem('syncRev') ?? 0)
    this.enabled = true
    this.status = SyncStatus.IDLE
    this.lastError = null
    this.lastPushedAt = Number(localStorage.getItem('syncPushedAt') ?? 0) || null

    this.schedulePush = debounce(() => { this.push() }, PUSH_DEBOUNCE_MS)
    this._onChanged = this._onChanged.bind(this)
    chrome.storage.onChanged.addListener(this._onChanged)
  }

  setEnabled(enabled) {
    this.enabled = enabled
    this._setStatus(enabled ? SyncStatus.IDLE : SyncStatus.DISABLED)
  }

  _setStatus(status, error = null) {
    this.status = status
    this.lastError = error
    this.dispatchEvent(new CustomEvent('status', { detail: this.describe() }))
  }

  describe() {
    const state = this.getState()
    const used = state ? estimateSyncBytes(state) : 0
    return {
      status: this.enabled ? this.status : SyncStatus.DISABLED,
      error: this.lastError,
      usedBytes: used,
      quotaBytes: SYNC_QUOTA_BYTES,
      percent: Math.min(100, Math.round((used / SYNC_QUOTA_BYTES) * 100)),
      lastPushedAt: this.lastPushedAt,
      pending: this.schedulePush.pending(),
    }
  }

  /** Write the current state to sync storage. */
  async push() {
    if (!this.enabled) return
    const state = this.getState()
    if (!state) return

    const json = JSON.stringify(encodeState(state))
    const parts = chunk(json, CHUNK_BYTES)
    const total = byteLength(json) + parts.length * 8 + 120

    if (total > SYNC_QUOTA_BYTES) {
      this._setStatus(SyncStatus.OVER_QUOTA)
      return
    }
    if (parts.length + 1 > 500) {
      this._setStatus(SyncStatus.OVER_QUOTA)
      return
    }

    this._setStatus(SyncStatus.PUSHING)
    this.rev += 1

    const payload = { [META_KEY]: { v: this.rev, d: this.device, n: parts.length, t: Date.now() } }
    parts.forEach((part, i) => { payload[`${CHUNK_PREFIX}${i}`] = part })

    try {
      // Drop chunk keys left over from a previously larger state.
      const existing = await chrome.storage.sync.get(null)
      const stale = Object.keys(existing).filter(
        (k) => k.startsWith(CHUNK_PREFIX) && Number(k.slice(1)) >= parts.length,
      )
      if (stale.length) await chrome.storage.sync.remove(stale)

      await chrome.storage.sync.set(payload)
      localStorage.setItem('syncRev', String(this.rev))
      this.lastPushedAt = Date.now()
      localStorage.setItem('syncPushedAt', String(this.lastPushedAt))
      this._setStatus(SyncStatus.IDLE)
    } catch (err) {
      this._setStatus(SyncStatus.ERROR, err?.message ?? String(err))
    }
  }

  /** Read whatever is in sync storage; returns a decoded state or null. */
  async pull() {
    const stored = await chrome.storage.sync.get(null)
    const meta = stored[META_KEY]
    if (!meta || typeof meta.n !== 'number') return null

    const parts = []
    for (let i = 0; i < meta.n; i += 1) {
      const part = stored[`${CHUNK_PREFIX}${i}`]
      if (typeof part !== 'string') return null   // torn write; wait for the next one
      parts.push(part)
    }

    try {
      return { state: decodeState(JSON.parse(parts.join(''))), rev: meta.v, device: meta.d }
    } catch (err) {
      this._setStatus(SyncStatus.ERROR, `Could not read synced data: ${err.message}`)
      return null
    }
  }

  /** Adopt remote data if it is newer than what this device has. */
  async pullIfNewer() {
    if (!this.enabled) return false
    this._setStatus(SyncStatus.PULLING)
    const remote = await this.pull()
    if (!remote) { this._setStatus(SyncStatus.IDLE); return false }

    if (remote.rev > this.rev) {
      this.rev = remote.rev
      localStorage.setItem('syncRev', String(this.rev))
      this.applyRemote(remote.state)
      this._setStatus(SyncStatus.IDLE)
      return true
    }
    this._setStatus(SyncStatus.IDLE)
    return false
  }

  _onChanged(changes, area) {
    if (area !== 'sync' || !this.enabled) return
    const meta = changes[META_KEY]?.newValue
    if (!meta) return
    if (meta.d === this.device) return          // our own echo
    if (meta.v <= this.rev) return
    // Chunks land in the same set() call, so the payload is already complete.
    this.pullIfNewer()
  }

  /** Wipe synced data without touching this device's local copy. */
  async clearRemote() {
    await chrome.storage.sync.clear()
    this.rev = 0
    localStorage.setItem('syncRev', '0')
    this._setStatus(SyncStatus.IDLE)
  }

  dispose() {
    chrome.storage.onChanged.removeListener(this._onChanged)
  }
}
