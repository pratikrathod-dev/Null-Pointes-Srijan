// Drives the real board UI in jsdom, so runtime errors surface here instead of
// only in the browser.
// Drives the real board in a headless DOM. jsdom is not a dependency of the
// extension — install it once with:  npm install --no-save jsdom
let JSDOM
try {
  ({ JSDOM } = await import('jsdom'))
} catch {
  console.log('\n  jsdom is not installed — run:  npm install --no-save jsdom\n')
  process.exit(0)
}
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

import { fileURLToPath } from 'node:url'
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(path.join(ROOT, 'src/newtab/newtab.html'), 'utf8')

const dom = new JSDOM(html, { url: 'https://tabspace.test/src/newtab/newtab.html', pretendToBeVisual: true })
const { window } = dom

// Surface anything the page throws — that is the whole point of this harness.
const errors = []
window.addEventListener('error', (e) => errors.push(`window error: ${e.message}`))
const origError = console.error
console.error = (...a) => { errors.push(`console.error: ${a.join(' ')}`); origError(...a) }
process.on('unhandledRejection', (r) => errors.push(`unhandled rejection: ${r?.message ?? r}`))

for (const k of ['window', 'document', 'EventTarget', 'Node', 'Element', 'HTMLElement', 'Image',
                 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent',
                 'DOMParser', 'CSS', 'requestAnimationFrame', 'cancelAnimationFrame', 'Blob']) {
  try { globalThis[k] = window[k] } catch { /* read-only global, already fine */ }
}
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
window.matchMedia = globalThis.matchMedia
globalThis.localStorage = window.localStorage
globalThis.getSelection = () => ({ removeAllRanges() {}, addRange() {} })
window.getSelection = globalThis.getSelection
document.execCommand = () => true

// --- chrome stubs -----------------------------------------------------------
const localArea = new Map()
const listeners = []
globalThis.chrome = {
  runtime: {
    id: 'test',
    getURL: (p) => `chrome-extension://test${p.startsWith('/') ? '' : '/'}${p}`,
    getManifest: () => ({ version: '1.0.0' }),
    sendMessage() {},
    lastError: null,
  },
  storage: {
    local: {
      get: async (keys) => {
        if (keys === null || keys === undefined) return Object.fromEntries(localArea)
        const list = Array.isArray(keys) ? keys : [keys]
        return Object.fromEntries(list.filter((k) => localArea.has(k)).map((k) => [k, localArea.get(k)]))
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) localArea.set(k, v) },
      remove: async (keys) => { for (const k of [].concat(keys)) localArea.delete(k) },
    },
    sync: { get: async () => ({}), set: async () => {}, remove: async () => {}, clear: async () => {} },
    onChanged: { addListener: (f) => listeners.push(f), removeListener() {} },
  },
  tabs: {
    query: async () => [],
    getCurrent: async () => ({ id: 1, windowId: 1 }),
    create() {}, update() {}, remove() {}, move() {},
    onCreated: { addListener() {} }, onRemoved: { addListener() {} },
    onUpdated: { addListener() {} }, onMoved: { addListener() {} },
    onAttached: { addListener() {} }, onDetached: { addListener() {} },
    onActivated: { addListener() {} },
  },
  bookmarks: { getTree: async () => [{ children: [] }] },
}

// --- load the board ---------------------------------------------------------
await import(pathToFileURL(path.join(ROOT, 'src/newtab/newtab.js')).href)
const settle = () => new Promise((r) => setTimeout(r, 400))
await settle()

