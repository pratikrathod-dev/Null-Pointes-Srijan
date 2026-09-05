// Remembered sign-in addresses, ranked by how often each one is actually used.
//
// Typing "vit" should surface the account you sign in with most -- not merely
// the one touched most recently. On a shared machine the last address used is
// often somebody else's, so recency alone puts the wrong account first. Every
// successful sign-in and sign-up therefore increments a counter against the
// address, and suggestions are ordered by that counter first, recency second.
//
// This is a cache of email addresses and counts, nothing else. No password, no
// access token and no session is ever written here -- those live in
// chrome.storage.local, written only by supabase-sync.js.

const KEY = 'accountHistory'
const LEGACY_KEY = 'knownEmails'      // v1 shape: a plain array, newest first
const LIMIT = 8

/**
 * localStorage, but never throwing. Private-mode and locked-down profiles can
 * make even reading it throw, and a suggestion list is not worth a dead dialog.
 * Tests inject a plain object instead.
 */
function storeOf(injected) {
  const backing = injected ?? globalThis.localStorage
  return {
    read(key) {
      try { return backing?.getItem(key) ?? null } catch { return null }
    },
    write(key, value) {
      try { backing?.setItem(key, value) } catch { /* nothing to do */ }
    },
    drop(key) {
      try { backing?.removeItem(key) } catch { /* nothing to do */ }
    },
  }
}

export function normaliseEmail(email) {
  return String(email ?? '').trim().toLowerCase()
}

/** Total number of times an address has been used to reach an account. */
export function useCount(record) {
  return (record?.signIns ?? 0) + (record?.signUps ?? 0)
}

/**
 * Every remembered address, best-known first.
 * Migrates the v1 `knownEmails` array on first read so nobody's history is lost.
 */
export function readAccounts(injected) {
  const store = storeOf(injected)

  let records = []
  const raw = store.read(KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) records = parsed.filter((r) => r && typeof r.email === 'string')
    } catch { records = [] }
  }

  if (!records.length) {
    const legacy = store.read(LEGACY_KEY)
    if (legacy) {
      try {
        const list = JSON.parse(legacy)
        if (Array.isArray(list)) {
          // The old list carried order but no counts. Preserve that order by
          // handing out descending timestamps, and credit one use each so a
          // returning user's ranking starts from something rather than zero.
          records = list
            .map((e) => normaliseEmail(e))
            .filter(Boolean)
            .map((email, i) => ({
              email,
              signIns: 1,
              signUps: 0,
              lastAt: list.length - i,
              lastMode: 'signin',
            }))
        }
      } catch { /* unreadable legacy value: start clean */ }
    }
  }

  return dedupe(records).sort(byRank)
}

function dedupe(records) {
  const seen = new Map()
  for (const r of records) {
    const email = normaliseEmail(r.email)
    if (!email) continue
    const prior = seen.get(email)
    if (!prior) {
      seen.set(email, {
        email,
        signIns: Number(r.signIns) || 0,
        signUps: Number(r.signUps) || 0,
        lastAt: Number(r.lastAt) || 0,
        lastMode: r.lastMode === 'signup' ? 'signup' : 'signin',
      })
      continue
    }
    prior.signIns += Number(r.signIns) || 0
    prior.signUps += Number(r.signUps) || 0
    if ((Number(r.lastAt) || 0) > prior.lastAt) {
      prior.lastAt = Number(r.lastAt) || 0
      prior.lastMode = r.lastMode === 'signup' ? 'signup' : 'signin'
    }
  }
  return [...seen.values()]
}

/** Most-used first; ties broken by most-recent, then alphabetically. */
function byRank(a, b) {
  const used = useCount(b) - useCount(a)
  if (used) return used
  const recent = (b.lastAt ?? 0) - (a.lastAt ?? 0)
  if (recent) return recent
  return a.email.localeCompare(b.email)
}

export function writeAccounts(records, injected) {
  storeOf(injected).write(KEY, JSON.stringify(dedupe(records).sort(byRank).slice(0, LIMIT)))
}

/**
 * Credit one successful use of an address.
 * @param {string} email
 * @param {'signin'|'signup'} mode
 * @param {{now?: number, storage?: object}} opts
 */
export function recordAccountUse(email, mode = 'signin', { now = Date.now(), storage } = {}) {
  const clean = normaliseEmail(email)
  if (!clean) return readAccounts(storage)

  const records = readAccounts(storage)
  const existing = records.find((r) => r.email === clean)

  if (existing) {
    if (mode === 'signup') existing.signUps += 1
    else existing.signIns += 1
    existing.lastAt = now
    existing.lastMode = mode
  } else {
    records.push({
      email: clean,
      signIns: mode === 'signup' ? 0 : 1,
      signUps: mode === 'signup' ? 1 : 0,
      lastAt: now,
      lastMode: mode,
    })
  }

  const next = dedupe(records).sort(byRank).slice(0, LIMIT)
  const store = storeOf(storage)
  store.write(KEY, JSON.stringify(next))
  // The v1 key is now dead weight; drop it so the migration cannot run twice.
  store.drop(LEGACY_KEY)
  return next
}

/** Remove one address from the history -- a shared machine needs this. */
export function forgetAccount(email, injected) {
  const clean = normaliseEmail(email)
  const next = readAccounts(injected).filter((r) => r.email !== clean)
  const store = storeOf(injected)
  store.write(KEY, JSON.stringify(next))
  store.drop(LEGACY_KEY)
  return next
}

export function forgetAllAccounts(injected) {
  const store = storeOf(injected)
  store.drop(KEY)
  store.drop(LEGACY_KEY)
  return []
}

// Match quality, best first. A query almost always names the person, so the
// part before the @ is tried before the domain -- typing "vit" should find
// vitthal@example.com long before it finds anyone at vit.edu.
const MATCH_LOCAL_PREFIX = 0
const MATCH_DOMAIN_PREFIX = 1
const MATCH_ANYWHERE = 2

function matchTier(email, query) {
  if (!query) return MATCH_LOCAL_PREFIX
  const at = email.indexOf('@')
  const local = at === -1 ? email : email.slice(0, at)
  const domain = at === -1 ? '' : email.slice(at + 1)

  if (local.startsWith(query)) return MATCH_LOCAL_PREFIX
  if (domain.startsWith(query)) return MATCH_DOMAIN_PREFIX
  if (email.includes(query)) return MATCH_ANYWHERE
  return -1
}

/**
 * The addresses worth offering for what has been typed so far, best first.
 *
 * Ordering is match quality, then how often the account is used, then recency:
 * a half-typed local part surfaces the account behind it, and among equally
 * good matches the one actually lived in comes first.
 *
 * @param {Array} records from readAccounts()
 * @param {string} query whatever is in the email field right now
 * @param {number} limit
 */
export function rankAccounts(records, query = '', limit = 5) {
  const q = normaliseEmail(query)

  return (records ?? [])
    .map((record) => ({ record, tier: matchTier(record.email, q) }))
    .filter(({ tier }) => tier !== -1)
    // An exact, complete match is not a suggestion -- there is nothing left to
    // complete, and the row would just cover the field for no reason.
    .filter(({ record }) => record.email !== q)
    .sort((a, b) => (a.tier - b.tier) || byRank(a.record, b.record))
    .slice(0, limit)
    .map(({ record }) => record)
}

/** Human wording for how an address has been used, for the suggestion row. */
export function describeAccount(record) {
  const total = useCount(record)
  if (!total) return 'Not used yet'
  if (record.signUps && !record.signIns) return 'Account created here'
  return total === 1 ? 'Used once' : `Used ${total} times`
}
