// Temporary Memory: stores lightweight browsing context in chrome.storage.local.
//
// This is deliberately separate from the board state (`state` key). Temporary
// entries track browsing activity — visit counts, time spent, importance — and
// are auto-cleaned after 7 days. Nothing here touches the Store or model.

import { TEMP_MEMORY_KEY, TEMP_TTL_MS, TEMP_MAX_ENTRIES, normUrl, domainOf } from './types.js'

/**
 * Manages temporary browsing context.
 *
 * All data lives under the `tabspace.tempMemory` key in chrome.storage.local,
 * completely isolated from the board state.
 */
export class TemporaryMemory {
  constructor() {
    /** @type {Map<string, TempEntry>} keyed by normalised URL */
    this.entries = new Map()
    this._dirty = false
    this._flushTimer = null
  }

  async init() {
    try {
      const got = await chrome.storage.local.get(TEMP_MEMORY_KEY)
      const raw = got?.[TEMP_MEMORY_KEY]
      if (raw && typeof raw === 'object') {
        for (const [key, entry] of Object.entries(raw)) {
          this.entries.set(key, entry)
        }
      }
    } catch { /* first run or storage error */ }
    this._prune()
  }

  /**
   * Record a tab event from the observer.
   * @param {string} event  'created' | 'updated' | 'activated' | 'removed'
   * @param {object} meta   Tab metadata from the observer
   */
  record(event, meta) {
    if (!meta?.url || meta.url.startsWith('chrome://') || meta.url.startsWith('chrome-extension://')) return

    const key = normUrl(meta.url)
    const now = Date.now()

    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        url: meta.url,
        title: meta.title || meta.url,
        domain: domainOf(meta.url),
        favIconUrl: meta.favIconUrl || '',
        firstSeen: now,
        lastActive: now,
        activeDuration: 0,
        visitCount: 0,
        activatedAt: 0,
        importance: 'low',
      }
      this.entries.set(key, entry)
    }

    // Always update title/favicon from the latest event
    if (meta.title) entry.title = meta.title
    if (meta.favIconUrl) entry.favIconUrl = meta.favIconUrl

    switch (event) {
      case 'created':
      case 'updated':
        entry.lastActive = now
        entry.visitCount += 1
        break

      case 'activated':
        // Close out any previous active session
        if (entry.activatedAt > 0) {
          entry.activeDuration += (now - entry.activatedAt)
        }
        entry.activatedAt = now
        entry.lastActive = now
        entry.visitCount += 1
        break

      case 'removed':
        // Finalise active duration
        if (entry.activatedAt > 0) {
          entry.activeDuration += (now - entry.activatedAt)
          entry.activatedAt = 0
        }
        break
    }

    this._scheduleSave()
  }

  /** Get the temporary entry for a URL, or null. */
  get(url) {
    return this.entries.get(normUrl(url)) ?? null
  }

  /** All entries, most recently active first. */
  all() {
    return [...this.entries.values()].sort((a, b) => b.lastActive - a.lastActive)
  }

  /** Search temporary entries by query tokens (for semantic search integration). */
  search(tokens) {
    if (!tokens.length) return []
    const scored = []
    for (const entry of this.entries.values()) {
      const text = `${entry.title} ${entry.domain}`.toLowerCase()
      let hits = 0
      for (const token of tokens) {
        if (text.includes(token)) hits += 1
      }
      if (hits > 0) {
        scored.push({ entry, score: hits / tokens.length })
      }
    }
    return scored.sort((a, b) => b.score - a.score)
  }

  /** Mark a URL as explicitly saved (bumps importance). */
  markSaved(url) {
    const entry = this.entries.get(normUrl(url))
    if (entry) {
      entry.saved = true
      this._scheduleSave()
    }
  }

  // --------------------------------------------------------- private ---

  _prune() {
    const now = Date.now()
    // Remove expired entries
    for (const [key, entry] of this.entries) {
      if (now - entry.lastActive > TEMP_TTL_MS) {
        this.entries.delete(key)
      }
    }
    // Cap at max entries, removing oldest
    if (this.entries.size > TEMP_MAX_ENTRIES) {
      const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive)
      const excess = sorted.length - TEMP_MAX_ENTRIES
      for (let i = 0; i < excess; i++) {
        this.entries.delete(sorted[i][0])
      }
    }
    this._dirty = true
  }

  _scheduleSave() {
    this._dirty = true
    if (this._flushTimer) return
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null
      this._flush()
    }, 1000)
  }

  async _flush() {
    if (!this._dirty) return
    this._dirty = false
    // Finalise any active sessions before saving
    const now = Date.now()
    for (const entry of this.entries.values()) {
      if (entry.activatedAt > 0) {
        entry.activeDuration += (now - entry.activatedAt)
        entry.activatedAt = now
      }
    }
    const obj = Object.fromEntries(this.entries)
    try {
      await chrome.storage.local.set({ [TEMP_MEMORY_KEY]: obj })
    } catch { /* quota or storage error — silently skip */ }
  }

  /** Force a flush (e.g. before page unload). */
  async flushNow() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    await this._flush()
  }
}

/**
 * @typedef {Object} TempEntry
 * @property {string} url
 * @property {string} title
 * @property {string} domain
 * @property {string} favIconUrl
 * @property {number} firstSeen
 * @property {number} lastActive
 * @property {number} activeDuration  ms spent active
 * @property {number} visitCount
 * @property {number} activatedAt     timestamp of last activation (0 if not active)
 * @property {string} importance      'low' | 'medium' | 'high'
 * @property {boolean} [saved]        true if user explicitly saved this
 */
