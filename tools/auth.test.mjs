// Signing out must never touch the account, and signing in must always bring
// the account's board back. This is the path that previously lost data: sign
// out, delete things locally, sign back in — and the empty local board won.
import test from 'node:test'
import assert from 'node:assert/strict'

const memory = new Map()
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
}

const localArea = new Map()
globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://test${p}`, getManifest: () => ({}), id: 'test' },
  storage: {
    local: {
      get: async (keys) => {
        if (keys == null) return Object.fromEntries(localArea)
        return Object.fromEntries([].concat(keys).filter((k) => localArea.has(k)).map((k) => [k, localArea.get(k)]))
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) localArea.set(k, v) },
      remove: async (keys) => { for (const k of [].concat(keys)) localArea.delete(k) },
    },
    sync: { get: async () => ({}), set: async () => {}, remove: async () => {}, clear: async () => {} },
    onChanged: { addListener() {}, removeListener() {} },
  },
}
globalThis.fetch = async () => { throw new Error('no network in tests') }

const { SupabaseSync } = await import('../src/lib/supabase-sync.js')
const { emptyState, mutations } = await import('../src/lib/model.js')

function board(title) {
  const state = emptyState()
  const spaceId = state.spaces[0].id
  const folderId = mutations.addFolder(state, { spaceId, title })
  mutations.addItem(state, { folderId, item: { title: 'A', url: 'https://a.test' } })
  return state
}

/** A SupabaseSync with its two network calls replaced by an in-memory row. */
function harness({ local, remote, remoteRev = 7 }) {
  const applied = []
  const writes = []
  const row = { value: remote ? { rev: remoteRev, device: 'other-device', state: remote } : null }

  let current = local
  const cloud = new SupabaseSync({
    getState: () => current,
    applyRemote: (s) => { applied.push(s); current = s },
  })
  cloud.enabled = true
  cloud.session = { access_token: 'x', refresh_token: 'y', expires_at: Date.now() + 3_600_000 }
  cloud.email = 'me@example.org'
  cloud._fetchRow = async () => row.value
  cloud._rest = async (_p, init) => { writes.push(JSON.parse(init.body)); return { json: async () => ({}) } }
  cloud._startPolling = () => {}

  return { cloud, applied, writes, row, currentState: () => current }
}

test('signing out never writes to the account', async () => {
  const { cloud, writes } = harness({ local: board('Work'), remote: board('Work') })

  await cloud.signOut()

  assert.equal(writes.length, 0, 'sign-out must not push anything')
  assert.equal(cloud.enabled, false)
  assert.equal(cloud.status, 'signed-out')
})

test('signing out resets the revision clock', async () => {
  const { cloud } = harness({ local: board('Work'), remote: board('Work') })
  cloud.rev = 42
  localStorage.setItem('cloudRev', '42')

  await cloud.signOut()

  assert.equal(cloud.rev, 0)
  assert.equal(localStorage.getItem('cloudRev'), null,
    'a stale high revision is what let a later local edit overwrite the account')
})

test('a signed-out device cannot push, however it is edited', async () => {
  const { cloud, writes } = harness({ local: board('Work'), remote: board('Work') })
  await cloud.signOut()

  await cloud.push()
  await cloud.push({ force: true })

  assert.equal(writes.length, 0)
})

test('signing back in restores the account board over an emptied device', async () => {
  // The exact sequence that lost data: sign out, wipe locally, sign back in.
  const remote = board('Everything I had')
  const { cloud, applied, writes, currentState } = harness({ local: emptyState(), remote })

  const result = await cloud._reconcile()

  assert.equal(result.adopted, true, 'the account board must be adopted')
  assert.equal(applied.length, 1)
  assert.equal(currentState().spaces[0].folders[0].title, 'Everything I had')
  assert.equal(writes.length, 0, 'nothing should be pushed over the account')
})

test('signing in wins even when the device claims a higher revision', async () => {
  const { cloud, applied, currentState } = harness({
    local: board('Local junk'), remote: board('Account board'), remoteRev: 2,
  })
  cloud.rev = 99                                     // stale, but higher

  await cloud._reconcile()

  assert.equal(applied.length, 1, 'sign-in is not a revision comparison')
  assert.equal(currentState().spaces[0].folders[0].title, 'Account board')
  assert.equal(cloud.rev, 2, 'the clock follows the account')
})

test('what was on the device is kept as a backup before being replaced', async () => {
  localArea.delete('localBackup')
  const { cloud } = harness({ local: board('Device board'), remote: board('Account board') })

  await cloud._reconcile()

  const backup = localArea.get('localBackup')
  assert.ok(backup, 'a snapshot must be kept')
  assert.equal(backup.reason, 'sign-in')
  assert.equal(backup.state.spaces[0].folders[0].title, 'Device board')
})

test('an empty device board is not worth snapshotting', async () => {
  localArea.delete('localBackup')
  const { cloud } = harness({ local: emptyState(), remote: board('Account board') })

  await cloud._reconcile()

  assert.equal(localArea.get('localBackup'), undefined)
})

test('a brand-new account is seeded from the device instead', async () => {
  const { cloud, writes, applied } = harness({ local: board('My board'), remote: null })

  const result = await cloud._reconcile()

  assert.equal(result.remoteHadData, false)
  assert.equal(result.adopted, false)
  assert.equal(applied.length, 0, 'nothing to adopt')
  assert.equal(writes.length, 1, 'the device board seeds the new account')
  assert.equal(writes[0].state.spaces[0].folders[0].title, 'My board')
})
