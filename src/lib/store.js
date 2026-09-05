// The single source of truth for a page.
//
// The local copy in chrome.storage.local is always complete and authoritative.
// Sync is a mirror on top of it, never a gate in front of it — if sync is off,
// broken or over quota, every edit still works.

import { debounce } from './util.js'
import { emptyState, mutations, safeColor, STATE_VERSION, STICKER_COLORS, FOLDER_COLORS } from './model.js'
import { SyncEngine } from './sync.js'
import { SupabaseSync } from './supabase-sync.js'

const LOCAL_KEY = 'state'
const UNDO_LIMIT = 50

export class Store extends EventTarget {
  constructor() {
    super()
    this.state = emptyState()
    this.undoStack = []
    this.redoStack = []
    this.ready = false

    this.persist = debounce(() => this._writeLocal(), 300)

    const backendArgs = {
      getState: () => (this.ready ? this.state : null),
      applyRemote: (remote) => this._applyRemote(remote),
    }

    // Two backends, running together. chrome.storage.sync is instant and needs
    // no account, but it is small and never leaves Chrome. Supabase is the real
    // one: sign in with an email and the board follows you into any browser on
    // any machine. Each carries its own revision counter.
    this.sync = new SyncEngine(backendArgs)
    this.cloud = new SupabaseSync(backendArgs)
    for (const backend of [this.sync, this.cloud]) {
      backend.addEventListener('status', () => this._emit('sync'))
    }
  }

  async init({ poll = true } = {}) {
    const stored = await chrome.storage.local.get(LOCAL_KEY)
    if (stored[LOCAL_KEY]) {
      this.state = migrate(stored[LOCAL_KEY])
    } else {
      // Nothing local: adopt whatever another device already synced.
      const remote = await this.sync.pull()
      this.state = remote?.state ? migrate(remote.state) : emptyState()
      await this._writeLocal()
    }

    this.ready = true
    this.sync.setEnabled(this.state.settings.syncEnabled !== false)
    this._emit('change')

    // Cross-tab: another page of this extension changed the local copy.
    // storage.onChanged fires asynchronously, so an "am I mid-write?" flag would
    // already have been cleared by the time our own echo arrives. Compare the
    // payload instead — that identifies our own write reliably.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[LOCAL_KEY]) return
      const incoming = JSON.stringify(changes[LOCAL_KEY].newValue ?? null)
      if (incoming === this._lastWritten) return
      this._lastWritten = incoming
      this.state = migrate(changes[LOCAL_KEY].newValue)
      this._emit('change')
    })

    if (this.sync.enabled) this.sync.pullIfNewer()
    // A short-lived page (the popup) connects so it can push, but does not poll.
    this.cloud.resume({ poll }).catch(() => {})
  }

  // ------------------------------------------------------------ mutating ---

  /** Apply a named mutation. Returns whatever the mutation returned. */
  dispatch(name, payload = {}, { undoable = true } = {}) {
    const fn = mutations[name]
    if (!fn) throw new Error(`Unknown mutation: ${name}`)

    const snapshot = clone(this.state)
    const next = clone(this.state)
    const result = fn(next, payload)

    this.state = next
    if (undoable) {
      this.undoStack.push(snapshot)
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift()
      this.redoStack.length = 0
    }

    this.persist()
    this._schedulePush()
    this._emit('change')
    return result
  }

  undo() {
    const previous = this.undoStack.pop()
    if (!previous) return false
    this.redoStack.push(clone(this.state))
    this.state = previous
    this.persist()
    this._schedulePush()
    this._emit('change')
    return true
  }

  redo() {
    const next = this.redoStack.pop()
    if (!next) return false
    this.undoStack.push(clone(this.state))
    this.state = next
    this.persist()
    this._schedulePush()
    this._emit('change')
    return true
  }

  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }

  // --------------------------------------------------------------- sync ---

  setSyncEnabled(enabled) {
    this.dispatch('updateSettings', { patch: { syncEnabled: enabled } })
    this.sync.setEnabled(enabled)
    if (enabled) this.sync.push()
  }

  /** Fan a change out to whichever backends are live. */
  _schedulePush() {
    this.sync.schedulePush()
    if (this.cloud.enabled) this.cloud.schedulePush()
  }


  /** Create an account and start syncing. */
  async signUpToCloud(email, password) {
    const result = await this.cloud.signUp(email, password)
    this._emit('sync')
    return result
  }

  /** Sign in to an existing account and pull the board down. */
  async signInToCloud(email, password) {
    const result = await this.cloud.signIn(email, password)
    this._emit('sync')
    return result
  }

  /**
   * Sign out. The board stays on this device untouched, and a snapshot is kept
   * so it can be recovered even if a later sign-in replaces it.
   */
  async signOutOfCloud() {
    await chrome.storage.local.set({
      localBackup: { savedAt: new Date().toISOString(), reason: 'sign-out', state: this.state },
    })
    await this.cloud.signOut()
    this._emit('sync')
  }

  /** The snapshot taken before the board was last replaced, if there is one. */
  async readLocalBackup() {
    const stored = await chrome.storage.local.get('localBackup')
    return stored.localBackup ?? null
  }

  /** Put a snapshot back, and push it up if signed in. */
  async restoreLocalBackup() {
    const backup = await this.readLocalBackup()
    if (!backup?.state) return false
    this.dispatch('replaceState', { next: backup.state })
    return true
  }

  async discardLocalBackup() {
    await chrome.storage.local.remove('localBackup')
  }

  /** Push immediately, e.g. before the page unloads. Fire-and-forget. */
  flush() {
    this.persist.flush()
    this.sync.schedulePush.flush()
    if (this.cloud.enabled) this.cloud.schedulePush.flush()
  }

  /** Same, but awaitable — use before closing a popup so nothing is lost. */
  async flushNow() {
    this.persist.flush?.()
    await this._writeLocal()
    this.sync.schedulePush.flush()
    if (this.cloud.enabled) this.cloud.schedulePush.flush()
  }

  /** Stop timers and listeners — called when a page goes away. */
  dispose() {
    this.sync.dispose?.()
    this.cloud.dispose?.()
    this.persist.cancel?.()
  }

  _applyRemote(remoteState) {
    // Remote wins wholesale (last-write-wins), but keep device-local preferences
    // that have no business travelling between machines.
    const localOnly = { syncEnabled: this.state.settings.syncEnabled }
    this.state = migrate({ ...remoteState, settings: { ...remoteState.settings, ...localOnly } })
    this.undoStack.length = 0
    this.redoStack.length = 0
    this._writeLocal()
    this._emit('change')
    this._emit('remote-applied')
  }

  // -------------------------------------------------------------- private ---

  async _writeLocal() {
    this._lastWritten = JSON.stringify(this.state)
    await chrome.storage.local.set({ [LOCAL_KEY]: this.state })
  }

  _emit(type) {
    this.dispatchEvent(new CustomEvent(type, { detail: this.state }))
  }
}

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
}

