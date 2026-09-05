// Sync through Supabase: sign in with an email address and a password, and the
// board follows you into any browser on any machine.
//
// Why this one:
//   - The user does nothing but type an email and a password. No token to
//     generate, no developer console, no Google account.
//   - Works in Chrome, Edge, Firefox — it is plain HTTPS, not a browser feature.
//   - Private: row-level security on the table means an account can only ever
//     read and write its own row, enforced by the database rather than by us.
//   - Free: the anon key is meant to be public, and the free tier covers far
//     more than a personal board.
//
// There is no SDK here on purpose — this project has no build step, so the
// REST and auth endpoints are called directly with fetch.
//
// Conflict handling matches the other backends: last-write-wins on a revision
// counter, with the writing device stamped so a device ignores its own echo,
// plus a refusal to let an empty board overwrite a remote that has content.

import { deviceId, debounce } from './util.js'
import { DEFAULT_SPACE_TITLE } from './model.js'
import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from './supabase-config.js'

const TABLE = 'boards'
const PUSH_DEBOUNCE_MS = 4000
const POLL_MS = 45_000

export { isConfigured }

export const CloudStatus = {
  UNCONFIGURED: 'unconfigured',
  SIGNED_OUT: 'signed-out',
  IDLE: 'idle',
  PUSHING: 'pushing',
  PULLING: 'pulling',
  ERROR: 'error',
}

/**
 * A board still indistinguishable from a freshly initialised one -- nothing
 * worth overwriting a remote with, and nothing worth adopting over a local
 * board either.
 *
 * Spaces count as content. Naming a space, or making a second one, is real work
 * even before a single folder exists, and the old rule here looked only at
 * folders and stickers: a board whose spaces had been set up but not yet filled
 * read as empty, so its push was refused and those space names never reached
 * the account. Only a board that still looks exactly like `emptyState()` --
 * one space, default title, nothing in it -- is treated as nothing.
 */
export function isEffectivelyEmpty(state) {
  const spaces = state?.spaces ?? []
  if (spaces.some((space) => space.folders?.length || space.widgets?.length)) return false
  if (spaces.length > 1) return false
  return spaces.every((space) => !space.title || space.title === DEFAULT_SPACE_TITLE)
}

export class SupabaseSync extends EventTarget {
  constructor({ getState, applyRemote }) {
    super()
    this.getState = getState
    this.applyRemote = applyRemote
    this.device = deviceId()
    this.rev = Number(localStorage.getItem('cloudRev') ?? 0)

    this.session = null          // { access_token, refresh_token, expires_at }
    this.email = null
    this.enabled = false
    this.status = isConfigured() ? CloudStatus.SIGNED_OUT : CloudStatus.UNCONFIGURED
    this.lastError = null
    this.lastPushedAt = Number(localStorage.getItem('cloudPushedAt') ?? 0) || null

    this.schedulePush = debounce(() => { this.push() }, PUSH_DEBOUNCE_MS)
    this._timer = null
  }

  describe() {
    return {
      status: this.status,
      error: this.lastError,
      email: this.email,
      lastPushedAt: this.lastPushedAt,
      pending: this.schedulePush.pending(),
      configured: isConfigured(),
    }
  }

  _setStatus(status, error = null) {
    this.status = status
    this.lastError = error
    this.dispatchEvent(new CustomEvent('status', { detail: this.describe() }))
  }

  // ------------------------------------------------------------------ auth ---

  /**
   * Create an account. With "Confirm email" switched off in Supabase this
   * returns a session immediately and no email is ever sent — which is the
   * point: a confirmation link cannot redirect back into an extension.
   */
  async signUp(email, password) {
    const clean = this._checkEmail(email)
    this._checkPassword(password)

    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: clean, password }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(friendlyError(body, res.status))

    if (!body.access_token) {
      throw new Error(
        'Account created, but this project still has "Confirm email" switched on, '
        + 'so it sent a confirmation link instead of signing you in. '
        + 'Turn it off in Supabase: Authentication → Sign In / Providers → Email → Confirm email.',
      )
    }

