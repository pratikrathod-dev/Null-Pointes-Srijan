// Tests for the rule that matters most in a sync system: a blank board must
// never be able to overwrite a remote that has content. That is the shape of
// every "I signed in on a new laptop and lost everything" bug.
//
// The network layer is stubbed — these check the decision logic, not Supabase.
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
      get: async (keys) => Object.fromEntries(
        [].concat(keys).filter((k) => localArea.has(k)).map((k) => [k, localArea.get(k)]),
      ),
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) localArea.set(k, v) },
      remove: async (keys) => { for (const k of [].concat(keys)) localArea.delete(k) },
    },
    sync: { get: async () => ({}), set: async () => {}, remove: async () => {}, clear: async () => {} },
    onChanged: { addListener() {}, removeListener() {} },
  },
}

const { SupabaseSync } = await import('../src/lib/supabase-sync.js')
const { emptyState, mutations } = await import('../src/lib/model.js')
const { isEffectivelyEmpty } = await import('../src/lib/supabase-sync.js')

function populated(title = 'Work') {
  const state = emptyState()
  const spaceId = state.spaces[0].id
  const folderId = mutations.addFolder(state, { spaceId, title })
  mutations.addItem(state, { folderId, item: { title: 'A', url: 'https://a.test' } })
  return state
}

/** A SupabaseSync whose two network calls are replaced by an in-memory row. */
function harness({ localState, remoteState, remoteRev = 5, remoteDevice = 'other-device' }) {
  const applied = []
  const writes = []

  const cloud = new SupabaseSync({
    getState: () => localState,
    applyRemote: (s) => applied.push(s),
  })
  cloud.enabled = true
  cloud.session = { access_token: 'x', refresh_token: 'y', expires_at: Date.now() + 3_600_000 }

  const row = remoteState ? { rev: remoteRev, device: remoteDevice, state: remoteState } : null
  cloud._fetchRow = async () => row
  cloud._rest = async (_path, init) => {
    writes.push(JSON.parse(init.body))
    return { json: async () => ({}) }
  }
  cloud._startPolling = () => {}

  return { cloud, applied, writes }
}

test('an empty local board cannot overwrite a remote that has folders', async () => {
  const { cloud, writes } = harness({ localState: emptyState(), remoteState: populated() })

  await cloud.push()

  assert.equal(writes.length, 0, 'the write must be refused')
  assert.equal(cloud.status, 'error')
  assert.match(cloud.lastError, /Refused to overwrite/)
})

test('a populated local board pushes normally', async () => {
  const { cloud, writes } = harness({ localState: populated(), remoteState: populated() })

  await cloud.push()

  assert.equal(writes.length, 1)
  assert.equal(cloud.status, 'idle')
  assert.ok(writes[0].state.spaces[0].folders.length)
  assert.ok(writes[0].rev > 0, 'the revision is stamped on the way out')
  assert.ok(writes[0].device, 'so the writing device can be recognised later')
})

test('an empty board may seed an empty remote', async () => {
  const { cloud, writes } = harness({ localState: emptyState(), remoteState: null })

  await cloud.push()

  assert.equal(writes.length, 1, 'nothing to protect, so the write goes through')
  assert.equal(cloud.status, 'idle')
})

test('force overrides the guard', async () => {
  const { cloud, writes } = harness({ localState: emptyState(), remoteState: populated() })

  await cloud.push({ force: true })

  assert.equal(writes.length, 1)
})

test('a newer board from another device is adopted', async () => {
  const { cloud, applied } = harness({ localState: emptyState(), remoteState: populated('Restored'), remoteRev: 9 })
  cloud.rev = 0

  const adopted = await cloud.pullIfNewer()

  assert.equal(adopted, true)
  assert.equal(applied.length, 1)
  assert.equal(applied[0].spaces[0].folders[0].title, 'Restored')
  assert.equal(cloud.rev, 9)
})

test('this device ignores the echo of its own upload', async () => {
  const { cloud, applied } = harness({ localState: populated(), remoteState: populated(), remoteRev: 9 })
  cloud.rev = 0
  cloud._fetchRow = async () => ({ rev: 9, device: cloud.device, state: populated() })

  const adopted = await cloud.pullIfNewer()

  assert.equal(adopted, false)
  assert.equal(applied.length, 0)
  assert.equal(cloud.rev, 9, 'but the revision counter still moves forward')
})

test('an older remote never clobbers newer local work', async () => {
  const { cloud, applied } = harness({ localState: populated(), remoteState: populated(), remoteRev: 2 })
  cloud.rev = 7

  const adopted = await cloud.pullIfNewer()

  assert.equal(adopted, false)
  assert.equal(applied.length, 0)
})