/** Bring an older stored shape up to the current one. */
function migrate(state) {
  const next = clone(state ?? {})
  next.version ??= STATE_VERSION
  next.spaces ??= []
  next.settings = { ...emptyState().settings, ...(next.settings ?? {}) }

  // Font names changed; anything not offered any more falls back to the default.
  if (!['inter', 'manrope', 'system'].includes(next.settings.fontFamily)) {
    next.settings.fontFamily = 'inter'
  }

  for (const space of next.spaces) {
    space.folders ??= []
    space.widgets ??= []                       // v1 boards had no sticker canvas

    // Every route into the board funnels through here -- local storage, a sync
    // pull, a restored backup -- so this is the one place worth checking that
    // colours are really colours. See safeColor: a stored value ends up in a
    // CSS custom property, which would accept a url() and fetch it on render.
    for (const sticker of space.widgets) {
      sticker.color = safeColor(sticker.color, STICKER_COLORS[0])
    }

    for (const folder of space.folders) {
      folder.color = safeColor(folder.color, FOLDER_COLORS[0])
      folder.items ??= []
      folder.collapsed ??= false
      folder.tags ??= []                       // folders gained tags after v2
      for (const item of folder.items) {
        item.type ??= 'bookmark'
        if (item.type === 'group') {
          item.groupItems ??= []
          item.collapsed ??= false
          for (const child of item.groupItems) {
            child.type ??= 'bookmark'
            child.tags ??= []
          }
        } else {
          item.tags ??= []
        }
      }
    }
  }

  if (!next.spaces.length) return emptyState()
  const ids = new Set(next.spaces.map((s) => s.id))
  if (!ids.has(next.settings.currentSpaceId)) {
    next.settings.currentSpaceId = next.spaces[0].id
  }
  next.version = STATE_VERSION
  return next
}
