// The remembered-accounts list: ranking, counting, migration and forgetting.
//
// The behaviour that matters here is the ranking rule -- typing a few letters
// must surface the account actually used most, not the one used last.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  readAccounts, rankAccounts, recordAccountUse, forgetAccount, forgetAllAccounts,
  describeAccount, normaliseEmail, useCount, writeAccounts,
} from '../src/lib/accounts.js'

/** A stand-in for localStorage that lives only for one test. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  }
}

test('an address is remembered the first time it is used', () => {
  const st = fakeStorage()
  recordAccountUse('Vitthal@Gmail.com', 'signin', { now: 10, storage: st })

  const all = readAccounts(st)
  assert.equal(all.length, 1)
  assert.equal(all[0].email, 'vitthal@gmail.com', 'stored folded to lower case')
  assert.equal(all[0].signIns, 1)
  assert.equal(all[0].signUps, 0)
})

test('the most-used account outranks the most-recent one', () => {
  const st = fakeStorage()
  // "often" is used three times, early. "recent" is used once, last.
  for (const now of [1, 2, 3]) recordAccountUse('often@example.com', 'signin', { now, storage: st })
  recordAccountUse('recent@example.com', 'signin', { now: 99, storage: st })

  const [first] = readAccounts(st)
  assert.equal(first.email, 'often@example.com',
    'recency alone must not put a rarely-used account first')
})

test('recency breaks a tie between equally-used accounts', () => {
  const st = fakeStorage()
  recordAccountUse('older@example.com', 'signin', { now: 10, storage: st })
  recordAccountUse('newer@example.com', 'signin', { now: 20, storage: st })

  assert.deepEqual(readAccounts(st).map((r) => r.email),
    ['newer@example.com', 'older@example.com'])
})

test('signing up counts towards the ranking just as signing in does', () => {
  const st = fakeStorage()
  recordAccountUse('registered@example.com', 'signup', { now: 1, storage: st })
  recordAccountUse('registered@example.com', 'signin', { now: 2, storage: st })

  const [rec] = readAccounts(st)
  assert.equal(rec.signUps, 1)
  assert.equal(rec.signIns, 1)
  assert.equal(useCount(rec), 2)
})

test('typing the start of a name finds the account behind it', () => {
  const st = fakeStorage()
  for (const now of [1, 2, 3]) recordAccountUse('vitthal@gmail.com', 'signin', { now, storage: st })
  recordAccountUse('someone@vit.edu', 'signin', { now: 4, storage: st })
  recordAccountUse('unrelated@example.com', 'signin', { now: 5, storage: st })

  const hits = rankAccounts(readAccounts(st), 'vit').map((r) => r.email)
  assert.deepEqual(hits, ['vitthal@gmail.com', 'someone@vit.edu'],
    'the local part is matched before the domain, and the busier account leads')
})

test('a match on the domain still counts, just lower', () => {
  const st = fakeStorage()
  recordAccountUse('me@vit.edu', 'signin', { now: 1, storage: st })
  assert.deepEqual(rankAccounts(readAccounts(st), 'vit').map((r) => r.email), ['me@vit.edu'])
})

test('a match anywhere in the address is offered as a last resort', () => {
  const st = fakeStorage()
  recordAccountUse('advitya@example.com', 'signin', { now: 1, storage: st })
  assert.deepEqual(rankAccounts(readAccounts(st), 'vit').map((r) => r.email), ['advitya@example.com'])
})

test('an address that is already typed in full is not suggested back', () => {
  const st = fakeStorage()
  recordAccountUse('vitthal@gmail.com', 'signin', { now: 1, storage: st })
  assert.deepEqual(rankAccounts(readAccounts(st), 'vitthal@gmail.com'), [],
    'there is nothing left to complete')
})

test('an empty field offers every remembered account, best first', () => {
  const st = fakeStorage()
  for (const now of [1, 2]) recordAccountUse('busy@example.com', 'signin', { now, storage: st })
  recordAccountUse('quiet@example.com', 'signin', { now: 3, storage: st })

  assert.deepEqual(rankAccounts(readAccounts(st), '').map((r) => r.email),
    ['busy@example.com', 'quiet@example.com'])
})

test('a query that matches nothing offers nothing', () => {
  const st = fakeStorage()
  recordAccountUse('vitthal@gmail.com', 'signin', { now: 1, storage: st })
  assert.deepEqual(rankAccounts(readAccounts(st), 'zzz'), [])
})

test('suggestions are capped so the list cannot cover the dialog', () => {
  const st = fakeStorage()
  for (let i = 0; i < 8; i += 1) recordAccountUse(`user${i}@example.com`, 'signin', { now: i, storage: st })
  assert.equal(rankAccounts(readAccounts(st), 'user').length, 5)
  assert.equal(rankAccounts(readAccounts(st), 'user', 2).length, 2)
})

test('the history is bounded, dropping the least-used first', () => {
  const st = fakeStorage()
  // One heavily-used account, then more than the cap of lightly-used ones.
  for (const now of [1, 2, 3, 4, 5]) recordAccountUse('anchor@example.com', 'signin', { now, storage: st })
  for (let i = 0; i < 12; i += 1) recordAccountUse(`filler${i}@example.com`, 'signin', { now: 10 + i, storage: st })

  const all = readAccounts(st)
  assert.equal(all.length, 8, 'the stored history is capped')
  assert.equal(all[0].email, 'anchor@example.com', 'the most-used account survives the cap')
})

test('the v1 knownEmails list is migrated instead of discarded', () => {
  const st = fakeStorage({
    knownEmails: JSON.stringify(['first@example.com', 'second@example.com']),
  })

  const all = readAccounts(st)
  assert.deepEqual(all.map((r) => r.email), ['first@example.com', 'second@example.com'],
    'the old newest-first order is preserved')
  assert.ok(all.every((r) => useCount(r) === 1), 'each migrated address starts with one use')
})

test('migration runs once, then the old key is dropped', () => {
  const st = fakeStorage({ knownEmails: JSON.stringify(['first@example.com']) })
  recordAccountUse('first@example.com', 'signin', { now: 50, storage: st })

  assert.equal(st.getItem('knownEmails'), null, 'the dead v1 key is cleaned up')
  assert.equal(readAccounts(st)[0].signIns, 2, 'the migrated use and the new one both count')
})

test('an account can be forgotten', () => {
  const st = fakeStorage()
  recordAccountUse('keep@example.com', 'signin', { now: 1, storage: st })
  recordAccountUse('drop@example.com', 'signin', { now: 2, storage: st })

  forgetAccount('drop@example.com', st)
  assert.deepEqual(readAccounts(st).map((r) => r.email), ['keep@example.com'])
})

test('forgetting everything leaves nothing behind', () => {
  const st = fakeStorage({ knownEmails: JSON.stringify(['legacy@example.com']) })
  recordAccountUse('a@example.com', 'signin', { now: 1, storage: st })

  forgetAllAccounts(st)
  assert.deepEqual(readAccounts(st), [], 'and the legacy key cannot resurrect the list')
})

test('a corrupt history reads as empty rather than throwing', () => {
  assert.deepEqual(readAccounts(fakeStorage({ accountHistory: 'not json{' })), [])
  assert.deepEqual(readAccounts(fakeStorage({ accountHistory: '{"not":"an array"}' })), [])
  assert.deepEqual(readAccounts(fakeStorage({ knownEmails: 'also not json' })), [])
})

test('storage that throws on every call does not break the dialog', () => {
  const hostile = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
    removeItem() { throw new Error('denied') },
  }
  assert.deepEqual(readAccounts(hostile), [])
  assert.doesNotThrow(() => recordAccountUse('a@example.com', 'signin', { now: 1, storage: hostile }))
  assert.doesNotThrow(() => forgetAccount('a@example.com', hostile))
})

test('duplicate rows in stored history are merged, not shown twice', () => {
  const st = fakeStorage({
    accountHistory: JSON.stringify([
      { email: 'dupe@example.com', signIns: 2, signUps: 0, lastAt: 5 },
      { email: 'DUPE@example.com', signIns: 3, signUps: 1, lastAt: 9 },
    ]),
  })
  const all = readAccounts(st)
  assert.equal(all.length, 1)
  assert.equal(useCount(all[0]), 6)
  assert.equal(all[0].lastAt, 9, 'the later timestamp wins')
})

test('junk rows are skipped rather than rendered', () => {
  const st = fakeStorage({
    accountHistory: JSON.stringify([
      { email: 'good@example.com', signIns: 1, lastAt: 1 },
      { email: '' },
      { nope: true },
      null,
    ]),
  })
  assert.deepEqual(readAccounts(st).map((r) => r.email), ['good@example.com'])
})

test('a blank address is never recorded', () => {
  const st = fakeStorage()
  recordAccountUse('   ', 'signin', { now: 1, storage: st })
  recordAccountUse(null, 'signin', { now: 2, storage: st })
  assert.deepEqual(readAccounts(st), [])
})

test('the row description says how the account has been used', () => {
  assert.equal(describeAccount({ email: 'a@b.c', signIns: 0, signUps: 0 }), 'Not used yet')
  assert.equal(describeAccount({ email: 'a@b.c', signIns: 1, signUps: 0 }), 'Used once')
  assert.equal(describeAccount({ email: 'a@b.c', signIns: 4, signUps: 0 }), 'Used 4 times')
  assert.equal(describeAccount({ email: 'a@b.c', signIns: 0, signUps: 1 }), 'Account created here')
})

test('normaliseEmail trims and folds case', () => {
  assert.equal(normaliseEmail('  Me@Example.COM '), 'me@example.com')
  assert.equal(normaliseEmail(undefined), '')
})

test('writeAccounts round-trips through readAccounts', () => {
  const st = fakeStorage()
  writeAccounts([{ email: 'r@example.com', signIns: 3, signUps: 1, lastAt: 7 }], st)
  const [rec] = readAccounts(st)
  assert.equal(rec.email, 'r@example.com')
  assert.equal(useCount(rec), 4)
})

test('no password or token is ever written to the history', () => {
  const st = fakeStorage()
  recordAccountUse('a@example.com', 'signin', { now: 1, storage: st })
  const raw = st.getItem('accountHistory')
  for (const forbidden of ['password', 'access_token', 'refresh_token', 'secret']) {
    assert.ok(!raw.includes(forbidden), `history must not carry ${forbidden}`)
  }
  assert.deepEqual(Object.keys(JSON.parse(raw)[0]).sort(),
    ['email', 'lastAt', 'lastMode', 'signIns', 'signUps'])
})