    await this._adoptSession(body)
    return this._reconcile()
  }

  /** Sign in to an existing account. */
  async signIn(email, password) {
    const clean = this._checkEmail(email)
    if (!password) throw new Error('Enter your password.')

    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: clean, password }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(friendlyError(body, res.status))

    await this._adoptSession(body)
    return this._reconcile()
  }

  _checkEmail(email) {
    const clean = String(email ?? '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new Error('That does not look like an email address.')
    return clean
  }

  _checkPassword(password) {
    if (!password || password.length < 8) throw new Error('Use a password of at least 8 characters.')
  }

  /**
   * Reconcile right after signing in.
   *
   * The account's board wins outright here, whatever the revision numbers say.
   * A device that has been signed out may hold anything — a different person's
   * board, an empty one, edits made offline — and none of that should be able
   * to overwrite what the account already has. Revision comparison is the right
   * rule for ongoing sync; it is the wrong rule for the moment you sign in.
   *
   * Whatever was on the device first is snapshotted, so nothing is ever lost
   * silently: Settings offers it back under "Restore local backup".
   */
  async _reconcile() {
    const remote = await this._fetchRow().catch(() => null)
    // `spaces.length` was the old test, and it is true even of a default board:
    // an account seeded once from a blank device would then replace a real
    // board on the next device that signed in. Ask whether the account holds
    // anything, not merely whether it holds an array.
    const remoteHadData = Boolean(remote?.state) && !isEffectivelyEmpty(remote.state)

    if (!remoteHadData) {
      // A brand-new account: seed it with whatever is on this device.
      await this.push()
      this._startPolling()
      return { email: this.email, adopted: false, remoteHadData: false }
    }

    const local = this.getState()
    if (local && !isEffectivelyEmpty(local)) {
      await chrome.storage.local.set({
        localBackup: { savedAt: new Date().toISOString(), reason: 'sign-in', state: local },
      })
    }

    this.rev = Number(remote.rev ?? 0)
    localStorage.setItem('cloudRev', String(this.rev))
    this.applyRemote(remote.state)

    this._startPolling()
    return { email: this.email, adopted: true, remoteHadData: true }
  }

  async _adoptSession(session) {
    if (!session?.access_token) throw new Error('Sign-in did not return a session.')
    this.session = {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: Date.now() + (session.expires_in ?? 3600) * 1000,
    }
    this.email = session.user?.email ?? this.email
    this.enabled = true
    await chrome.storage.local.set({ cloudSession: this.session, cloudEmail: this.email })
    this._setStatus(CloudStatus.IDLE)
  }

  async resume({ poll = true } = {}) {
    if (!isConfigured()) return false
    const stored = await chrome.storage.local.get(['cloudSession', 'cloudEmail'])
    if (!stored.cloudSession?.refresh_token) return false

    this.session = stored.cloudSession
    this.email = stored.cloudEmail ?? null
    this.enabled = true
    this._setStatus(CloudStatus.IDLE)

    try {
      await this._validToken()
    } catch (err) {
      this.enabled = false
      this._setStatus(CloudStatus.SIGNED_OUT, err.message)
      return false
    }

    await this.pullIfNewer()
    if (poll) this._startPolling()
    return true
  }

  async signOut() {
    try {
      if (this.session?.access_token) {
        await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${this.session.access_token}`,
          },
        })
      }
    } catch { /* signing out locally is what matters */ }

    this.enabled = false
    this.session = null
    this.email = null
    this._stopPolling()

    // Reset the revision clock. Leaving it high made the next sign-in look
    // newer than the account's own board, so a local edit could overwrite it —
    // which is how signing out, deleting things, and signing back in managed to
    // wipe the account. Signing out now never writes to the account at all.
    this.rev = 0
    localStorage.removeItem('cloudRev')

    await chrome.storage.local.remove(['cloudSession', 'cloudEmail'])
    this._setStatus(CloudStatus.SIGNED_OUT)
  }

  /** An access token that is definitely still valid, refreshing if needed. */
  async _validToken() {
    if (!this.session) throw new Error('Not signed in.')
    if (Date.now() < this.session.expires_at - 60_000) return this.session.access_token

    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.session.refresh_token }),
    })
    if (!res.ok) throw new Error('Session expired — please sign in again.')

    const session = await res.json()
    await this._adoptSession(session)
    return this.session.access_token
  }

  // ------------------------------------------------------------------ data ---

  async _rest(path, init = {}) {
    const token = await this._validToken()
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
    if (!res.ok) throw new Error(await readError(res))
    return res
  }

  async _fetchRow() {
    const res = await this._rest(`${TABLE}?select=rev,device,state&limit=1`)
    const rows = await res.json()
    return rows?.[0] ?? null
  }

  /** @param {{force?: boolean}} opts force skips the empty-overwrite guard. */
  async push({ force = false } = {}) {
    if (!this.enabled) return
    const state = this.getState()
    if (!state) return

    if (!force && isEffectivelyEmpty(state)) {
      const remote = await this._fetchRow().catch(() => null)
      if (remote?.state && !isEffectivelyEmpty(remote.state)) {
        this._setStatus(CloudStatus.ERROR,
          'Refused to overwrite the synced board with an empty one. Reload to pull it down first.')
        return
      }
    }

    this._setStatus(CloudStatus.PUSHING)
    this.rev += 1

    try {
      // user_id is filled in by the table's default, so one row per account.
      await this._rest(TABLE, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          rev: this.rev,
          device: this.device,
          state,
          updated_at: new Date().toISOString(),
        }),
      })
      localStorage.setItem('cloudRev', String(this.rev))
      this.lastPushedAt = Date.now()
      localStorage.setItem('cloudPushedAt', String(this.lastPushedAt))
      this._setStatus(CloudStatus.IDLE)
    } catch (err) {
      this._setStatus(CloudStatus.ERROR, err.message)
    }
  }

  async pullIfNewer() {
    if (!this.enabled) return false
    this._setStatus(CloudStatus.PULLING)
    try {
      const remote = await this._fetchRow()
      if (!remote?.state) { this._setStatus(CloudStatus.IDLE); return false }

      if (remote.rev > this.rev && remote.device !== this.device) {
        this.rev = remote.rev
        localStorage.setItem('cloudRev', String(this.rev))
        this.applyRemote(remote.state)
        this._setStatus(CloudStatus.IDLE)
        return true
      }
      if (remote.rev > this.rev) {
        this.rev = remote.rev
        localStorage.setItem('cloudRev', String(this.rev))
      }
      this._setStatus(CloudStatus.IDLE)
      return false
    } catch (err) {
      this._setStatus(CloudStatus.ERROR, err.message)
      return false
    }
  }

  _startPolling() {
    this._stopPolling()
    this._timer = setInterval(() => { this.pullIfNewer() }, POLL_MS)
  }

  _stopPolling() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }

  dispose() {
    this._stopPolling()
    this.schedulePush.cancel?.()
  }
}

/** Turn Supabase's terse auth errors into something a person can act on. */
function friendlyError(body, status) {
  const msg = body?.msg || body?.message || body?.error_description || body?.error || `HTTP ${status}`
  const lower = String(msg).toLowerCase()

  if (lower.includes('email not confirmed')) {
    return 'This account was created while "Confirm email" was on, so it is not activated. '
      + 'Turn that setting off in Supabase (Authentication → Sign In / Providers → Email), '
      + 'then sign up again with a different address — or confirm this one from the email you received.'
  }
  if (lower.includes('invalid login credentials')) return 'Wrong email or password.'
  if (lower.includes('already registered') || lower.includes('already been registered')) {
    return 'That email already has an account — use Sign in instead.'
  }
  if (lower.includes('password')) return msg
  if (lower.includes('invalid')) return msg
  return msg
}

async function readError(res) {
  try {
    const body = await res.json()
    return body.msg || body.message || body.error_description || body.error || `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}