test('signing out clears the stored session', async () => {
  const { cloud } = harness({ localState: populated(), remoteState: null })
  await chrome.storage.local.set({ cloudSession: { refresh_token: 'r' }, cloudEmail: 'a@b.c' })

  await cloud.signOut()

  const left = await chrome.storage.local.get(['cloudSession', 'cloudEmail'])
  assert.equal(left.cloudSession, undefined)
  assert.equal(left.cloudEmail, undefined)
  assert.equal(cloud.enabled, false)
  assert.equal(cloud.status, 'signed-out')
})

test('a malformed email is rejected before any request is made', async () => {
  const { cloud } = harness({ localState: populated(), remoteState: null })
  await assert.rejects(() => cloud.signIn('not-an-email', 'whatever12'), /email address/)
  await assert.rejects(() => cloud.signUp('also-not-an-email', 'whatever12'), /email address/)
})

test('a too-short password is rejected before any request is made', async () => {
  const { cloud } = harness({ localState: populated(), remoteState: null })
  await assert.rejects(() => cloud.signUp('someone@example.org', 'short'), /8 characters/)
})

test('signing in with no password is rejected', async () => {
  const { cloud } = harness({ localState: populated(), remoteState: null })
  await assert.rejects(() => cloud.signIn('someone@example.org', ''), /password/i)
})

// Spaces are content. A board can be meaningfully set up -- several spaces, all
// named -- before a single folder exists, and that work has to reach the
// account like any other.

/** A board with named spaces but nothing inside them. */
function spacesOnly() {
  const state = emptyState()
  mutations.renameSpace(state, { spaceId: state.spaces[0].id, title: 'Work' })
  mutations.addSpace(state, { title: 'Personal' })
  return state
}

test('a freshly initialised board still counts as empty', () => {
  assert.equal(isEffectivelyEmpty(emptyState()), true)
  assert.equal(isEffectivelyEmpty({ spaces: [] }), true)
  assert.equal(isEffectivelyEmpty(null), true)
})

test('naming a space makes the board no longer empty', () => {
  const state = emptyState()
  mutations.renameSpace(state, { spaceId: state.spaces[0].id, title: 'Work' })
  assert.equal(isEffectivelyEmpty(state), false, 'a named space is work worth syncing')
})

test('a second space makes the board no longer empty', () => {
  const state = emptyState()
  mutations.addSpace(state, { title: 'Personal' })
  assert.equal(isEffectivelyEmpty(state), false)
})

test('spaces and their names are pushed even with no folders yet', async () => {
  const { cloud, writes } = harness({ localState: spacesOnly(), remoteState: null })

  await cloud.push()
  assert.equal(writes.length, 1, 'the board was uploaded')
  assert.deepEqual(writes[0].state.spaces.map((s) => s.title), ['Work', 'Personal'],
    'both space names reached the account')
})

test('a spaces-only board is not blocked by a remote that has folders', async () => {
  const { cloud, writes } = harness({ localState: spacesOnly(), remoteState: populated() })

  await cloud.push()
  assert.equal(writes.length, 1,
    'renaming spaces must not be refused as an "empty board overwrite"')
  assert.deepEqual(writes[0].state.spaces.map((s) => s.title), ['Work', 'Personal'])
})

test('a genuinely blank board is still refused against a populated remote', async () => {
  const { cloud, writes } = harness({ localState: emptyState(), remoteState: populated() })

  await cloud.push()
  assert.equal(writes.length, 0, 'the original guard still holds')
})

test('a blank board is refused against a remote holding only space names', async () => {
  const { cloud, writes } = harness({ localState: emptyState(), remoteState: spacesOnly() })

  await cloud.push()
  assert.equal(writes.length, 0, 'space names on the account are protected too')
})

test('signing in does not adopt an account whose board is blank', async () => {
  const local = populated('Reading')
  const { cloud, applied, writes } = harness({ localState: local, remoteState: emptyState() })

  const result = await cloud._reconcile()
  assert.equal(result.remoteHadData, false, 'a default board is not "data"')
  assert.equal(applied.length, 0, 'the local board was not replaced by an empty one')
  assert.equal(writes.length, 1, 'the local board seeded the account instead')
})

test('signing in still adopts an account that holds only space names', async () => {
  const { cloud, applied } = harness({ localState: emptyState(), remoteState: spacesOnly() })

  const result = await cloud._reconcile()
  assert.equal(result.remoteHadData, true)
  assert.deepEqual(applied[0].spaces.map((s) => s.title), ['Work', 'Personal'],
    'the space names on the account came down')
})

test('space names survive the chrome.storage.sync encoding', async () => {
  const { encodeState, decodeState } = await import('../src/lib/sync.js')
  const back = decodeState(encodeState(spacesOnly()))

  assert.deepEqual(back.spaces.map((s) => s.title), ['Work', 'Personal'])
  assert.deepEqual(back.spaces.map((s) => s.position), [1000, 2000], 'and their order')
})