const $ = (id) => document.getElementById(id)
const results = []
const check = (label, pass, extra = '') =>
  results.push(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`)

const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const dismissAll = () => { for (const n of document.querySelectorAll('.overlay, .menu')) n.remove() }
const press = (node, key) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

console.log('\n--- boot ---')
check('board rendered', Boolean($('board')))
check('no errors during boot', errors.length === 0, errors.join(' | '))

// --- the empty board -------------------------------------------------------
// The board boots with no folders, so this is the real empty state.
console.log('')
console.log('--- empty board ---')
{
  const board = $('board')
  const empty = board.querySelector('.empty-state')
  check('an empty board shows the empty state', Boolean(empty))
  check('the empty state is the only thing on the board', board.children.length === 1,
    `${board.children.length} children: ${[...board.children].map((n) => n.className).join(', ')}`)
  check('the loose dashed "New folder" tile is not also rendered',
    !board.querySelector('.add-folder'),
    'a column item under a column-spanning block lands in the first column alone')

  check('the empty state names the situation',
    empty?.querySelector('.empty-state__title')?.textContent === 'This space is empty',
    empty?.querySelector('.empty-state__title')?.textContent ?? 'no title')
  check('it gives one line of guidance',
    Boolean(empty?.querySelector('.empty-state__body')?.textContent?.length))

  const action = empty?.querySelector('.empty-state__actions .btn--primary')
  check('the action sits inside the empty state', Boolean(action),
    action?.textContent ?? 'no button')
  check('and it is the New folder action', action?.textContent === 'New folder',
    action?.textContent ?? 'none')
}
check('no errors rendering the empty board', errors.length === 0, errors.join(' | '))

// --- create a folder and a bookmark directly through storage ---------------
const state = localArea.get('state')
const spaceId = state.spaces[0].id
state.spaces[0].folders.push({
  id: 'f1', title: 'Test folder', color: '#D3E3FD', collapsed: false, position: 1000, tags: [],
  items: [{ id: 'b1', type: 'bookmark', title: 'Example', url: 'https://example.com', favicon: '', tags: [], position: 1000 }],
})
localArea.set('state', state)
for (const f of listeners) f({ state: { newValue: state } }, 'local')
await settle()

console.log('\n--- rendering ---')
check('folder rendered', document.querySelectorAll('.folder').length === 1,
  `${document.querySelectorAll('.folder').length} folders`)
check('bookmark rendered', document.querySelectorAll('.item').length === 1,
  `${document.querySelectorAll('.item').length} items`)

// The dashed tile is right once there are folders for it to follow -- it reads
// as "add another" at the end of the masonry, not as a stray box under a hero.
check('the dashed "New folder" tile returns once folders exist',
  Boolean(document.querySelector('#board .add-folder')))
check('and the empty state is gone', !document.querySelector('#board .empty-state'))
// Nothing is tagged yet, so the strip stays out of the way entirely -- it used
// to explain where tags come from, which spent a row of the window on a feature
// the person was not using.
check('the tag bar is empty until something is tagged',
  $('tagbar').textContent.trim() === '' && $('tagbar').children.length === 0,
  `${$('tagbar').children.length} children: ${$('tagbar').textContent.trim()}`)

// --- open the bookmark's menu and click Tags -------------------------------
console.log('\n--- tags on a bookmark ---')
errors.length = 0
const itemMore = document.querySelector('.item .item__action')
check('bookmark has an options button', Boolean(itemMore))
if (itemMore) {
  click(itemMore)
  await settle()
  const menuItems = [...document.querySelectorAll('.menu__item')].map((n) => n.textContent.trim())
  check('menu opened', menuItems.length > 0, menuItems.join(', ') || 'no menu')
  const tagsEntry = [...document.querySelectorAll('.menu__item')].find((n) => n.textContent.includes('Tags'))
  check('menu has a Tags entry', Boolean(tagsEntry))

  if (tagsEntry) {
    click(tagsEntry)
    await settle()
    const dlg = document.querySelector('.dialog')
    check('tag dialog opened', Boolean(dlg), dlg ? '' : 'no .dialog in the document')

    const input = dlg?.querySelector('input.field')
    check('tag dialog has an input', Boolean(input))
    if (input) {
      input.value = 'research'
      press(input, 'Enter')
      await settle()
      const saved = localArea.get('state').spaces[0].folders[0].items[0].tags
      check('tag was saved to the item', saved.includes('research'), JSON.stringify(saved))
    }
  }
}
check('no errors while tagging', errors.length === 0, errors.join(' | '))

// --- the tag bar -----------------------------------------------------------
console.log('\n--- tag bar and filtering ---')
errors.length = 0
await settle()
const chips = [...document.querySelectorAll('#tagbar .chip')].map((n) => n.textContent.trim())
check('tag bar shows the tag', chips.some((c) => c.startsWith('research')), chips.join(', ') || 'empty')

const chip = [...document.querySelectorAll('#tagbar .chip')].find((n) => n.textContent.includes('research'))
if (chip) {
  click(chip)
  await settle()
  check('filtering keeps the matching folder', document.querySelectorAll('.folder').length === 1,
    `${document.querySelectorAll('.folder').length} folders shown`)
  click(chip)
  await settle()
}
check('no errors while filtering', errors.length === 0, errors.join(' | '))

// --- folder tags -----------------------------------------------------------
console.log('\n--- tags on a folder ---')
errors.length = 0
const folderMore = document.querySelector('.folder__head .icon-btn:last-child')
if (folderMore) {
  click(folderMore)
  await settle()
  const entry = [...document.querySelectorAll('.menu__item')].find((n) => n.textContent.trim() === 'Tags')
  check('folder menu has a Tags entry', Boolean(entry))
  if (entry) {
    click(entry)
    await settle()
    const input = document.querySelector('.dialog input.field')
    check('folder tag dialog opened', Boolean(input))
    if (input) {
      input.value = 'work'
      press(input, 'Enter')
      await settle()
      const saved = localArea.get('state').spaces[0].folders[0].tags
      check('folder tag was saved', saved.includes('work'), JSON.stringify(saved))
    }
  }
}
check('no errors on folder tags', errors.length === 0, errors.join(' | '))

// --- search by tag ---------------------------------------------------------
console.log('\n--- search ---')
errors.length = 0
const search = $('search')
search.value = 'research'
search.dispatchEvent(new window.Event('input', { bubbles: true }))
await new Promise((r) => setTimeout(r, 220))
check('searching a tag keeps the folder', document.querySelectorAll('.folder').length === 1,
  `${document.querySelectorAll('.folder').length} folders`)
search.value = ''
search.dispatchEvent(new window.Event('input', { bubbles: true }))
await new Promise((r) => setTimeout(r, 220))
check('no errors while searching', errors.length === 0, errors.join(' | '))

// --- the remaining tag surfaces --------------------------------------------
console.log('\n--- tag manager, suggestions, removal, groups ---')
errors.length = 0

click($('btn-tags'))
await settle()
const mgr = document.querySelector('.dialog')
check('topbar Tags opens the manager',
  Boolean(mgr) && mgr.textContent.includes('All tags'),
  mgr ? mgr.querySelector('.dialog__title')?.textContent : 'no dialog')

const rows = [...document.querySelectorAll('.dialog .setting__title')].map((n) => n.textContent)
check('manager lists bookmark and folder tags',
  rows.includes('research') && rows.includes('work'), rows.join(', ') || 'none')

const renameBtn = [...document.querySelectorAll('.dialog .btn')].find((b) => b.textContent === 'Rename')
check('manager has a Rename button', Boolean(renameBtn))
if (renameBtn) {
  click(renameBtn)
  await settle()
  const f = document.querySelector('.dialog input.field')
  if (f) {
    f.value = 'renamed'
    press(f, 'Enter')
    await settle()
    const st = localArea.get('state')
    const seen = [
      ...st.spaces[0].folders[0].tags,
      ...st.spaces[0].folders[0].items.flatMap((i) => i.tags ?? []),
    ]
    check('rename applied across the board', seen.includes('renamed'), JSON.stringify(seen))
  }
}
dismissAll()
await settle()

// A bookmark inside a group — findContainer has to reach into groupItems.
const st2 = localArea.get('state')
st2.spaces[0].folders[0].items = [{
  id: 'g1', type: 'group', title: 'Group', collapsed: false, position: 1000,
  groupItems: [{
    id: 'gb1', type: 'bookmark', title: 'In group', url: 'https://in.test',
    favicon: '', tags: [], position: 1000,
  }],
}]
localArea.set('state', st2)
for (const fn of listeners) fn({ state: { newValue: st2 } }, 'local')
await settle()

check('grouped bookmark rendered',
  document.querySelectorAll('.group .item').length === 1,
  String(document.querySelectorAll('.group .item').length))

const groupedMore = document.querySelector('.group .item .item__action')
if (groupedMore) {
  click(groupedMore)
  await settle()
  const entry = [...document.querySelectorAll('.menu__item')].find((n) => n.textContent.trim() === 'Tags')
  if (entry) {
    click(entry)
    await settle()
    const f2 = document.querySelector('.dialog input.field')
    if (f2) {
      f2.value = 'deep'
      press(f2, 'Enter')
      await settle()
      let saved = localArea.get('state').spaces[0].folders[0].items[0].groupItems[0].tags
      check('tag saved on a bookmark inside a group', saved.includes('deep'), JSON.stringify(saved))

      const sugg = [...document.querySelectorAll('.dialog .chip')].find((c) => c.textContent.trim() === 'work')
      check('suggestions offer existing tags', Boolean(sugg))
      if (sugg) {
        click(sugg)
        await settle()
        saved = localArea.get('state').spaces[0].folders[0].items[0].groupItems[0].tags
        check('suggestion chip adds the tag', saved.includes('work'), JSON.stringify(saved))
      }

      const applied = [...document.querySelectorAll('.dialog .chip')]
        .find((c) => c.textContent.trim().startsWith('deep'))
      if (applied) {
        click(applied)
        await settle()
        saved = localArea.get('state').spaces[0].folders[0].items[0].groupItems[0].tags
        check('clicking an applied chip removes it', !saved.includes('deep'), JSON.stringify(saved))
      }
    }
  }
}
check('no errors across tag surfaces', errors.length === 0, errors.join(' | '))
dismissAll()
// --- are the tags actually VISIBLE on the rows? ----------------------------
console.log('\n--- tag visibility ---')
errors.length = 0

// Put a tagged bookmark and a tagged folder into state directly, then render.
const st3 = localArea.get('state')
st3.spaces[0].folders = [{
  id: 'fv', title: 'Visible', color: '#D3E3FD', collapsed: false, position: 1000,
  tags: ['folder-tag'],
  items: [{
    id: 'bv', type: 'bookmark', title: 'Tagged site', url: 'https://tagged.test',
    favicon: '', tags: ['alpha', 'beta'], position: 1000,
  }],
}]
localArea.set('state', st3)
for (const fn of listeners) fn({ state: { newValue: st3 } }, 'local')
await settle()

const itemTags = [...document.querySelectorAll('.item .item__tag')].map((n) => n.textContent.trim())
check('tag chips render on the bookmark row', itemTags.length === 2, itemTags.join(', ') || 'none rendered')

const folderTags = [...document.querySelectorAll('.folder__head .folder__tag')].map((n) => n.textContent.trim())
check('tag chips render on the folder header', folderTags.length === 1, folderTags.join(', ') || 'none rendered')

const barChips = [...document.querySelectorAll('#tagbar .chip')].map((n) => n.textContent.trim())
check('the tag bar lists every tag',
  barChips.length >= 3, barChips.join(' | ') || 'bar is empty')

const bar = $('tagbar')
check('the tag bar is not hidden', bar.children.length > 0, `${bar.children.length} children`)

check('no errors rendering tags', errors.length === 0, errors.join(' | '))

// --- the sign-in dialog and its account suggestions -------------------------
// The board is signed out in this harness, so the account button opens the
// sign-in dialog. Nothing here is allowed to reach the network: fetch is
// stubbed, and the only submit exercised is one that fails.
console.log('\n--- sign in: account suggestions ---')
errors.length = 0
dismissAll()

let fetchCalls = 0
const stubFetch = async () => {
  fetchCalls += 1
  return {
    ok: false,
    status: 400,
    json: async () => ({ error_description: 'Invalid login credentials' }),
  }
}
globalThis.fetch = stubFetch
window.fetch = stubFetch

// Seed a history: "vitthal" is used most, "someone@vit.edu" once, and a third
// account that "vit" must not match at all.
window.localStorage.setItem('accountHistory', JSON.stringify([
  { email: 'vitthal@gmail.com', signIns: 5, signUps: 1, lastAt: 10, lastMode: 'signin' },
  { email: 'someone@vit.edu', signIns: 1, signUps: 0, lastAt: 99, lastMode: 'signin' },
  { email: 'nomatch@example.com', signIns: 3, signUps: 0, lastAt: 50, lastMode: 'signin' },
]))

const accountBtn = $('btn-account')
check('the account button exists', Boolean(accountBtn))
click(accountBtn)
await settle()

let dlg = document.querySelector('.dialog')
check('sign-in dialog opened', Boolean(dlg),
  dlg?.querySelector('.dialog__title')?.textContent ?? 'no dialog')

const emailField = dlg?.querySelector('input[type="email"]')
check('the dialog has an email field', Boolean(emailField))
check('the email field is prefilled with the most-used account',
  emailField?.value === 'vitthal@gmail.com', emailField?.value ?? 'empty')

const suggestList = dlg?.querySelector('.suggest')
check('a suggestion list is present', Boolean(suggestList))

// Typing "vit" must surface the busiest matching account first.
if (emailField && suggestList) {
  emailField.value = 'vit'
  emailField.dispatchEvent(new window.Event('input', { bubbles: true }))
  await settle()

  check('the suggestion list opened on typing', suggestList.classList.contains('is-open'))
  const shown = [...suggestList.querySelectorAll('.suggest__email')].map((n) => n.textContent)
  check('typing "vit" offers both matching accounts', shown.length === 2, shown.join(', ') || 'none')
  check('the most-used account is offered first', shown[0] === 'vitthal@gmail.com', shown[0] ?? 'none')
  check('an account that does not match is left out',
    !shown.includes('nomatch@example.com'), shown.join(', '))
  check('the busiest row is badged',
    Boolean(suggestList.querySelector('.suggest__badge')))
  check('the row says how often the account is used',
    suggestList.querySelector('.suggest__meta')?.textContent === 'Used 6 times',
    suggestList.querySelector('.suggest__meta')?.textContent ?? 'no meta')

  // Keyboard: down to the first row, Enter to accept it.
  press(emailField, 'ArrowDown')
  await settle()
  check('arrowing down highlights the first row',
    Boolean(suggestList.querySelector('.suggest__row.is-active')))

  press(emailField, 'Enter')
  await settle()
  check('Enter accepts the highlighted account',
    emailField.value === 'vitthal@gmail.com', emailField.value)
  check('accepting a suggestion closes the list', !suggestList.classList.contains('is-open'))
}

// Escape must close the suggestions without throwing away the dialog.
if (emailField && suggestList) {
  emailField.value = 'vit'
  emailField.dispatchEvent(new window.Event('input', { bubbles: true }))
  await settle()
  check('the list reopened for the Escape check', suggestList.classList.contains('is-open'))

  press(emailField, 'Escape')
  await settle()
  check('Escape closes the suggestions', !suggestList.classList.contains('is-open'))
  check('Escape did not also close the dialog', Boolean(document.querySelector('.dialog')))

  press(emailField, 'Escape')
  await settle()
  check('a second Escape closes the dialog', !document.querySelector('.dialog'))
}
check('no errors driving the suggestion list', errors.length === 0, errors.join(' | '))

// --- forgetting an account --------------------------------------------------
console.log('\n--- sign in: forgetting an account ---')
errors.length = 0
dismissAll()
click($('btn-account'))
await settle()

const forgetEmail = document.querySelector('.dialog input[type="email"]')
const forgetList = document.querySelector('.dialog .suggest')
if (forgetEmail && forgetList) {
  forgetEmail.value = 'vit'
  forgetEmail.dispatchEvent(new window.Event('input', { bubbles: true }))
  await settle()

  const dropBtn = forgetList.querySelector('.suggest__row .suggest__forget')
  check('each suggestion offers a way to forget it', Boolean(dropBtn))
  if (dropBtn) {
    dropBtn.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await settle()
    const left = JSON.parse(window.localStorage.getItem('accountHistory')).map((r) => r.email)
    check('the forgotten account is gone from storage',
      !left.includes('vitthal@gmail.com'), left.join(', '))
    const stillShown = [...forgetList.querySelectorAll('.suggest__email')].map((n) => n.textContent)
    check('and gone from the list under the cursor',
      !stillShown.includes('vitthal@gmail.com'), stillShown.join(', ') || 'list empty')
  }
}
check('no errors forgetting an account', errors.length === 0, errors.join(' | '))

// --- a failed sign-in must not be credited to the ranking -------------------
console.log('\n--- sign in: a failed attempt ---')
errors.length = 0
dismissAll()
window.localStorage.setItem('accountHistory', JSON.stringify([]))
click($('btn-account'))
await settle()

const failEmail = document.querySelector('.dialog input[type="email"]')
const failPassword = document.querySelector('.dialog input[type="password"]')
check('the dialog has a password field', Boolean(failPassword))

if (failEmail && failPassword) {
  fetchCalls = 0
  failEmail.value = 'wrong@example.com'
  failEmail.dispatchEvent(new window.Event('input', { bubbles: true }))
  failPassword.value = 'not-the-password'
  press(failPassword, 'Enter')
  await settle()

  check('the sign-in was actually attempted', fetchCalls === 1, `${fetchCalls} calls`)
  const shownError = document.querySelector('.dialog .field__error')?.textContent ?? ''
  check('the failure is reported in the dialog', shownError.length > 0, shownError || 'no message')
  check('a failed attempt is never credited to the ranking',
    JSON.parse(window.localStorage.getItem('accountHistory')).length === 0,
    window.localStorage.getItem('accountHistory'))
  check('the dialog stays open so the password can be corrected',
    Boolean(document.querySelector('.dialog')))

  const primary = document.querySelector('.dialog__actions .btn--primary')
  check('the submit button is usable again after a failure',
    primary && !primary.disabled && primary.textContent === 'Sign in',
    `${primary?.textContent} disabled=${primary?.disabled}`)
}
check('no errors on a failed sign-in', errors.length === 0, errors.join(' | '))

// --- create-account mode reuses the same machinery --------------------------
console.log('\n--- create account mode ---')
errors.length = 0
dismissAll()
window.localStorage.setItem('accountHistory', JSON.stringify([
  { email: 'vitthal@gmail.com', signIns: 0, signUps: 2, lastAt: 10, lastMode: 'signup' },
]))
click($('btn-account'))
await settle()

const swap = document.querySelector('.dialog .linkish')
check('the dialog offers a way to switch to signing up', Boolean(swap))
if (swap) {
  click(swap)
  await settle()
  const title = document.querySelector('.dialog__title')?.textContent
  check('switching lands on Create an account', title === 'Create an account', title ?? 'no title')

  const signupPassword = document.querySelector('.dialog input[type="password"]')
  check('the password field asks for a new password',
    signupPassword?.getAttribute('autocomplete') === 'new-password',
    signupPassword?.getAttribute('autocomplete') ?? 'none')

  const signupEmail = document.querySelector('.dialog input[type="email"]')
  const signupList = document.querySelector('.dialog .suggest')
  check('suggestions work when creating an account too', Boolean(signupEmail && signupList))
  if (signupEmail && signupList) {
    signupEmail.value = 'vit'
    signupEmail.dispatchEvent(new window.Event('input', { bubbles: true }))
    await settle()
    const rows = [...signupList.querySelectorAll('.suggest__email')].map((n) => n.textContent)
    check('a previously registered address is offered while signing up',
      rows.includes('vitthal@gmail.com'), rows.join(', ') || 'none')
    check('and it is described as an account created here',
      signupList.querySelector('.suggest__meta')?.textContent === 'Account created here',
      signupList.querySelector('.suggest__meta')?.textContent ?? 'no meta')
  }
}
check('no errors in create-account mode', errors.length === 0, errors.join(' | '))
dismissAll()
console.log('\n================ RESULTS ================')
console.log(results.join('\n'))
const failed = results.filter((r) => r.includes('FAIL')).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
