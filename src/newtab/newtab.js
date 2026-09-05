// The board UI. Plain ES modules and DOM — no framework, so no build step:
// edit a file, hit refresh on chrome://extensions, done.

import { Store } from '../lib/store.js'
import {
  FOLDER_COLORS, STICKER_COLORS, STICKER_SIZES,
  allTags, countItems, currentSpace, findFolder, findItem, findGroup, isGroup, eachItem,
  parseLegacyBackup, parseBrowserBookmarks, toBackupJson, toBookmarksHtml,
} from '../lib/model.js'
import { SyncStatus, SYNC_QUOTA_BYTES } from '../lib/sync.js'
import {
  el, uid, faviconEl, hostnameOf, bySortPosition, nextPosition, setOnlineIcons, forgetFavicons,
  positionBetween, formatBytes, debounce, safeUrl,
} from '../lib/util.js'
import { icon } from '../lib/icons.js'
import { mountNewsPanel, mimoSettingRows } from './newspanel.js'
import { readMimoConfig } from '../lib/mimo.js'
import { timeAgo } from '../lib/news.js'
import {
  readRoutineStore, updateRoutineStore, emptyRoutineStore, detectRoutineReport, nameRoutine, logAction,
  inBand, isToday, hourLabel, planDay, fileTabs,
  ROUTINE_MIN_DAYS, ROUTINE_EVENT_DAYS,
} from '../lib/routines.js'
import { readNewsCache } from '../lib/news.js'
import { mountRoutinePanel } from './routinepanel.js'
import { autoTag } from '../lib/auto-tag.js'
import { buildIndex, semanticSearch } from '../lib/memory/semantic-search.js'
import { findRelated } from '../lib/memory/related-finder.js'
import { computeImportance, computePermanentImportance } from '../lib/memory/importance-engine.js'
import { ask, confirmAction, dialog, dismissLayer, menu, closeMenu, dropdown } from '../lib/dialogs.js'
import {
  readAccounts, rankAccounts, recordAccountUse, forgetAccount, describeAccount, useCount,
} from '../lib/accounts.js'

const store = new Store()

const ui = {
  search: '',
  activeTags: new Set(),
  selectedTabIds: new Set(),
  selectedItemIds: new Set(),
  lastClickedTabId: null,
}

let openTabs = []

// The AI news and Routines views of the sidebar; mounted once the DOM is wired.
let newsPanel = null
let newsShowing = false
let routinePanel = null

// Every URL open in any window, mapped to the tab ids showing it, so the board
// can mark a bookmark as live. Kept separate from `openTabs`: that list is the
// sidebar's, scoped to this window and subject to the hide-pinned setting,
// neither of which should change whether a bookmark reads as open.
let liveTabs = new Map()
let liveSignature = ''

// --- Memory system state ---------------------------------------------------

let searchIndex = []
let tempEntries = new Map()  // urlNorm → TempEntry from background service worker

const $ = (id) => document.getElementById(id)

// ================================================================== boot ===

;(async function boot() {
  await store.init()
  applyChrome()
  store.addEventListener('change', renderAll)
  store.addEventListener('sync', () => { renderAccount(); renderSyncPill() })
  store.addEventListener('remote-applied', () => toast('Board updated from another device'))

  // Build the semantic search index from the loaded state.
  searchIndex = buildIndex(store.state)

  // Fetch temporary browsing memory from the background service worker.
  fetchTempEntries()

  await refreshTabs()
  wireChrome()
  wireUi()
  newsPanel = mountNewsPanel({
    store,
    toast,
    $,
    openSettings: () => { dismissLayer(); settingsDialog() },
    isVisible: () => newsShowing,
  })
  renderAll()

  // Learned routines: look once now, every minute, whenever the tab comes back
  // into view, and whenever the service worker records a tab event.
  routinePanel = mountRoutinePanel({
    $,
    actions: {
      accept: acceptRoutine,
      decline: declineRoutine,
      run: runRoutine,
      skip: skipRoutineToday,
      forget: forgetRoutine,
      runBuiltin,
      setTracking: setRoutineTracking,
    },
  })
  refreshRoutines()
  setInterval(refreshRoutines, ROUTINE_CHECK_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshRoutines()
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['tabspace.routines']) routineChanged()
  })
})()

// ------------------------------------------------------------------ theme ---

const THEMES = ['auto', 'light', 'dark']
const THEME_ICON = { auto: 'monitor', light: 'sun', dark: 'moon' }

function resolvedTheme() {
  const pref = store.state.settings.theme
  if (pref === 'light' || pref === 'dark') return pref
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Theme and font are attributes on <html>; every token keys off them. */
function applyChrome() {
  document.documentElement.dataset.theme = resolvedTheme()
  document.documentElement.dataset.font = store.state.settings.fontFamily ?? 'inter'
  setOnlineIcons(store.state.settings.onlineFavicons !== false)
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (store.state.settings.theme === 'auto') applyChrome()
})

function cycleTheme() {
  const current = store.state.settings.theme ?? 'auto'
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]
  store.dispatch('updateSettings', { patch: { theme: next } }, { undoable: false })
  toast(`Theme: ${next}`)
}

// ----------------------------------------------------------------- render ---

/** Fetch temporary browsing entries from the background service worker. */
function fetchTempEntries() {
  try {
    chrome.runtime.sendMessage({ type: 'memory:all' }, (entries) => {
      if (chrome.runtime.lastError || !Array.isArray(entries)) return
      tempEntries = new Map(entries.map((e) => [e.url?.replace(/\/+$/, '').toLowerCase(), e]))
      renderRelated()
      renderSaveSuggestions()
    })
  } catch { /* service worker may not be ready */ }
}

function renderAll() {
  applyChrome()
  renderSpaces()
  renderTagbar()
  renderBoard()
  renderCanvas()
  renderTabs()
  renderAccount()
  renderSyncPill()
  renderThemeButton()
  $('app').classList.toggle('sidebar-collapsed', store.state.settings.sidebarCollapsed)
  renderSidebarView()

  // Rebuild search index after every state change.
  searchIndex = buildIndex(store.state)
  renderRelated()
  renderSaveSuggestions()
}

// The sidebar holds two views -- the open-tab list and the AI news panel -- and
// which one shows is a setting, like whether the sidebar is open at all.
function renderSidebarView() {
  const s = store.state.settings
  const view = ['news', 'routines'].includes(s.sidebarView) ? s.sidebarView : 'tabs'
  for (const [id, name] of [['view-tabs', 'tabs'], ['view-news', 'news'], ['view-routines', 'routines']]) {
    const on = view === name
    $(id).classList.toggle('is-active', on)
    $(id).setAttribute('aria-selected', on ? 'true' : 'false')
  }
  $('panel-tabs').hidden = view !== 'tabs'
  $('panel-news').hidden = view !== 'news'
  $('panel-routines').hidden = view !== 'routines'
  if (view === 'routines') $('routines-dot').hidden = true

  const showing = view === 'news' && !s.sidebarCollapsed
  if (showing && !newsShowing) newsPanel?.shown()
  newsShowing = showing
}

function setSidebarView(view) {
  store.dispatch('updateSettings', { patch: { sidebarView: view } }, { undoable: false })
}

function renderThemeButton() {
  const btn = $('btn-theme')
  const pref = store.state.settings.theme ?? 'auto'
  btn.replaceChildren(icon(THEME_ICON[pref], { size: 17 }))
  btn.title = `Theme: ${pref}${pref === 'auto' ? ' (follows your system)' : ''} — click to change`
}

// ============================================================== routines ===
//
// Learned routines (lib/routines.js) spot sites that get opened or closed
// together at the same time of day on several days. This is where the offer
// shows -- the Open tabs view, just above the hint, the one spot the sidebar
// already uses for guidance -- and where every tap lands. Nothing opens or
// closes a tab without the confirm dialog, and every browser action gets a
// toast whose Undo reverses that action itself: store.undo() only knows the
// board, not Chrome's tabs.

const ROUTINE_CHECK_MS = 60 * 1000
const routineUi = { card: null, busy: false, snap: null, again: false, busyBuiltin: null }   // card: { routine, mode: 'offer' | 'run' }

async function refreshRoutines() {
  if (routineUi.busy) { routineUi.again = true; return }
  routineUi.busy = true
  try {
    let log = await readRoutineStore()
    const now = Date.now()
    let { routine: found, report } = detectRoutineReport(log, now)

    // A pending offer, or a new one if the record holds a pattern.
    let offered = log.routines.find((r) => r.status === 'offered')
    if (!offered && found && log.tracking) {
      const seen = found.byDay === false
        ? `${found.seen} separate times in the ${found.span} window`
        : `around ${hourLabel(found.hour)} on ${found.seen} days`
      log = await updateRoutineStore((s) => {
        s.routines.push(found)
        logAction(s, {
          action: 'offer', routineId: found.id, name: found.name,
          reason: `${found.kind === 'wrapup' ? 'closed' : 'opened'} together ${seen}: ${found.hosts.join(', ')}`,
        })
        return s
      })
      offered = found
      report = detectRoutineReport(log, now).report
      if (!(store.state.settings.sidebarView === 'routines' && !store.state.settings.sidebarCollapsed)) $('routines-dot').hidden = false
      nameRoutineWithMimo(found)
    }
    routineUi.snap = { store: { ...log, busyBuiltin: routineUi.busyBuiltin }, report, now }
    routinePanel?.render(routineUi.snap)

    if (!log.tracking) { routineUi.card = null; renderRoutineCard(); return }
    if (offered) { routineUi.card = { routine: offered, mode: 'offer' }; renderRoutineCard(); return }

    // An accepted routine whose time of day it is, not yet run or skipped today.
    const due = log.routines.find((r) => r.status === 'accepted' && inBand(r, now)
      && !isToday(r.lastRunAt, now) && !isToday(r.skippedAt, now))
    const showable = due && (due.kind === 'morning' ? routineUrlsToOpen(due).length > 0 : routineTabsToClose(due).length >= 2)
    routineUi.card = showable ? { routine: due, mode: 'run' } : null
    renderRoutineCard()
  } finally {
    routineUi.busy = false
    if (routineUi.again) { routineUi.again = false; refreshRoutines() }
  }
}

// The record is written by the service worker; a change there redraws the
// live feed and re-runs the search, so a habit shows up as it forms.
const routineChanged = debounce(refreshRoutines, 800)

async function forgetRoutine(r) {
  await updateRoutineStore((s) => {
    s.routines = s.routines.filter((x) => x.id !== r.id)
    logAction(s, { action: 'forget', routineId: r.id, name: r.name, reason: 'tapped Forget' })
  })
  if (routineUi.card?.routine.id === r.id) routineUi.card = null
  await refreshRoutines()
}

async function setRoutineTracking(on) {
  await updateRoutineStore((s) => {
    s.tracking = on
    logAction(s, { action: on ? 'tracking-on' : 'tracking-off', reason: 'Routines panel' })
  })
  await refreshRoutines()
}

// --------------------------------------------------------- built-in tasks

/** The two routines every board ships with. Each is one complete task. */
async function runBuiltin(b) {
  if (routineUi.busyBuiltin) return
  routineUi.busyBuiltin = b.id
  routinePanel?.render(routineUi.snap && { ...routineUi.snap, store: { ...routineUi.snap.store, busyBuiltin: b.id } })
  try {
    if (b.kind === 'plan') await runPlanDay(b)
    else if (b.kind === 'file') await runWrapUpAndFile(b)
  } catch (err) {
    toast(err?.message ?? 'That did not work')
    await updateRoutineStore((s) => logAction(s, { action: 'error', routineId: b.id, name: b.name, reason: err?.message ?? 'unknown' }))
  } finally {
    routineUi.busyBuiltin = null
    await refreshRoutines()
  }
}

function tabsForAi() {
  return openTabs
    .filter((t) => t.url && /^https?:/.test(t.url))
    .map((t) => ({ id: t.id, title: t.title ?? '', host: hostnameOf(t.url), url: t.url, favicon: t.favIconUrl ?? '', pinned: t.pinned }))
}

/**
 * Plan my day: MiMo writes 3-5 bullets from the open tabs, the folder names
 * and the top news; the person sees the plan and chooses whether it goes on
 * the board as a note. Undo removes the note.
 */
async function runPlanDay(b) {
  const tabs = tabsForAi()
  const space = currentSpace(store.state)
  const folders = (space?.folders ?? []).map((f) => f.title)
  const news = ((await readNewsCache('daily'))?.items ?? []).slice(0, 3).map((i) => i.title)
  if (!tabs.length && !folders.length) return toast('Open a few tabs first — there is nothing to plan from')

  toast('Writing today\'s plan…')
  const { apiKey } = await readMimoConfig()
  const plan = await planDay({ apiKey, tabs, folders, news })

  const ok = await new Promise((resolve) => {
    const done = (v) => { dismissLayer(); resolve(v) }
    dialog({
      title: plan.title,
      subtitle: `From ${tabs.length} open tab${tabs.length === 1 ? '' : 's'}, ${folders.length} folder${folders.length === 1 ? '' : 's'}${news.length ? ' and the top news' : ''}.`,
      body: el('ul.plan-list', {}, plan.bullets.map((t) => el('li', { text: t }))),
      actions: [
        { label: 'Cancel', onClick: () => done(false) },
        { label: 'Put it on the board', tone: 'primary', onClick: () => done(true), autofocus: true },
      ],
      onEscape: () => done(false),
    })
  })
  if (!ok) {
    await updateRoutineStore((s) => logAction(s, { action: 'cancel', routineId: b.id, name: b.name, reason: 'declined the plan' }))
    return
  }
  if (ui.search.trim() || ui.activeTags.size) { ui.search = ''; ui.activeTags.clear(); $('search').value = '' }
  const spot = freeNoteSpot()
  store.dispatch('addSticker', {
    spaceId: space.id,
    sticker: { ...spot, text: `${plan.title}\n${plan.bullets.map((t) => `• ${t}`).join('\n')}`, fontSize: 14 },
  })
  await markBuiltinRan(b, `wrote ${plan.bullets.length} bullets from ${tabs.length} tabs`)
  toast('Plan added to the board', undoAction())
}

/**
 * Wrap up and file: MiMo names a folder and summarises the open tabs; after
 * the confirm, a folder with every tab and a summary note lands on the board
 * and the tabs close. Undo puts the board back and reopens the tabs.
 */
async function runWrapUpAndFile(b) {
  const tabs = tabsForAi().filter((t) => !t.pinned)
  if (!tabs.length) return toast('Nothing open to file')
  const space = currentSpace(store.state)
  if (!space) return

  toast(`Reading ${tabs.length} tab${tabs.length === 1 ? '' : 's'}…`)
  const { apiKey } = await readMimoConfig()
  const filed = await fileTabs({ apiKey, tabs, existingFolders: space.folders.map((f) => f.title) })

  const ok = await confirmAction({
    title: `File ${tabs.length} tab${tabs.length === 1 ? '' : 's'} into "${filed.folder}" and close them?`,
    subtitle: filed.summary || tabs.map((t) => t.host).join(' · '),
    confirmLabel: 'File and close',
    tone: 'primary',
  })
  if (!ok) {
    await updateRoutineStore((s) => logAction(s, { action: 'cancel', routineId: b.id, name: b.name, reason: `declined filing into "${filed.folder}"` }))
    return
  }

  // One undoable step (the folder), the rest silent -- exactly how Stash all
  // does it, so a single Undo takes the whole thing back.
  const folderId = store.dispatch('addFolder', { spaceId: space.id, title: filed.folder })
  let position = 1000
  if (filed.summary) {
    store.dispatch('addItem', { folderId, item: { type: 'note', title: filed.summary }, position }, { undoable: false })
    position += 1000
  }
  for (const t of tabs) {
    store.dispatch('addItem', {
      folderId,
      item: { type: 'bookmark', title: t.title, url: t.url, favicon: t.favicon, tags: filed.tags },
      position,
    }, { undoable: false })
    position += 1000
  }
  const urls = tabs.map((t) => t.url)
  await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {})
  await markBuiltinRan(b, `filed ${tabs.length} into "${filed.folder}" and closed them`)
  toast(`Filed ${tabs.length} tab${tabs.length === 1 ? '' : 's'} into "${filed.folder}"`, {
    label: 'Undo',
    onClick: async () => {
      store.undo()
      for (const url of urls) await chrome.tabs.create({ url, active: false }).catch(() => {})
      await updateRoutineStore((s) => logAction(s, { action: 'undo', routineId: b.id, name: b.name, reason: `removed "${filed.folder}" and reopened ${urls.length}` }))
    },
  })
}

async function markBuiltinRan(b, reason) {
  await updateRoutineStore((s) => {
    s.builtin[b.id] = { lastRunAt: Date.now() }
    logAction(s, { action: 'run', routineId: b.id, name: b.name, reason })
  })
}

/** Name the offer with MiMo when a key is present; the fallback name stays otherwise. */
async function nameRoutineWithMimo(routine) {
  const { apiKey } = await readMimoConfig()
  if (!apiKey) return
  try {
    const { name, description } = await nameRoutine({ apiKey, routine })
    await updateRoutineStore((s) => {
      const r = s.routines.find((x) => x.id === routine.id)
      if (r) Object.assign(r, { name, description, named: true })
    })
    if (routineUi.card?.routine.id === routine.id) {
      Object.assign(routineUi.card.routine, { name, description, named: true })
      renderRoutineCard()
    }
    await refreshRoutines()
  } catch { /* the fallback name is fine */ }
}

function routineOpenHosts() {
  return new Set([...liveTabs.keys()].map((u) => hostnameOf(u)))
}

/** The routine's sites that are not open anywhere right now. */
function routineUrlsToOpen(r) {
  const open = routineOpenHosts()
  return r.urls.filter((u) => !open.has(hostnameOf(u)))
}

/** This window's unpinned tabs on the routine's sites. */
function routineTabsToClose(r) {
  const hosts = new Set(r.hosts)
  return openTabs.filter((t) => !t.pinned && hosts.has(hostnameOf(t.url ?? '')))
}

function renderRoutineCard() {
  const slot = $('routine-offer')
  const card = routineUi.card
  if (!card) { slot.hidden = true; slot.replaceChildren(); return }
  const r = card.routine
  const n = card.mode === 'run'
    ? (r.kind === 'wrapup' ? routineTabsToClose(r).length : routineUrlsToOpen(r).length)
    : r.hosts.length
  const verb = r.kind === 'wrapup' ? 'closed' : 'opened'

  const kicker = el('div.routine-card__kicker', {}, [
    icon('repeat', { size: 13 }),
    card.mode === 'offer' ? 'Noticed a habit' : 'Time for this',
  ])
  const seen = r.byDay === false ? `${r.seen} separate times today` : `around ${hourLabel(r.hour)} on ${r.seen} different days`
  const desc = card.mode === 'offer'
    ? (r.description || `You ${verb} these ${r.hosts.length} sites together ${seen}. Want a one-tap ${r.kind === 'wrapup' ? 'close' : 'open'} for them?`)
    : (r.kind === 'wrapup' ? `Close the ${n} open tab${n === 1 ? '' : 's'} from this set?` : `Open the ${n} of these not already open?`)

  const hosts = el('div.routine-card__hosts', {}, r.hosts.map((h, i) =>
    el('span.routine-card__host', { title: r.titles[i] || h }, [faviconEl({ url: r.urls[i], favicon: '' }, true), el('span', { text: h })])))

  const primary = el('button.btn.btn--primary.btn--sm', {
    text: card.mode === 'offer' ? 'Yes, set it up' : (r.kind === 'wrapup' ? `Close ${n} tab${n === 1 ? '' : 's'}` : `Open ${n} tab${n === 1 ? '' : 's'}`),
  })
  const secondary = el('button.btn.btn--quiet.btn--sm', { text: card.mode === 'offer' ? 'Not now' : 'Skip today' })
  primary.addEventListener('click', () => (card.mode === 'offer' ? acceptRoutine(r) : runRoutine(r)))
  secondary.addEventListener('click', () => (card.mode === 'offer' ? declineRoutine(r) : skipRoutineToday(r)))

  slot.replaceChildren(el('div.routine-card', {}, [
    kicker,
    el('div.routine-card__title', { text: r.name }),
    el('div.routine-card__desc', { text: desc }),
    hosts,
    el('div.routine-card__actions', {}, [primary, secondary]),
  ]))
  slot.hidden = false
}

async function acceptRoutine(r) {
  await updateRoutineStore((s) => {
    const x = s.routines.find((y) => y.id === r.id)
    if (x) x.status = 'accepted'
    logAction(s, { action: 'accept', routineId: r.id, name: r.name, reason: 'tapped "Yes, set it up"' })
  })
  r.status = 'accepted'
  // Setting it up never runs it: the first run is its own confirmed tap.
  await runRoutine(r)
  await refreshRoutines()
}

async function declineRoutine(r) {
  await updateRoutineStore((s) => {
    const x = s.routines.find((y) => y.id === r.id)
    if (x) x.status = 'declined'
    logAction(s, { action: 'decline', routineId: r.id, name: r.name, reason: 'tapped "Not now"' })
  })
  toast('Okay — it will not be offered again')
  await refreshRoutines()
}

async function skipRoutineToday(r) {
  await updateRoutineStore((s) => {
    const x = s.routines.find((y) => y.id === r.id)
    if (x) x.skippedAt = Date.now()
    logAction(s, { action: 'skip', routineId: r.id, name: r.name, reason: 'tapped "Skip today"' })
  })
  await refreshRoutines()
}

/** The only place a routine touches Chrome's tabs. Confirm first, undo after. */
async function runRoutine(r) {
  if (r.kind === 'wrapup') return runWrapup(r)

  const urls = routineUrlsToOpen(r)
  if (!urls.length) {
    toast('Those are all open already')
    await markRoutineRan(r, 'nothing to open')
    return
  }
  const ok = await confirmAction({
    title: `Open ${urls.length} tab${urls.length === 1 ? '' : 's'}?`,
    subtitle: urls.map((u) => hostnameOf(u)).join(' · '),
    confirmLabel: 'Open',
    tone: 'primary',
  })
  if (!ok) {
    await updateRoutineStore((s) => logAction(s, { action: 'cancel', routineId: r.id, name: r.name, reason: 'declined the open dialog' }))
    return
  }
  const opened = []
  for (const url of urls) {
    const tab = await chrome.tabs.create({ url, active: false }).catch(() => null)
    if (tab?.id != null) opened.push(tab.id)
  }
  await markRoutineRan(r, `opened ${opened.length}: ${urls.map(hostnameOf).join(', ')}`)
  toast(`Opened ${opened.length} tab${opened.length === 1 ? '' : 's'}`, {
    label: 'Undo',
    onClick: async () => {
      await chrome.tabs.remove(opened).catch(() => {})
      await updateRoutineStore((s) => logAction(s, { action: 'undo', routineId: r.id, name: r.name, reason: `closed the ${opened.length} just opened` }))
    },
  })
}

async function runWrapup(r) {
  const tabs = routineTabsToClose(r)
  if (!tabs.length) {
    toast('Nothing from that set is open')
    await markRoutineRan(r, 'nothing to close')
    return
  }
  const ok = await confirmAction({
    title: `Close ${tabs.length} tab${tabs.length === 1 ? '' : 's'}?`,
    subtitle: tabs.map((t) => t.title || hostnameOf(t.url ?? '')).join(' · '),
    confirmLabel: 'Close',
  })
  if (!ok) {
    await updateRoutineStore((s) => logAction(s, { action: 'cancel', routineId: r.id, name: r.name, reason: 'declined the close dialog' }))
    return
  }
  const urls = tabs.map((t) => t.url).filter(Boolean)
  await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {})
  await markRoutineRan(r, `closed ${tabs.length}: ${[...new Set(urls.map(hostnameOf))].join(', ')}`)
  toast(`Closed ${tabs.length} tab${tabs.length === 1 ? '' : 's'}`, {
    label: 'Undo',
    onClick: async () => {
      for (const url of urls) await chrome.tabs.create({ url, active: false }).catch(() => {})
      await updateRoutineStore((s) => logAction(s, { action: 'undo', routineId: r.id, name: r.name, reason: `reopened the ${urls.length} just closed` }))
    },
  })
}

async function markRoutineRan(r, reason) {
  await updateRoutineStore((s) => {
    const x = s.routines.find((y) => y.id === r.id)
    if (x) x.lastRunAt = Date.now()
    logAction(s, { action: 'run', routineId: r.id, name: r.name, reason })
  })
  r.lastRunAt = Date.now()
}

// --------------------------------------------------------------- settings ---

function routineSettingRows(log) {
  const trackingToggle = toggleControl(log.tracking !== false, async (v) => {
    await updateRoutineStore((s) => {
      s.tracking = v
      logAction(s, { action: v ? 'tracking-on' : 'tracking-off', reason: 'Settings toggle' })
    })
    refreshRoutines()
  })
  const activity = el('button.btn.btn--quiet.btn--sm', { text: 'Activity' })
  activity.addEventListener('click', () => { dismissLayer(); routineActivityDialog() })

  return [
    settingRow('Learned routines',
      `Tabspace notices sites you open together, or close together, at about the same time of day on ${ROUTINE_MIN_DAYS} or more days, and offers a one-tap version. It only ever offers: nothing opens or closes without your confirmation, and every run has an Undo. The record of tab opens and closes stays on this device for ${ROUTINE_EVENT_DAYS} days — never synced, never exported. With a MiMo key, the model names a routine from its site names and titles only.`,
      [trackingToggle, activity]),
  ]
}

async function routineActivityDialog() {
  const log = await readRoutineStore()
  const body = el('div', {})

  const routines = [...log.routines].sort((a, b) => b.createdAt - a.createdAt)
  body.append(el('div.setting__title', { text: 'Routines' }))
  if (!routines.length) {
    body.append(el('div.routine-empty', { text: `Nothing learned yet. ${log.events.length} tab event${log.events.length === 1 ? '' : 's'} recorded so far; a pattern needs ${ROUTINE_MIN_DAYS} days.` }))
  } else {
    body.append(el('div.routine-list', {}, routines.map((r) => {
      const forget = el('button.btn.btn--quiet.btn--sm', { text: 'Forget' })
      forget.addEventListener('click', async () => {
        await updateRoutineStore((s) => {
          s.routines = s.routines.filter((x) => x.id !== r.id)
          logAction(s, { action: 'forget', routineId: r.id, name: r.name, reason: 'Settings → Forget' })
        })
        dismissLayer()
        routineActivityDialog()
        refreshRoutines()
      })
      return el('div.routine-row', {}, [
        el('div.routine-row__body', {}, [
          el('div.routine-row__name', { text: r.name }),
          el('div.routine-row__sub', { text: `${r.kind === 'wrapup' ? 'Closes' : 'Opens'} ${r.hosts.join(', ')} around ${hourLabel(r.hour)} · seen on ${r.seen} days` }),
        ]),
        el(`span.routine-row__status.routine-row__status--${r.status}`, { text: r.status }),
        forget,
      ])
    })))
  }

  body.append(el('div.setting__title', { text: 'Recent activity', style: { marginTop: '16px' } }))
  const entries = log.log.slice(-20).reverse()
  if (!entries.length) {
    body.append(el('div.routine-empty', { text: 'No routine activity yet.' }))
  } else {
    body.append(el('div.routine-log', {}, entries.map((e) => el('div.routine-log__row', {}, [
      el('span.routine-log__when', { text: timeAgo(new Date(e.t).toISOString()) }),
      el('span.routine-log__what', {}, [el('b', { text: e.action }), e.name ? ` · ${e.name}` : '', e.reason ? ` — ${e.reason}` : '']),
    ]))))
  }

  const forgetAll = el('button.btn.btn--quiet.btn--sm', { text: 'Forget everything' })
  forgetAll.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: 'Forget all routines and the tab record?',
      subtitle: 'Routines, the activity log and the record of tab opens and closes on this device are cleared. Your board is untouched.',
      confirmLabel: 'Forget',
    })
    if (!ok) return routineActivityDialog()
    await updateRoutineStore((s) => {
      const keepTracking = s.tracking
      Object.assign(s, emptyRoutineStore(), { tracking: keepTracking })
    })
    routineUi.card = null
    renderRoutineCard()
    toast('Routines forgotten')
  })

  dialog({
    title: 'Learned routines',
    body,
    wide: true,
    actions: [
      { label: 'Forget everything', onClick: () => { dismissLayer(); forgetAll.click() } },
      { label: 'Done', tone: 'primary', onClick: dismissLayer },
    ],
  })
}

// ============================================================ chrome wiring ===

function wireChrome() {
  // The board paints open bookmarks differently, so a tab opening or closing has
  // to redraw it too -- but only when the set of open URLs actually moved, not
  // on every switch between tabs.
  const refresh = debounce(async () => {
    const before = liveSignature
    await refreshTabs()
    renderTabs()
    if (liveSignature !== before) renderBoard()
  }, 120)
  for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onAttached', 'onDetached']) {
    chrome.tabs[ev]?.addListener(refresh)
  }
  chrome.tabs.onActivated.addListener(refresh)

  window.addEventListener('beforeunload', () => { store.flush(); store.dispose() })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { store.flush(); return }
    store.sync.pullIfNewer()
    if (store.cloud.enabled) store.cloud.pullIfNewer()
  })
}

async function refreshTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true })
  const self = await chrome.tabs.getCurrent()
  const boardUrl = chrome.runtime.getURL('src/newtab/')
  const hidePinned = store.state.settings.hidePinnedTabs
  openTabs = tabs.filter((t) =>
    t.id !== self?.id
    && !t.url?.startsWith(boardUrl)
    && !t.url?.startsWith('chrome://newtab')
    && !(hidePinned && t.pinned))

  const everywhere = await chrome.tabs.query({})
  liveTabs = new Map()
  for (const tab of everywhere) {
    if (!tab.url || tab.url.startsWith(boardUrl)) continue
    const url = normaliseUrl(tab.url)
    if (!url) continue
    const ids = liveTabs.get(url)
    if (ids) ids.push(tab.id)
    else liveTabs.set(url, [tab.id])
  }
  liveSignature = [...liveTabs.keys()].sort().join('\n')
}

/** Reorder the real tabs. Pinned tabs are left alone — Chrome pins them front. */
async function sortTabs(mode) {
  const all = await chrome.tabs.query({ currentWindow: true })
  const movable = all.filter((t) => !t.pinned)
  if (movable.length < 2) return toast('Need at least two tabs to sort')

  const key = {
    title: (t) => (t.title ?? '').toLowerCase(),
    domain: (t) => `${hostnameOf(t.url ?? '')}|${(t.title ?? '').toLowerCase()}`,
    recent: (t) => -(t.lastAccessed ?? 0),
  }[mode]

  const sorted = [...movable].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    return typeof ka === 'number' ? ka - kb : ka.localeCompare(kb)
  })

  const first = Math.min(...movable.map((t) => t.index))
  for (const [offset, tab] of sorted.entries()) {
    await chrome.tabs.move(tab.id, { index: first + offset })
  }
  await refreshTabs()
  renderTabs()
  toast(`Sorted ${sorted.length} tabs`)
}

async function closeDuplicateTabs() {
  const all = await chrome.tabs.query({ currentWindow: true })
  const seen = new Set()
  const doomed = []

  for (const tab of all) {
    const url = normaliseUrl(tab.url ?? '')
    if (!url || tab.pinned) continue
    if (seen.has(url)) doomed.push(tab.id)
    else seen.add(url)
  }

  if (!doomed.length) return toast('No duplicates. Immaculate.')
  await chrome.tabs.remove(doomed)
  await refreshTabs()
  renderTabs()
  toast(`Closed ${doomed.length} duplicate tab${doomed.length === 1 ? '' : 's'}`)
}

// ================================================================ sidebar ===

function normaliseUrl(url) {
  return String(url).replace(/\/+$/, '').toLowerCase()
}

function savedUrls() {
  const set = new Set()
  for (const { item } of eachItem(store.state)) if (item.url) set.add(normaliseUrl(item.url))
  return set
}

function renderTabs() {
  const list = $('tab-list')
  const scroll = list.scrollTop
  list.replaceChildren()

  const saved = savedUrls()
  $('tab-count').textContent = String(openTabs.length)

  if (!openTabs.length) {
    list.append(el('div.folder__empty', { text: 'One lonely tab. Respect.' }))
    list.scrollTop = scroll
    return
  }

  for (const tab of openTabs) {
    const isSaved = saved.has(normaliseUrl(tab.url ?? ''))

    const close = el('button.icon-btn.icon-btn--sm.row__action', { title: 'Close tab' })
    close.append(icon('close', { size: 13 }))
    close.addEventListener('click', (e) => { e.stopPropagation(); chrome.tabs.remove(tab.id) })

    const row = el(`div.row${isSaved ? '.is-saved' : ''}`, {
      draggable: true,
      title: `${tab.title}\n${tab.url}`,
    }, [
      faviconEl({ url: tab.url ?? '', favicon: tab.favIconUrl, title: tab.title }),
      el('div.row__body', {}, [
        el('div.row__title', { text: tab.title || tab.url || '' }),
        el('div.row__sub', { text: hostnameOf(tab.url ?? '') }),
      ]),
      isSaved ? icon('check', { size: 14, className: 'row__saved' }) : null,
      close,
    ])

    row.classList.toggle('is-selected', ui.selectedTabIds.has(tab.id))
    row.addEventListener('click', (e) => onTabClick(e, tab))
    row.addEventListener('dragstart', (e) => onTabDragStart(e, tab))
    row.addEventListener('dragend', clearDropTargets)
    list.append(row)
  }
  list.scrollTop = scroll
}

async function renderRelated() {
  const panel = $('related-panel')
  const list = $('related-list')
  const tabLabel = $('related-tab')
  list.replaceChildren()

  // Determine the context tab: whichever tab the user is actually looking at.
  let contextTitle = ''
  let contextUrl = ''
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    // Don't show related items for the board itself.
    const boardUrl = chrome.runtime.getURL('src/newtab/')
    if (active?.url && !active.url.startsWith(boardUrl)) {
      contextTitle = active.title ?? ''
      contextUrl = active.url ?? ''
    }
  } catch { /* no tabs API outside extension context */ }

  if (!contextTitle && !contextUrl) {
    panel.hidden = true
    return
  }

  const results = findRelated({
    title: contextTitle,
    url: contextUrl,
    state: store.state,
    tempEntries,
    limit: 3,
  })

  if (!results.length) {
    panel.hidden = true
    return
  }

  panel.hidden = false
  tabLabel.textContent = contextTitle.length > 20
    ? contextTitle.slice(0, 20) + '\u2026'
    : contextTitle

  for (const { item, folder, space, reasons } of results) {
    const title = item.title || item.url || 'Untitled'
    const sub = [hostnameOf(item.url ?? ''), folder?.title, space?.name]
      .filter(Boolean)
      .join(' \u00b7 ')

    const row = el('a.related-item', {
      href: item.url || '#',
      title: `${title}\n${reasons.join(', ')}`,
    }, [
      faviconEl({ url: item.url ?? '', favicon: item.favicon, title }),
      el('div.related-item__body', {}, [
        el('div.related-item__title', { text: title }),
        el('div.related-item__sub', { text: sub }),
      ]),
    ])

    row.addEventListener('click', (e) => {
      e.preventDefault()
      if (item.url) chrome.tabs.create({ url: item.url })
    })

    list.append(row)
  }
}

/** Show non-intrusive save suggestions for high-importance browsing entries. */
function renderSaveSuggestions() {
  const panel = $('save-suggest')
  const list = $('save-suggest-list')
  if (!panel || !list) return
  list.replaceChildren()

  if (!tempEntries?.size) {
    panel.hidden = true
    return
  }

  // Find HIGH-importance entries the user hasn't already saved.
  const candidates = []
  for (const [, entry] of tempEntries) {
    if (entry.saved) continue
    if (computeImportance(entry) !== 'high') continue
    // Don't suggest if already on the board.
    const norm = (entry.url ?? '').replace(/\/+$/, '').toLowerCase()
    const onBoard = store.state.spaces?.some((s) =>
      s.folders?.some((f) =>
        f.items?.some((i) =>
          (i.url ?? '').replace(/\/+$/, '').toLowerCase() === norm
            || i.groupItems?.some((g) =>
              (g.url ?? '').replace(/\/+$/, '').toLowerCase() === norm))))
    if (onBoard) continue
    candidates.push(entry)
  }

  if (!candidates.length) {
    panel.hidden = true
    return
  }

  // Show at most 3 suggestions.
  const top = candidates.slice(0, 3)
  panel.hidden = false

  for (const entry of top) {
    const title = entry.title || entry.url || 'Untitled'
    const sub = hostnameOf(entry.url ?? '')

    const saveBtn = el('button.btn.btn--quiet.btn--sm.save-suggest__save', { text: 'Save' })
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      // Save to the first space's first folder (or the current space).
      const space = currentSpace(store.state) || store.state.spaces?.[0]
      if (!space) return
      const folder = space.folders?.[0]
      if (!folder) return
      store.dispatch('addItem', {
        folderId: folder.id,
        item: {
          type: 'bookmark',
          url: entry.url,
          title: entry.title || entry.url,
          favicon: entry.favicon,
        },
      })
      chrome.runtime.sendMessage({ type: 'memory:markSaved', url: entry.url })
      entry.saved = true
      renderSaveSuggestions()
      toast(`Saved "${title.slice(0, 30)}"`)
    })

    const row = el('div.save-suggest__item', {}, [
      faviconEl({ url: entry.url ?? '', favicon: entry.favicon, title }),
      el('div.save-suggest__body', {}, [
        el('div.save-suggest__name', { text: title.length > 28 ? title.slice(0, 28) + '\u2026' : title }),
        el('div.save-suggest__sub', { text: sub }),
      ]),
      saveBtn,
    ])

    list.append(row)
  }
}

function onTabClick(e, tab) {
  if (e.shiftKey && ui.lastClickedTabId != null) {
    const ids = openTabs.map((t) => t.id)
    const a = ids.indexOf(ui.lastClickedTabId)
    const b = ids.indexOf(tab.id)
    if (a !== -1 && b !== -1) {
      for (const id of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) ui.selectedTabIds.add(id)
      renderTabs()
      return
    }
  }
  if (e.metaKey || e.ctrlKey) {
    ui.selectedTabIds.has(tab.id) ? ui.selectedTabIds.delete(tab.id) : ui.selectedTabIds.add(tab.id)
    ui.lastClickedTabId = tab.id
    renderTabs()
    return
  }
  ui.selectedTabIds.clear()
  ui.lastClickedTabId = tab.id
  chrome.tabs.update(tab.id, { active: true })
  renderRelated()
}

function onTabDragStart(e, tab) {
  const ids = ui.selectedTabIds.has(tab.id) && ui.selectedTabIds.size > 1
    ? [...ui.selectedTabIds]
    : [tab.id]
  const payload = openTabs
    .filter((t) => ids.includes(t.id))
    .map((t) => ({ title: t.title, url: t.url, favicon: t.favIconUrl }))

  e.dataTransfer.effectAllowed = 'copyMove'
  e.dataTransfer.setData('application/x-tabspace', JSON.stringify({ kind: 'tabs', payload }))
  setDragGhost(e, payload.length > 1 ? `${payload.length} tabs` : payload[0]?.title ?? 'Tab')
}

function setDragGhost(e, label) {
  const ghost = el('div.drag-ghost', { text: label })
  document.body.append(ghost)
  e.dataTransfer.setDragImage(ghost, 12, 12)
  setTimeout(() => ghost.remove(), 0)
}

// ================================================================= spaces ===

function renderSpaces() {
  const host = $('spaces')
  host.replaceChildren()
  const active = currentSpace(store.state)

  for (const space of [...store.state.spaces].sort(bySortPosition)) {
    const tab = el(`button.space-tab${space.id === active?.id ? '.is-active' : ''}`, {
      text: space.title,
      onclick: () => store.dispatch('selectSpace', { spaceId: space.id }, { undoable: false }),
      oncontextmenu: (e) => { e.preventDefault(); spaceMenu(e, space) },
    })
    host.append(tab)
  }

  // Unlimited spaces: never gated, never counted.
  const add = el('button.icon-btn', { title: 'New space' })
  add.append(icon('plus', { size: 16 }))
  add.addEventListener('click', async () => {
    const title = await ask({
      title: 'New space',
      subtitle: 'A space is a separate board — work, personal, a project.',
      label: 'Name',
      value: '',
      placeholder: 'e.g. Research',
      confirmLabel: 'Create',
      validate: (v) => (v ? null : 'Give the space a name.'),
    })
    if (title) store.dispatch('addSpace', { title })
  })
  host.append(add)
}

function spaceMenu(e, space) {
  menu(e, [
    { label: 'Rename', iconName: 'note', onClick: async () => {
      const title = await ask({ title: 'Rename space', label: 'Name', value: space.title,
        validate: (v) => (v ? null : 'Give the space a name.') })
      if (title) store.dispatch('renameSpace', { spaceId: space.id, title })
    } },
    { label: 'Duplicate', iconName: 'copy', onClick: () => {
      store.dispatch('duplicateSpace', { spaceId: space.id })
      toast('Space duplicated', undoAction())
    } },
    { separator: true },
    { label: 'Collapse all folders', iconName: 'chevronRight', onClick: () =>
      store.dispatch('setAllFoldersCollapsed', { spaceId: space.id, collapsed: true }) },
    { label: 'Expand all folders', iconName: 'chevronDown', onClick: () =>
      store.dispatch('setAllFoldersCollapsed', { spaceId: space.id, collapsed: false }) },
    { label: 'Remove duplicate bookmarks', iconName: 'layers', onClick: () => {
      const n = store.dispatch('removeDuplicateBookmarks', { spaceId: space.id })
      toast(n ? `Removed ${n} duplicate${n === 1 ? '' : 's'}` : 'No duplicates found', n ? undoAction() : null)
    } },
    { separator: true },
    { label: 'Delete space', iconName: 'trash', tone: 'danger', onClick: async () => {
      const yes = await confirmAction({
        title: `Delete "${space.title}"?`,
        subtitle: 'Every folder and bookmark in this space goes with it. You can undo straight after.',
      })
      if (!yes) return
      store.dispatch('deleteSpace', { spaceId: space.id })
      toast('Space deleted', undoAction())
    } },
  ])
}

// ================================================================== board ===

/**
 * Folders to draw, with items already filtered by the search box and any active
 * tag chips. With no filter every folder shows, empty ones included, so there is
 * always somewhere to drop a tab.
 */
function visibleFolders() {
  const space = currentSpace(store.state)
  if (!space) return []

  const q = ui.search.trim().toLowerCase()
  const tags = [...ui.activeTags]
  const filtering = Boolean(q) || tags.length > 0
  const sorted = [...space.folders].sort(bySortPosition)

  if (!filtering) {
    return sorted.map((folder) => ({ folder, items: [...folder.items].sort(bySortPosition) }))
  }

  const keep = (i) => {
    if (tags.length && !tags.every((t) => i.tags?.includes(t))) return false
    if (!q) return true
    return i.title?.toLowerCase().includes(q)
      || i.url?.toLowerCase().includes(q)
      || i.tags?.some((t) => t.toLowerCase().includes(q))
  }

  const results = []
  for (const folder of sorted) {
    const all = [...folder.items].sort(bySortPosition)

    // A folder tagged with everything being filtered for shows in full — that
    // is the point of tagging a folder rather than its individual bookmarks.
    if (tags.length && tags.every((t) => folder.tags?.includes(t))) {
      results.push({ folder, items: all })
      continue
    }
    const items = all.flatMap((item) => {
      if (!isGroup(item)) return keep(item) ? [item] : []
      const nameHit = q && item.title.toLowerCase().includes(q) && !tags.length
      const kids = [...item.groupItems].sort(bySortPosition).filter(keep)
      if (nameHit) return [{ ...item, groupItems: [...item.groupItems].sort(bySortPosition) }]
      return kids.length ? [{ ...item, groupItems: kids }] : []
    })

    const folderHit = q && folder.title.toLowerCase().includes(q) && !tags.length
    if (folderHit && !items.length) { results.push({ folder, items: all }); continue }
    if (items.length) results.push({ folder, items })
  }
  return results
}

function renderBoard() {
  const board = $('board')
  const scroll = $('board-scroll').scrollTop
  board.replaceChildren()
  board.classList.remove('is-empty')

  const space = currentSpace(store.state)
  if (!space) return

  const filtering = Boolean(ui.search.trim()) || ui.activeTags.size > 0
  const entries = visibleFolders()

  // An empty board is one centred block with the action inside it. The dashed
  // "New folder" tile is a column item, so appending it under a column-spanning
  // empty state dropped it into the first column alone -- a narrow box hanging
  // off the left under centred text. It only reads correctly once there are
  // folders for it to sit at the end of.
  if (!entries.length) {
    board.classList.add('is-empty')
    board.append(emptyBoard(filtering))
    laidOutAt = boardMetrics().inner
    $('board-scroll').scrollTop = scroll
    return
  }

  const cards = entries.map(({ folder, items }) => renderFolder(folder, items))

  if (!filtering) {
    const add = el('button.add-folder', { title: 'Add another folder' })
    add.append(icon('plus', { size: 16 }), el('span', { text: 'New folder' }))
    add.addEventListener('click', addFolder)
    cards.push(add)
  }

  layoutBoard(cards)

  // Supplementary semantic results when searching by text.
  const q = ui.search.trim()
  if (q) {
    const shownIds = new Set()
    for (const { items } of entries) {
      for (const item of items) {
        shownIds.add(item.id)
        if (isGroup(item)) for (const c of item.groupItems ?? []) shownIds.add(c.id)
      }
    }
    const semantic = semanticSearch(searchIndex, q, { tempEntries, limit: 20 })
      .filter((r) => !shownIds.has(r.item.id))
    if (semantic.length) {
      board.append(renderSemanticSection(semantic))
    }
  }

  $('board-scroll').scrollTop = scroll
}

/**
 * Render a supplementary section of semantic search results.
 *
 * Shown below the keyword-matched folders when searching — items the keyword
 * filter missed but the token-based engine considers relevant.
 */
function renderSemanticSection(results) {
  const section = el('div.semantic-section')

  const heading = el('div.semantic-section__head', {}, [
    icon('search', { size: 15 }),
    el('span', { text: `Related results (${results.length})` }),
  ])
  section.append(heading)

  const list = el('div.semantic-section__list')
  for (const { item, folder, space, matchedFields } of results) {
    const title = item.title || item.url || 'Untitled'
    const sub = [hostnameOf(item.url ?? ''), folder?.title, space?.name]
      .filter(Boolean)
      .join(' \u00b7 ')

    const badge = matchedFields.length
      ? el('span.semantic-section__badge', { text: matchedFields[0] })
      : null

    const row = el('a.semantic-section__item', {
      href: item.url || '#',
      title: `${title}\nMatched: ${matchedFields.join(', ')}`,
    }, [
      faviconEl({ url: item.url ?? '', favicon: item.favicon, title }),
      el('div.semantic-section__body', {}, [
        el('div.semantic-section__title', { text: title }),
        el('div.semantic-section__sub', { text: sub }),
      ]),
      badge,
    ])

    row.addEventListener('click', (e) => {
      e.preventDefault()
      if (item.url) chrome.tabs.create({ url: item.url })
    })

    list.append(row)
  }

  section.append(list)
  return section
}

/** Narrowest a folder is allowed to get before the board drops a column. */
const BOARD_COL_MIN = 258

/** Board width the current column layout was computed for. */
let laidOutAt = 0

function boardMetrics() {
  const board = $('board')
  const style = board.ownerDocument.defaultView?.getComputedStyle(board) ?? null
  const gap = parseFloat(style?.getPropertyValue('--board-gap')) || 12
  const pad = (parseFloat(style?.paddingLeft) || 0) + (parseFloat(style?.paddingRight) || 0)
  return { gap, inner: (board.clientWidth || 0) - pad }
}

/**
 * Deal the folder cards into columns, shortest column first.
 *
 * CSS `column-width` did this for free but balanced across every column the
 * width allowed, so five folders on a wide window with the sidebar hidden left
 * two empty columns of dead space down the right-hand side. Here the column
 * count is capped by the number of cards, so the board never reserves room for
 * folders that do not exist.
 */
function layoutBoard(cards) {
  const board = $('board')
  const { gap, inner } = boardMetrics()
  laidOutAt = inner

  const fits = Math.floor((inner + gap) / (BOARD_COL_MIN + gap))
  const count = Math.max(1, Math.min(fits > 0 ? fits : 1, cards.length))

  const columns = Array.from({ length: count }, () => el('div.board__col'))
  board.append(...columns)

  if (count === 1) {
    columns[0].append(...cards)
    return
  }

  // Measure first, at the width the cards will actually be: the columns are
  // `flex: 1 1 0`, so parking every card in the first one still lays them out
  // at their final width. One reflow, then the real distribution.
  columns[0].append(...cards)
  const heights = cards.map((card) => card.offsetHeight)
  columns[0].replaceChildren()

  const filled = new Array(count).fill(0)
  for (const [i, card] of cards.entries()) {
    let shortest = 0
    for (let c = 1; c < count; c += 1) if (filled[c] < filled[shortest]) shortest = c
    columns[shortest].append(card)
    filled[shortest] += heights[i] + gap
  }
}

/**
 * The board with nothing on it: icon, one line of guidance, one obvious action.
 *
 * Filtering and genuinely-empty are different situations and get different
 * wording -- offering "New folder" to somebody whose search simply missed would
 * be answering a question they did not ask.
 */
function emptyBoard(filtering) {
  if (filtering) {
    const clear = el('button.btn.btn--quiet', { text: 'Clear filters' })
    clear.addEventListener('click', () => {
      ui.search = ''
      ui.activeTags.clear()
      $('search').value = ''
      renderTagbar()
      renderBoard()
      renderCanvas()
    })
    return el('div.empty-state', {}, [
      icon('search', { size: 28, stroke: 1.4, className: 'empty-state__icon' }),
      el('h2.empty-state__title', { text: 'No matches' }),
      el('p.empty-state__body', { text: 'Nothing here matches that search or those tags.' }),
      el('div.empty-state__actions', {}, [clear]),
    ])
  }

  const add = el('button.btn.btn--primary', { text: 'New folder' })
  add.addEventListener('click', addFolder)

  return el('div.empty-state', {}, [
    icon('folder', { size: 28, stroke: 1.4, className: 'empty-state__icon' }),
    el('h2.empty-state__title', { text: 'This space is empty' }),
    el('p.empty-state__body', {
      text: 'Make a folder, then drag tabs into it from the sidebar on the left.',
    }),
    el('div.empty-state__actions', {}, [add]),
  ])
}

async function addFolder() {
  const space = currentSpace(store.state)
  if (!space) return
  const title = await ask({
    title: 'New folder',
    label: 'Name',
    placeholder: 'e.g. Reading list',
    confirmLabel: 'Create',
    validate: (v) => (v ? null : 'Give the folder a name.'),
  })
  if (title) store.dispatch('addFolder', { spaceId: space.id, title })
}

function renderFolder(folder, items) {
  const node = el(`div.folder${folder.collapsed ? '.is-collapsed' : ''}`)
  node.style.setProperty('--folder-color', folder.color)

  const caret = el('button.icon-btn.icon-btn--sm.folder__caret', {
    title: folder.collapsed ? 'Expand' : 'Collapse',
  })
  caret.append(icon('chevronDown', { size: 15 }))
  caret.addEventListener('click', (e) => {
    e.stopPropagation()
    store.dispatch('toggleFolderCollapsed', { folderId: folder.id })
  })

  const more = el('button.icon-btn.icon-btn--sm', { title: 'Folder options' })
  more.append(icon('more', { size: 15 }))
  more.addEventListener('click', (e) => { e.stopPropagation(); folderMenu(more, folder) })

  const head = el('div.folder__head', { draggable: true }, [
    caret,
    el('div.folder__heading', {}, [
      el('span.folder__title', { text: folder.title, dataset: { folderTitle: folder.id } }),
      folder.tags?.length
        ? el('div.folder__tags', {}, folder.tags.map((t) => el('span.folder__tag', {
          text: t,
          title: `Filter by "${t}"`,
          onclick: (e) => { e.stopPropagation(); toggleTag(t) },
        })))
        : null,
    ]),
    el('span.folder__count', { text: String(folder.items.length) }),
    more,
  ])

  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return
    renameInline(`[data-folder-title="${CSS.escape(folder.id)}"]`,
      (title) => store.dispatch('renameFolder', { folderId: folder.id, title }),
      () => findFolder(store.state, folder.id)?.folder.title ?? '')
  })
  head.addEventListener('contextmenu', (e) => { e.preventDefault(); folderMenu(e, folder) })
  head.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'copyMove'
    e.dataTransfer.setData('application/x-tabspace', JSON.stringify({ kind: 'folder', folderId: folder.id }))
    setDragGhost(e, folder.title)
    node.classList.add('is-dragging')
  })
  head.addEventListener('dragend', () => { node.classList.remove('is-dragging'); clearDropTargets() })

  const body = el('div.folder__body')
  if (!items.length) {
    body.append(el('div.folder__empty', { text: 'Drop tabs here →' }))
  } else {
    for (const item of items) {
      body.append(isGroup(item) ? renderGroup(item, folder) : renderItem(item, folder))
    }
  }

  node.append(head, body)
  wireFolderDrop(node, folder)
  return node
}

function renderGroup(group, folder) {
  const node = el(`div.group${group.collapsed ? '.is-collapsed' : ''}`)

  const caret = el('button.icon-btn.icon-btn--sm.group__caret')
  caret.append(icon('chevronDown', { size: 13 }))
  caret.addEventListener('click', (e) => {
    e.stopPropagation()
    store.dispatch('toggleGroupCollapsed', { groupId: group.id })
  })

  const more = el('button.icon-btn.icon-btn--sm.item__action', { title: 'Group options' })
  more.append(icon('more', { size: 14 }))
  more.addEventListener('click', (e) => { e.stopPropagation(); groupMenu(more, group, folder) })

  const head = el('div.group__head', { draggable: true }, [
    caret,
    el('span.group__title', { text: group.title, dataset: { groupTitle: group.id } }),
    el('span.group__count', { text: String(group.groupItems.length) }),
    more,
  ])

  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return
    renameInline(`[data-group-title="${CSS.escape(group.id)}"]`,
      (title) => store.dispatch('renameGroup', { groupId: group.id, title }),
      () => findGroup(store.state, group.id)?.group.title ?? '')
  })
  head.addEventListener('contextmenu', (e) => { e.preventDefault(); groupMenu(e, group, folder) })
  head.addEventListener('dragstart', (e) => {
    e.stopPropagation()
    e.dataTransfer.effectAllowed = 'copyMove'
    e.dataTransfer.setData('application/x-tabspace', JSON.stringify({ kind: 'item', itemId: group.id }))
    setDragGhost(e, group.title)
  })

  const body = el('div.group__body')
  if (!group.groupItems.length) {
    body.append(el('div.folder__empty', { text: 'Drop bookmarks here' }))
  } else {
    for (const child of [...group.groupItems].sort(bySortPosition)) {
      body.append(renderItem(child, folder, group))
    }
  }

  node.append(head, body)

  node.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.stopPropagation()
    node.classList.add('is-drop-target')
  })
  node.addEventListener('dragleave', (e) => {
    if (!node.contains(e.relatedTarget)) node.classList.remove('is-drop-target')
  })
  node.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    clearDropTargets()
    const data = readDrag(e)
    if (!data) return

    if (data.kind === 'tabs') {
      for (const tab of data.payload) {
        const itemId = store.dispatch('addItem', {
          folderId: folder.id,
          groupId: group.id,
          item: { title: tab.title, url: tab.url, favicon: tab.favicon ?? '' },
        })
        if (itemId) autoTag({ store, itemId, title: tab.title, url: tab.url, folder: group.title })
      }
      ui.selectedTabIds.clear()
      toast(`Saved into "${group.title}"`, undoAction())
      return
    }
    if (data.kind === 'item' && data.itemId !== group.id) {
      store.dispatch('moveItem', { itemId: data.itemId, folderId: folder.id, groupId: group.id })
    }
  })

  return node
}

function renderItem(item, folder, group = null) {
  if (item.type === 'note') {
    const note = el('div.item.item--note', { text: item.title })
    note.addEventListener('dblclick', async () => {
      const text = await ask({ title: 'Edit note', value: item.title, multiline: true })
      if (text !== null) store.dispatch('updateItem', { itemId: item.id, patch: { title: text } })
    })
    note.addEventListener('contextmenu', (e) => { e.preventDefault(); itemMenu(e, item, folder, group) })
    return note
  }

  const more = el('button.icon-btn.icon-btn--sm.item__action', { title: 'Options' })
  more.append(icon('more', { size: 14 }))
  more.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); itemMenu(more, item, folder, group) })

  // Tabs currently showing this bookmark, in any window. When there are some,
  // the row is marked live and gets a close button of its own so a page can be
  // shut from the board -- which closes the tab and leaves the bookmark alone.
  const liveIds = liveTabs.get(normaliseUrl(item.url ?? '')) ?? []
  const close = liveIds.length
    ? el('button.icon-btn.icon-btn--sm.item__close', {
      title: liveIds.length > 1
        ? `Close ${liveIds.length} open tabs — the bookmark stays here`
        : 'Close this tab — the bookmark stays here',
    })
    : null
  if (close) {
    close.append(icon('close', { size: 13 }))
    close.addEventListener('click', async (e) => {
      e.preventDefault()
      e.stopPropagation()
      await chrome.tabs.remove(liveIds)
      await refreshTabs()
      renderTabs()
      renderBoard()
    })
  }

  const imp = computePermanentImportance(item)
  const impBadge = imp === 'high'
    ? el('span.item__importance', { title: 'High importance' })
    : null

  const node = el(`a.item${liveIds.length ? '.is-open' : ''}`, {
    // Sanitised so a middle-click cannot follow a hostile scheme either.
    href: safeUrl(item.url) || '#',
    draggable: true,
    title: `${item.title}\n${item.url}${liveIds.length ? '\nOpen in a tab right now' : ''}`,
  }, [
    faviconEl(item, true),
    el('div.item__body', {}, [
      el('div.item__title', {}, [
        el('span', { text: item.title }),
        impBadge,
      ]),
      item.tags?.length
        ? el('div.item__tags', {}, item.tags.map((t) => el('span.item__tag', {
          text: t,
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleTag(t) },
        })))
        : null,
    ]),
    close,
    more,
  ])

  node.classList.toggle('is-selected', ui.selectedItemIds.has(item.id))

  node.addEventListener('click', (e) => {
    e.preventDefault()
    // Shift-click selects rather than opens, so several can be grouped at once.
    if (e.shiftKey) {
      ui.selectedItemIds.has(item.id)
        ? ui.selectedItemIds.delete(item.id)
        : ui.selectedItemIds.add(item.id)
      renderBoard()
      return
    }
    ui.selectedItemIds.clear()
    const newTab = store.state.settings.openInNewTab !== (e.ctrlKey || e.metaKey)
    openUrl(item.url, { newTab })
  })
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); itemMenu(e, item, folder, group) })
  node.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'copyMove'
    e.dataTransfer.setData('application/x-tabspace', JSON.stringify({ kind: 'item', itemId: item.id }))
    setDragGhost(e, item.title)
  })
  node.addEventListener('dragend', clearDropTargets)
  return node
}

/**
 * Open a saved bookmark. Every navigation out of the board goes through here so
 * the scheme is checked in exactly one place -- an imported bookmark pointing
 * at `javascript:` must fail loudly rather than quietly doing nothing.
 */
function openUrl(url, { newTab = true, active = true } = {}) {
  const target = safeUrl(url)
  if (!target) {
    toast('That bookmark does not point at a web page, so it was not opened')
    return false
  }
  if (newTab) chrome.tabs.create({ url: target, active })
  else chrome.tabs.update({ url: target })
  return true
}

/** Shared inline-rename behaviour for folder and group titles. */
function renameInline(selector, commitFn, originalFn) {
  const span = document.querySelector(selector)
  if (!span) return
  span.contentEditable = 'true'
  span.focus()

  const range = document.createRange()
  range.selectNodeContents(span)
  getSelection().removeAllRanges()
  getSelection().addRange(range)

  const commit = () => {
    span.contentEditable = 'false'
    const title = span.textContent.trim()
    if (title) commitFn(title)
    else renderBoard()
  }
  span.addEventListener('blur', commit, { once: true })
  span.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') { e.preventDefault(); span.blur() }
    if (e.key === 'Escape') { span.textContent = originalFn(); span.blur() }
  })
}

// ========================================================= sticker canvas ===

function renderCanvas() {
  const canvas = $('canvas')
  canvas.replaceChildren()
  $('board-wrap').style.minHeight = ''
  const space = currentSpace(store.state)
  if (!space) return
  // While filtering, floating notes on top of a result set is just noise.
  if (ui.search.trim() || ui.activeTags.size) return

  for (const sticker of space.widgets ?? []) canvas.append(renderSticker(sticker))
  keepNotesInView()
  fitCanvasHeight()
}

/**
 * Pull any note that now hangs off the right-hand edge back into view.
 *
 * A note's position is stored in board coordinates, so one written with the
 * sidebar hidden and parked on the right of the board vanished the moment the
 * sidebar came back and the board narrowed under it. Only the *rendered*
 * position is clamped -- the stored one is left as the user set it, so widening
 * the board again returns the note to exactly where they put it.
 */
function keepNotesInView() {
  const width = $('board-wrap').clientWidth
  if (!width) return
  for (const node of $('canvas').children) {
    const limit = Math.max(NOTE_MARGIN, width - node.offsetWidth - NOTE_MARGIN)
    if ((parseFloat(node.style.left) || 0) > limit) node.style.left = `${limit}px`
  }
}

/**
 * Grow the board so notes sitting below the folders can be scrolled to. The
 * canvas is an overlay pinned to the board, so on its own it never adds the
 * height a note parked past the last folder needs.
 */
function fitCanvasHeight() {
  const wrap = $('board-wrap')
  let lowest = 0
  for (const node of $('canvas').children) {
    lowest = Math.max(lowest, node.offsetTop + node.offsetHeight)
  }
  // Clearance, not margin: the floating New folder / New note buttons hover over
  // the bottom of the board, and a note that stops exactly at the last scrollable
  // pixel would sit underneath them.
  const clearance = 72
  if (lowest + clearance > wrap.clientHeight) wrap.style.minHeight = `${lowest + clearance}px`
}

function renderSticker(sticker) {
  const node = el(`div.sticker${sticker.strikethrough ? '.is-struck' : ''}`, {
    dataset: { stickerId: sticker.id },
    style: {
      left: `${sticker.x}px`,
      top: `${sticker.y}px`,
      background: sticker.color,
      fontSize: `${sticker.fontSize}px`,
    },
  })

  if (sticker.text) node.append(document.createTextNode(sticker.text))
  else node.append(el('span.sticker__placeholder', { text: 'Double-click to write' }))

  const more = el('button.icon-btn.sticker__menu', { title: 'Colour, size, delete' })
  more.append(icon('more', { size: 14 }))
  more.addEventListener('click', (e) => { e.stopPropagation(); stickerMenu(more, sticker) })
  more.addEventListener('pointerdown', (e) => e.stopPropagation())
  node.append(more)

  node.addEventListener('dblclick', (e) => { e.stopPropagation(); editSticker(node, sticker) })
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); stickerMenu(e, sticker) })
  node.addEventListener('pointerdown', (e) => startStickerDrag(e, node, sticker))
  return node
}

function editSticker(node, sticker) {
  node.textContent = sticker.text
  node.contentEditable = 'true'
  node.focus()

  const range = document.createRange()
  range.selectNodeContents(node)
  getSelection().removeAllRanges()
  getSelection().addRange(range)

  const commit = () => {
    node.contentEditable = 'false'
    // innerText, not textContent: Enter becomes <div>/<br> in a contenteditable
    // and textContent would silently flatten the note into one line.
    const text = node.innerText
      .replace(/ /g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()
    if (text !== sticker.text) store.dispatch('updateSticker', { stickerId: sticker.id, patch: { text } })
    else renderCanvas()
  }

  node.addEventListener('blur', commit, { once: true })
  node.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') { node.textContent = sticker.text; node.blur() }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); node.blur() }
  })
  node.addEventListener('paste', (e) => {
    e.preventDefault()
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
  })
}

function startStickerDrag(e, node, sticker) {
  if (node.isContentEditable || e.button !== 0) return
  e.preventDefault()

  const wrap = $('board-wrap')
  const origin = wrap.getBoundingClientRect()
  const grabX = e.clientX - origin.left - sticker.x
  const grabY = e.clientY - origin.top - sticker.y
  let x = sticker.x
  let y = sticker.y
  let moved = false

  node.classList.add('is-dragging')
  node.setPointerCapture(e.pointerId)

  const onMove = (ev) => {
    const rect = wrap.getBoundingClientRect()
    // Never past the right-hand edge: a note dropped out there is a note the
    // next narrower board would swallow.
    const limit = Math.max(0, rect.width - node.offsetWidth)
    x = Math.min(limit, Math.max(0, ev.clientX - rect.left - grabX))
    y = Math.max(0, ev.clientY - rect.top - grabY)
    if (Math.abs(x - sticker.x) > 2 || Math.abs(y - sticker.y) > 2) moved = true
    node.style.left = `${x}px`
    node.style.top = `${y}px`
  }

  const onUp = () => {
    node.removeEventListener('pointermove', onMove)
    node.classList.remove('is-dragging')
    if (moved) store.dispatch('moveSticker', { stickerId: sticker.id, x, y })
  }

  node.addEventListener('pointermove', onMove)
  node.addEventListener('pointerup', onUp, { once: true })
  node.addEventListener('pointercancel', onUp, { once: true })
}

function stickerMenu(anchor, sticker) {
  menu(anchor, [
    { label: 'Edit text', iconName: 'note', onClick: () => {
      const node = document.querySelector(`[data-sticker-id="${CSS.escape(sticker.id)}"]`)
      if (node) editSticker(node, sticker)
    } },
    { label: sticker.strikethrough ? 'Remove strikethrough' : 'Strikethrough', iconName: 'check', onClick: () =>
      store.dispatch('updateSticker', { stickerId: sticker.id, patch: { strikethrough: !sticker.strikethrough } }) },
    { heading: 'Size' },
    { choices: STICKER_SIZES.map((s) => ({ value: s, label: `${s}` })), value: sticker.fontSize,
      onPick: (fontSize) => store.dispatch('updateSticker', { stickerId: sticker.id, patch: { fontSize } }) },
    { heading: 'Colour' },
    { swatches: STICKER_COLORS, value: sticker.color,
      onPick: (color) => store.dispatch('updateSticker', { stickerId: sticker.id, patch: { color } }) },
    { separator: true },
    { label: 'Delete note', iconName: 'trash', tone: 'danger', onClick: () => {
      store.dispatch('deleteSticker', { stickerId: sticker.id })
      toast('Note deleted', undoAction())
    } },
  ])
}

/** Breathing room kept around a note, and the size of an empty one. */
const NOTE_MARGIN = 18
const NOTE_W = 216   // .sticker is 12em wide at the default 18px note size
const NOTE_H = 126

function createStickerAt(clientX, clientY) {
  const rect = $('board-wrap').getBoundingClientRect()
  createSticker({
    x: Math.max(0, clientX - rect.left - 60),
    y: Math.max(0, clientY - rect.top - 20),
  })
}

function createSticker({ x, y }) {
  const space = currentSpace(store.state)
  if (!space) return
  const id = store.dispatch('addSticker', { spaceId: space.id, sticker: { x, y } })
  requestAnimationFrame(() => {
    const node = document.querySelector(`[data-sticker-id="${CSS.escape(id)}"]`)
    const sticker = currentSpace(store.state).widgets.find((w) => w.id === id)
    if (!node || !sticker) return
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    editSticker(node, sticker)
  })
}

/** The bottom edge of the lowest card on the board, in board coordinates. */
function foldersBottom() {
  const top = $('board-wrap').getBoundingClientRect().top
  let bottom = 0
  for (const card of $('board').querySelectorAll('.folder, .add-folder, .empty-state')) {
    bottom = Math.max(bottom, card.getBoundingClientRect().bottom - top)
  }
  return bottom
}

/**
 * Where a new note should go: the open band under the folders, filled left to
 * right and wrapping onto a new row when that one is full.
 *
 * The button used to drop every note at a fixed spot near the top left, which
 * put it on top of the first folder and, on a narrow board, out of sight
 * entirely. Notes now start somewhere actually empty and never land on one
 * another.
 */
function freeNoteSpot() {
  const width = $('board-wrap').clientWidth || NOTE_W + NOTE_MARGIN * 2
  const taken = [...$('canvas').children].map((n) => ({
    x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight,
  }))
  const clear = (x, y) => !taken.some((t) =>
    x < t.x + t.w + NOTE_MARGIN && x + NOTE_W + NOTE_MARGIN > t.x
    && y < t.y + t.h + NOTE_MARGIN && y + NOTE_H + NOTE_MARGIN > t.y)

  const first = Math.max(NOTE_MARGIN, foldersBottom() + NOTE_MARGIN)
  const lastX = Math.max(NOTE_MARGIN, width - NOTE_W - NOTE_MARGIN)

  for (let row = 0; row < 40; row += 1) {
    const y = first + row * (NOTE_H + NOTE_MARGIN)
    for (let x = NOTE_MARGIN; x <= lastX; x += NOTE_W + NOTE_MARGIN) {
      if (clear(x, y)) return { x, y }
    }
  }
  return { x: NOTE_MARGIN, y: first }
}

// ========================================================== drag and drop ===

function readDrag(e) {
  const raw = e.dataTransfer.getData('application/x-tabspace')
  if (raw) { try { return JSON.parse(raw) } catch { /* fall through */ } }
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
  if (url && /^https?:/i.test(url.trim())) {
    return { kind: 'tabs', payload: [{ title: url.trim(), url: url.trim() }] }
  }
  return null
}

function wireFolderDrop(node, folder) {
  node.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    node.classList.add('is-drop-target')
  })
  node.addEventListener('dragleave', (e) => {
    if (!node.contains(e.relatedTarget)) node.classList.remove('is-drop-target')
  })
  node.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    clearDropTargets()
    const data = readDrag(e)
    if (!data) return

    if (data.kind === 'tabs') {
      const target = findFolder(store.state, folder.id)
      let position = nextPosition(target?.folder.items ?? [])
      for (const tab of data.payload) {
        const itemId = store.dispatch('addItem', {
          folderId: folder.id,
          item: { title: tab.title, url: tab.url, favicon: tab.favicon ?? '' },
          position,
        })
        position += 1000
        if (itemId) autoTag({ store, itemId, title: tab.title, url: tab.url, folder: folder.title })
      }
      ui.selectedTabIds.clear()
      toast(`Saved ${data.payload.length} tab${data.payload.length === 1 ? '' : 's'}`, undoAction())
      return
    }

    if (data.kind === 'item') {
      const live = findFolder(store.state, folder.id)?.folder
      if (!live) return
      store.dispatch('moveItem', {
        itemId: data.itemId,
        folderId: folder.id,
        position: itemDropIndex(e, node, live),
      })
      return
    }

    if (data.kind === 'folder' && data.folderId !== folder.id) {
      const space = currentSpace(store.state)
      const sorted = [...space.folders].sort(bySortPosition)
      const at = sorted.findIndex((f) => f.id === folder.id)
      store.dispatch('moveFolder', {
        folderId: data.folderId,
        spaceId: space.id,
        position: positionBetween(sorted[at - 1] ?? null, sorted[at]),
      })
    }
  })
}

/** Where in the folder an item was dropped, so ordering feels right. */
function itemDropIndex(e, node, folder) {
  const body = node.querySelector('.folder__body')
  const rows = body ? [...body.children].filter((n) => n.matches('.item, .group')) : []
  const sorted = [...folder.items].sort(bySortPosition)
  for (let i = 0; i < rows.length; i += 1) {
    const rect = rows[i].getBoundingClientRect()
    if (e.clientY < rect.top + rect.height / 2) {
      return positionBetween(sorted[i - 1] ?? null, sorted[i] ?? null)
    }
  }
  return nextPosition(folder.items)
}

function clearDropTargets() {
  for (const n of document.querySelectorAll('.is-drop-target')) n.classList.remove('is-drop-target')
}

// ================================================================== menus ===

function folderMenu(anchor, folder) {
  const selected = selectedIn(folder)
  menu(anchor, [
    { label: 'Rename', iconName: 'note', onClick: () => renameInline(
      `[data-folder-title="${CSS.escape(folder.id)}"]`,
      (title) => store.dispatch('renameFolder', { folderId: folder.id, title }),
      () => findFolder(store.state, folder.id)?.folder.title ?? '') },
    { label: folder.collapsed ? 'Expand' : 'Collapse', iconName: folder.collapsed ? 'chevronDown' : 'chevronRight',
      onClick: () => store.dispatch('toggleFolderCollapsed', { folderId: folder.id }) },
    { label: 'Open all bookmarks', iconName: 'layers', onClick: () => {
      for (const item of folder.items) {
        if (isGroup(item)) for (const c of item.groupItems) { if (c.url) openUrl(c.url, { active: false }) }
        else if (item.url) openUrl(item.url, { active: false })
      }
    } },
    { label: 'Tags', iconName: 'tag', onClick: () => folderTagDialog(folder) },
    { separator: true },
    { label: 'Add note', iconName: 'note', onClick: async () => {
      const text = await ask({ title: 'New note', label: 'Text', multiline: true, confirmLabel: 'Add' })
      if (text) store.dispatch('addItem', { folderId: folder.id, item: { type: 'note', title: text } })
    } },
    { label: 'New empty group', iconName: 'folder', onClick: async () => {
      const title = await ask({ title: 'New group', label: 'Name', placeholder: 'e.g. Docs', confirmLabel: 'Create',
        validate: (v) => (v ? null : 'Give the group a name.') })
      if (title) store.dispatch('createGroup', { folderId: folder.id, itemIds: [], title })
    } },
    selected.length ? { label: `Group ${selected.length} selected`, iconName: 'layers',
      onClick: () => groupSelected(folder) } : null,
    { label: 'Duplicate folder', iconName: 'copy', onClick: () => {
      store.dispatch('duplicateFolder', { folderId: folder.id })
      toast('Folder duplicated', undoAction())
    } },
    { heading: 'Colour' },
    { swatches: FOLDER_COLORS, value: folder.color,
      onPick: (color) => store.dispatch('setFolderColor', { folderId: folder.id, color }) },
    { separator: true },
    { label: 'Delete folder', iconName: 'trash', tone: 'danger', onClick: async () => {
      const yes = await confirmAction({
        title: `Delete "${folder.title}"?`,
        subtitle: `${folder.items.length} item${folder.items.length === 1 ? '' : 's'} will be removed. You can undo straight after.`,
      })
      if (!yes) return
      store.dispatch('deleteFolder', { folderId: folder.id })
      toast(`Deleted "${folder.title}"`, undoAction())
    } },
  ])
}

function groupMenu(anchor, group, folder) {
  menu(anchor, [
    { label: 'Rename', iconName: 'note', onClick: () => renameInline(
      `[data-group-title="${CSS.escape(group.id)}"]`,
      (title) => store.dispatch('renameGroup', { groupId: group.id, title }),
      () => findGroup(store.state, group.id)?.group.title ?? '') },
    { label: group.collapsed ? 'Expand' : 'Collapse', iconName: group.collapsed ? 'chevronDown' : 'chevronRight',
      onClick: () => store.dispatch('toggleGroupCollapsed', { groupId: group.id }) },
    { label: 'Open all in this group', iconName: 'layers', onClick: () => {
      for (const item of group.groupItems) if (item.url) openUrl(item.url, { active: false })
    } },
    { separator: true },
    { label: 'Ungroup', iconName: 'undo', onClick: () => {
      store.dispatch('ungroup', { groupId: group.id })
      toast('Bookmarks moved back into the folder', undoAction())
    } },
    { label: 'Delete group', iconName: 'trash', tone: 'danger', onClick: async () => {
      const yes = await confirmAction({
        title: `Delete "${group.title}"?`,
        subtitle: 'Its bookmarks go too. Use Ungroup instead to keep them.',
      })
      if (!yes) return
      store.dispatch('deleteGroup', { groupId: group.id })
      toast(`Deleted "${group.title}"`, undoAction())
    } },
  ])
}

function itemMenu(anchor, item, folder, group = null) {
  const selected = selectedIn(folder)
  menu(anchor, [
    item.url ? { label: 'Open in new tab', iconName: 'plus', onClick: () => openUrl(item.url) } : null,
    item.url ? { label: 'Copy link', iconName: 'copy', onClick: () => {
      navigator.clipboard.writeText(item.url)
      toast('Link copied')
    } } : null,
    { label: 'Rename', iconName: 'note', onClick: async () => {
      const title = await ask({ title: 'Rename', label: 'Title', value: item.title,
        validate: (v) => (v ? null : 'Give it a title.') })
      if (title) store.dispatch('updateItem', { itemId: item.id, patch: { title } })
    } },
    item.type === 'bookmark' ? { label: 'Tags', iconName: 'tag', onClick: () => tagDialog(item) } : null,
    { separator: true },
    selected.length > 1
      ? { label: `Group ${selected.length} selected`, iconName: 'layers', onClick: () => groupSelected(folder) }
      : { label: 'Put in a new group', iconName: 'folder', onClick: async () => {
        const title = await ask({ title: 'New group', label: 'Name', value: '', confirmLabel: 'Create',
          validate: (v) => (v ? null : 'Give the group a name.') })
        if (title) store.dispatch('createGroup', { folderId: folder.id, itemIds: [item.id], title })
      } },
    group ? { label: 'Move out of group', iconName: 'undo',
      onClick: () => store.dispatch('moveItem', { itemId: item.id, folderId: folder.id }) } : null,
    { separator: true },
    { label: 'Delete', iconName: 'trash', tone: 'danger', onClick: () => {
      store.dispatch('deleteItem', { itemId: item.id })
      toast('Deleted', undoAction())
    } },
  ])
}

function selectedIn(folder) {
  const live = findFolder(store.state, folder.id)?.folder
  if (!live) return []
  return live.items.filter((i) => !isGroup(i) && ui.selectedItemIds.has(i.id)).map((i) => i.id)
}

async function groupSelected(folder) {
  const itemIds = selectedIn(folder)
  if (!itemIds.length) return toast('Shift-click some bookmarks first')
  const title = await ask({
    title: `Group ${itemIds.length} bookmarks`,
    label: 'Group name',
    confirmLabel: 'Create',
    validate: (v) => (v ? null : 'Give the group a name.'),
  })
  if (!title) return
  store.dispatch('createGroup', { folderId: folder.id, itemIds, title })
  ui.selectedItemIds.clear()
  toast(`Grouped ${itemIds.length} bookmarks`, undoAction())
}

// =================================================================== tags ===

function toggleTag(tag) {
  ui.activeTags.has(tag) ? ui.activeTags.delete(tag) : ui.activeTags.add(tag)
  renderTagbar()
  renderBoard()
  renderCanvas()
}

function renderTagbar() {
  const bar = $('tagbar')
  bar.replaceChildren()
  const tags = allTags(store.state)

  // A board with no tags on it gets no tag bar. It used to explain where tags
  // come from instead, which spent a strip of the window on a feature the
  // person was not using. The bar is hidden by `.tagbar:empty`.
  //
  // A hidden bar still comes back while a filter is on. Folder and bookmark tag
  // chips can switch a filter on from the board itself, and with the bar gone
  // there would be nothing left to switch it off with.
  if (!tags.length) return
  if (store.state.settings.hideTagbar && !ui.activeTags.size) return

  for (const { tag, count } of tags) {
    const chip = el(`button.chip${ui.activeTags.has(tag) ? '.is-active' : ''}`, {
      onclick: () => toggleTag(tag),
    }, [tag, el('span.chip__count', { text: String(count) })])
    bar.append(chip)
  }
  if (ui.activeTags.size) {
    const clear = el('button.chip', { onclick: () => { ui.activeTags.clear(); renderTagbar(); renderBoard(); renderCanvas() } })
    clear.append(icon('close', { size: 12 }), el('span', { text: 'Clear' }))
    bar.append(clear)
  }

  // Somebody who does not filter by tag should be able to have the strip back.
  // Settings turns it on again, and the toast says so, because a control that
  // hides itself is otherwise a one-way door.
  const hide = el('button.icon-btn.icon-btn--sm.tagbar__hide', { title: 'Hide the tag bar' })
  hide.append(icon('close', { size: 13 }))
  hide.addEventListener('click', () => {
    ui.activeTags.clear()
    store.dispatch('updateSettings', { patch: { hideTagbar: true } }, { undoable: false })
    toast('Tag bar hidden — turn it back on in Settings')
  })
  bar.append(el('span.spacer'), hide)
}

/** Tags for one bookmark. No cap — type as many as you like. */
function tagDialog(item) {
  const input = el('input.field', { type: 'text', placeholder: 'Type a tag, press Enter' })
  const chips = el('div.item__tags', { style: { marginBottom: '12px', gap: '6px' } })

  const redraw = () => {
    const fresh = findItem(store.state, item.id)?.item
    chips.replaceChildren(...(fresh?.tags ?? []).map((t) => {
      const chip = el('button.chip', { onclick: () => { store.dispatch('removeTag', { itemId: item.id, tag: t }); redraw() } })
      chip.append(el('span', { text: t }), icon('close', { size: 11 }))
      return chip
    }))
  }
  redraw()

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const value = input.value.trim()
    if (!value) return
    for (const tag of value.split(',')) store.dispatch('addTag', { itemId: item.id, tag })
    input.value = ''
    redraw()
  })

  const existing = allTags(store.state).slice(0, 24)
  const suggestions = existing.length
    ? el('div', {}, [
      el('div.field__label', { text: 'Existing tags', style: { marginTop: '14px' } }),
      el('div.item__tags', {}, existing.map(({ tag }) => el('button.chip', {
        text: tag,
        onclick: () => { store.dispatch('addTag', { itemId: item.id, tag }); redraw() },
      }))),
    ])
    : null

  dialog({
    title: 'Tags',
    subtitle: item.title,
    body: [chips, input, suggestions],
    actions: [{ label: 'Done', tone: 'primary', onClick: dismissLayer }],
  })
  requestAnimationFrame(() => input.focus())
}

/**
 * Tags for a whole folder. Filtering by one of these shows the entire folder,
 * so it is the right tool for "everything in here is work" rather than tagging
 * each bookmark individually.
 */
function folderTagDialog(folder) {
  const input = el('input.field', { type: 'text', placeholder: 'Type a tag, press Enter' })
  const chips = el('div.item__tags', { style: { marginBottom: '12px', gap: '6px' } })

  const redraw = () => {
    const fresh = findFolder(store.state, folder.id)?.folder
    chips.replaceChildren(...(fresh?.tags ?? []).map((t) => {
      const chip = el('button.chip', {
        onclick: () => { store.dispatch('removeFolderTag', { folderId: folder.id, tag: t }); redraw() },
      })
      chip.append(el('span', { text: t }), icon('close', { size: 11 }))
      return chip
    }))
  }
  redraw()

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const value = input.value.trim()
    if (!value) return
    for (const tag of value.split(',')) store.dispatch('addFolderTag', { folderId: folder.id, tag })
    input.value = ''
    redraw()
  })

  const existing = allTags(store.state).slice(0, 24)
  const suggestions = existing.length
    ? el('div', {}, [
      el('div.field__label', { text: 'Existing tags', style: { marginTop: '14px' } }),
      el('div.item__tags', {}, existing.map(({ tag }) => el('button.chip', {
        text: tag,
        onclick: () => { store.dispatch('addFolderTag', { folderId: folder.id, tag }); redraw() },
      }))),
    ])
    : null

  dialog({
    title: 'Folder tags',
    subtitle: `${folder.title} — filtering by one of these shows the whole folder.`,
    body: [chips, input, suggestions],
    actions: [{ label: 'Done', tone: 'primary', onClick: dismissLayer }],
  })
  requestAnimationFrame(() => input.focus())
}

function tagManagerDialog() {
  const body = el('div')

  const redraw = () => {
    const tags = allTags(store.state)
    if (!tags.length) {
      body.replaceChildren(el('p.setting__desc', { text: 'No tags yet. Add one from the options menu on any bookmark or folder.' }))
      return
    }
    body.replaceChildren(...tags.map(({ tag, count }) => {
      const rename = el('button.btn.btn--quiet.btn--sm', { text: 'Rename' })
      rename.addEventListener('click', async () => {
        const to = await ask({ title: `Rename "${tag}"`, subtitle: 'Renames it on every bookmark.', label: 'New name', value: tag })
        if (to) { store.dispatch('renameTagEverywhere', { from: tag, to }); redraw() }
      })

      const del = el('button.icon-btn.icon-btn--sm', { title: 'Delete tag' })
      del.append(icon('trash', { size: 14 }))
      del.addEventListener('click', async () => {
        const yes = await confirmAction({
          title: `Remove "${tag}"?`,
          subtitle: `It will be taken off ${count} bookmark${count === 1 ? '' : 's'}. The bookmarks stay.`,
          confirmLabel: 'Remove tag',
        })
        if (yes) { store.dispatch('deleteTagEverywhere', { tag }); redraw() }
      })

      return el('div.setting', {}, [
        el('div.setting__body', {}, [
          el('div.setting__title', { text: tag }),
          el('div.setting__desc', { text: `used ${count} time${count === 1 ? '' : 's'}` }),
        ]),
        el('div.setting__control', {}, [rename, del]),
      ])
    }))
  }
  redraw()

  dialog({
    title: 'All tags',
    subtitle: 'Rename or remove a tag across every bookmark.',
    body,
    actions: [{ label: 'Done', tone: 'primary', onClick: dismissLayer }],
  })
}

// =============================================================== settings ===

function settingRow(title, desc, control) {
  return el('div.setting', {}, [
    el('div.setting__body', {}, [
      el('div.setting__title', { text: title }),
      desc ? el('div.setting__desc', { text: desc }) : null,
    ]),
    el('div.setting__control', {}, [].concat(control)),
  ])
}

function toggleControl(checked, onChange) {
  const input = el('input', { type: 'checkbox', checked })
  input.addEventListener('change', (e) => onChange(e.target.checked))
  return el('label.switch', {}, [input, el('span.switch__track')])
}

async function settingsDialog() {
  const s = store.state.settings
  const sync = store.sync.describe()
  const mimo = await readMimoConfig()
  const routineLog = await readRoutineStore()

  const quietBtn = (label, onClick) => {
    const b = el('button.btn.btn--quiet.btn--sm', { text: label })
    b.addEventListener('click', onClick)
    return b
  }

  const body = el('div', {}, [
    accountSetting(),

    ...mimoSettingRows({
      config: mimo,
      settingRow,
      toggleControl,
      toast,
      onKeySaved: () => newsPanel?.refresh({ force: true }),
      onRefresh: () => {
        dismissLayer()
        store.dispatch('updateSettings', { patch: { sidebarCollapsed: false, sidebarView: 'news' } }, { undoable: false })
        newsPanel?.refresh({ force: true })
      },
    }),

    ...routineSettingRows(routineLog),

    settingRow('Font', 'Inter and Manrope ship with the extension, so they look the same everywhere.',
      dropdown({
        value: s.fontFamily ?? 'inter',
        choices: [
          { value: 'inter', label: 'Inter' },
          { value: 'manrope', label: 'Manrope' },
          { value: 'system', label: 'System' },
        ],
        onChange: (v) => store.dispatch('updateSettings', { patch: { fontFamily: v } }),
      })),

    settingRow('Open bookmarks in a new tab', 'Ctrl/Cmd-click always does the opposite.',
      toggleControl(s.openInNewTab, (v) => store.dispatch('updateSettings', { patch: { openInNewTab: v } }))),

    settingRow('Hide pinned tabs', 'Keep pinned tabs out of the sidebar list.',
      toggleControl(s.hidePinnedTabs, async (v) => {
        store.dispatch('updateSettings', { patch: { hidePinnedTabs: v } })
        await refreshTabs()
        renderTabs()
      })),

    settingRow('Chrome profile sync', syncDescription(sync),
      toggleControl(s.syncEnabled !== false, (v) => store.setSyncEnabled(v))),

    settingRow('This board', boardSummary(), []),

    settingRow('Show the tag bar', 'The strip of tag filters under the top bar. It only appears once something is tagged.',
      toggleControl(s.hideTagbar !== true, (v) => {
        store.dispatch('updateSettings', { patch: { hideTagbar: !v } }, { undoable: false })
      })),

    settingRow('Tags', 'Rename or delete a tag across every bookmark.',
      quietBtn('Manage tags', () => { dismissLayer(); tagManagerDialog() })),

    settingRow('Look up missing icons online',
      'Sites like Notion, Grok and v0 serve their icon from a build-hashed path that 404s after a deploy, and Chrome only caches icons for pages you have visited. When both fail, Google’s and DuckDuckGo’s icon services are asked — which means the site’s domain (never the full URL) is sent to them. Turn this off to keep everything local, at the cost of some blank icons.',
      toggleControl(s.onlineFavicons !== false, (v) => {
        store.dispatch('updateSettings', { patch: { onlineFavicons: v } })
        setOnlineIcons(v)
        forgetFavicons()
        renderAll()
      })),

    settingRow('Refresh all icons',
      'Re-resolves every icon from scratch, and clears stored icon URLs in this space so stale ones cannot win.',
      quietBtn('Refresh icons', () => {
        const n = store.dispatch('repairFavicons', { spaceId: currentSpace(store.state)?.id })
        forgetFavicons()
        renderAll()
        toast(n ? `Re-resolving ${n} icon${n === 1 ? '' : 's'}` : 'Icons refreshed')
      })),

    settingRow('Remove duplicate bookmarks', 'Finds repeated URLs in the current space and keeps the first.',
      quietBtn('Find duplicates', () => {
        const n = store.dispatch('removeDuplicateBookmarks', { spaceId: currentSpace(store.state)?.id })
        toast(n ? `Removed ${n} duplicate${n === 1 ? '' : 's'}` : 'No duplicates found', n ? undoAction() : null)
      })),

    backupSetting(),

    settingRow('Import', 'A Tabspace backup, another manager\'s JSON export, or your Chrome bookmarks.',
      quietBtn('Import', () => { dismissLayer(); importDialog() })),

    settingRow('Export', 'Download everything as JSON, or as an HTML bookmarks file.', [
      quietBtn('JSON', () => download('tabspace-backup.json', toBackupJson(store.state), 'application/json')),
      quietBtn('HTML', () => download('tabspace-bookmarks.html', toBookmarksHtml(store.state), 'text/html')),
    ]),
  ])

  // A visible build number: the commonest cause of "feature X does nothing" is
  // Chrome still serving the previous build of the page from cache.
  body.append(el('div.setting', {}, [
    el('div.setting__body', {}, [
      el('div.setting__title', { text: 'Version' }),
      el('div.setting__desc', {
        text: `Tabspace ${chrome.runtime.getManifest().version}. If something new is missing, reload the extension at chrome://extensions and hard-refresh this tab with Ctrl+Shift+R.`,
      }),
    ]),
  ]))

  dialog({
    title: 'Settings',
    body,
    wide: true,
    actions: [{ label: 'Done', tone: 'primary', onClick: dismissLayer }],
  })
}

/**
 * Shown only when a snapshot exists. The board is snapshotted before signing
 * out and before a sign-in replaces it, so nothing a sign-in overwrites is
 * ever gone for good.
 */
function backupSetting() {
  const row = el('div.setting', { style: { display: 'none' } })

  store.readLocalBackup().then((backup) => {
    if (!backup?.state) return
    const when = new Date(backup.savedAt).toLocaleString()
    const reason = backup.reason === 'sign-in' ? 'replaced when you signed in' : 'saved when you signed out'
    const folders = (backup.state.spaces ?? []).reduce((n, sp) => n + (sp.folders?.length ?? 0), 0)

    const restore = el('button.btn.btn--quiet.btn--sm', { text: 'Restore' })
    restore.addEventListener('click', async () => {
      const yes = await confirmAction({
        title: 'Restore the backup?',
        subtitle: `This replaces the board you are looking at with the copy ${reason} on ${when}.`,
        confirmLabel: 'Restore',
        tone: 'primary',
      })
      if (!yes) return
      await store.restoreLocalBackup()
      dismissLayer()
      toast('Backup restored', undoAction())
    })

    const discard = el('button.icon-btn.icon-btn--sm', { title: 'Discard this backup' })
    discard.append(icon('trash', { size: 14 }))
    discard.addEventListener('click', async () => {
      await store.discardLocalBackup()
      dismissLayer()
      settingsDialog()
    })

    row.style.display = ''
    row.append(
      el('div.setting__body', {}, [
        el('div.setting__title', { text: 'Restore local backup' }),
        el('div.setting__desc', {
          text: `A copy of ${folders} folder${folders === 1 ? '' : 's'} was ${reason} on ${when}.`,
        }),
      ]),
      el('div.setting__control', {}, [restore, discard]),
    )
  })

  return row
}

function accountSetting() {
  const cloud = store.cloud.describe()
  const signedIn = cloud.status !== 'signed-out' && cloud.status !== 'unconfigured'

  const control = signedIn
    ? (() => {
      const b = el('button.btn.btn--quiet.btn--sm', { text: 'Sign out' })
      b.addEventListener('click', async () => {
        await store.signOutOfCloud()
        toast('Signed out')
        dismissLayer()
        settingsDialog()
      })
      return b
    })()
    : (() => {
      const b = el('button.btn.btn--primary.btn--sm', { text: cloud.configured ? 'Sign in' : 'Set up' })
      b.addEventListener('click', () => { dismissLayer(); cloud.configured ? authDialog() : setupDialog() })
      return b
    })()

  return settingRow('Account', cloudDescription(cloud), control)
}

function cloudDescription(cloud) {
  if (!cloud.configured) return 'Not configured yet — this board lives only on this computer.'
  if (cloud.status === 'error') return `Problem: ${cloud.error}`
  if (cloud.status === 'signed-out') {
    return 'Sign in and your board follows you into any browser on any machine — Chrome, Edge or Firefox.'
  }
  const when = cloud.lastPushedAt ? `, last saved ${new Date(cloud.lastPushedAt).toLocaleTimeString()}` : ''
  return `Signed in as ${cloud.email ?? 'your account'}${when}.`
}

// =========================================================== sign in / up ===

/**
 * A suggestion list under the email field, ranked by how often each account is
 * actually used. Typing "vit" brings up the address you sign in with most,
 * rather than whichever one happens to be alphabetically or recently first.
 *
 * This is deliberately not a <datalist>: the browser renders that one in its
 * own chrome, sorts it however it likes, and gives no room for "used 12 times"
 * or a way to forget an address. Building the list means it can be ranked,
 * annotated, and styled to match the rest of the dialog.
 *
 * @param {HTMLInputElement} input the email field
 * @param {() => void} onCommit called after a suggestion is accepted
 */
function accountSuggestions(input, onCommit) {
  const list = el('div.suggest', { role: 'listbox', 'aria-label': 'Remembered accounts' })
  let records = readAccounts()
  let visible = []
  let active = -1

  const close = () => {
    list.classList.remove('is-open')
    list.replaceChildren()
    active = -1
    visible = []
    input.setAttribute('aria-expanded', 'false')
  }

  const accept = (record) => {
    input.value = record.email
    close()
    onCommit?.()
  }

  const forget = (record) => {
    records = forgetAccount(record.email)
    // Keep the list under the cursor honest rather than leaving a stale row.
    refresh()
    if (!visible.length) close()
  }

  const paint = () => {
    list.replaceChildren(...visible.map((record, i) => {
      const row = el(`div.suggest__row${i === active ? '.is-active' : ''}`, {
        role: 'option',
        'aria-selected': i === active ? 'true' : 'false',
      })

      // mousedown, not click: the field's blur would tear the list down first.
      row.addEventListener('mousedown', (e) => { e.preventDefault(); accept(record) })
      row.addEventListener('mouseenter', () => { active = i; paint() })

      const drop = el('button.suggest__forget', {
        type: 'button',
        title: `Forget ${record.email}`,
        'aria-label': `Forget ${record.email}`,
      })
      drop.append(icon('close', { size: 13 }))
      drop.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); forget(record) })

      row.append(
        el('span.suggest__avatar', { text: record.email[0] ?? '?' }),
        el('span.suggest__body', {}, [
          el('span.suggest__email', { text: record.email }),
          el('span.suggest__meta', { text: describeAccount(record) }),
        ]),
        useCount(record) > 1 && i === 0 ? el('span.suggest__badge', { text: 'Most used' }) : null,
        drop,
      )
      return row
    }))
  }

  const refresh = () => {
    visible = rankAccounts(records, input.value)
    if (!visible.length) { close(); return }
    active = -1
    list.classList.add('is-open')
    input.setAttribute('aria-expanded', 'true')
    paint()
  }

  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-expanded', 'false')
  input.addEventListener('input', refresh)
  input.addEventListener('focus', refresh)
  input.addEventListener('blur', () => setTimeout(close, 120))

  /**
   * Returns true when the key was consumed here, so the caller knows not to
   * also submit the form or close the dialog.
   */
  const handleKey = (e) => {
    const open = list.classList.contains('is-open') && visible.length

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) { refresh(); if (!visible.length) return false }
      // Cycle through N+1 slots: slot 0 is "nothing selected, typing freely",
      // so arrowing off either end returns you to the text you typed.
      const step = e.key === 'ArrowDown' ? 1 : -1
      const slots = visible.length + 1
      active = (((active + 1 + step) % slots) + slots) % slots - 1
      paint()
      return true
    }

    if (e.key === 'Enter' && open && active >= 0) { accept(visible[active]); return true }
    if (e.key === 'Escape' && open) { close(); return true }
    if (e.key === 'Tab' && open && active >= 0) { accept(visible[active]); return false }
    return false
  }

  return { node: list, handleKey, close }
}

/**
 * Email and password, in one dialog that switches between signing in and
 * signing up. Password rather than a magic link because a confirmation link
 * cannot redirect back into an extension — it just opens a web page.
 */
function authDialog(mode = 'signin') {
  const known = readAccounts()

  const email = el('input.field', {
    type: 'email',
    placeholder: 'you@example.com',
    autocomplete: 'username',
    spellcheck: false,
    autocapitalize: 'none',
  })
  // Prefill the account this person actually uses most, not merely the last.
  email.value = known[0]?.email ?? ''

  const password = el('input.field.field--withReveal', {
    type: 'password',
    placeholder: mode === 'signup' ? 'At least 8 characters' : 'Your password',
    autocomplete: mode === 'signup' ? 'new-password' : 'current-password',
  })

  const suggest = accountSuggestions(email, () => password.focus())
  const emailWrap = el('div.field__wrap.field__wrap--suggest', {}, [email, suggest.node])

  const reveal = el('button.field__reveal', { type: 'button', title: 'Show password', 'aria-label': 'Show password' })
  reveal.append(icon('eye', { size: 16 }))
  reveal.addEventListener('click', () => {
    const shown = password.type === 'text'
    password.type = shown ? 'password' : 'text'
    reveal.replaceChildren(icon(shown ? 'eye' : 'eyeOff', { size: 16 }))
    reveal.title = shown ? 'Show password' : 'Hide password'
    reveal.setAttribute('aria-label', reveal.title)
    password.focus()
  })

  const passwordWrap = el('div.field__wrap', {}, [password, reveal])
  const error = el('p.field__error', { role: 'alert' })

  const confirmLabel = mode === 'signup' ? 'Create account' : 'Sign in'
  let busy = false

  const submit = async () => {
    if (busy) return
    error.textContent = ''
    suggest.close()

    busy = true
    const button = document.querySelector('.dialog__actions .btn--primary')
    if (button) { button.disabled = true; button.textContent = mode === 'signup' ? 'Creating…' : 'Signing in…' }

    try {
      const address = email.value
      const result = mode === 'signup'
        ? await store.signUpToCloud(address, password.value)
        : await store.signInToCloud(address, password.value)

      // Only a round trip that actually succeeded counts towards the ranking,
      // so a typo never climbs the suggestion list.
      recordAccountUse(address, mode)

      if (result.adopted) toast('Signed in — your board was restored from your account')
      else if (result.remoteHadData) toast('Signed in — already up to date')
      else toast('Signed in — this board is now synced')
      dismissLayer()
    } catch (err) {
      error.textContent = err.message
      busy = false
      if (button) { button.disabled = false; button.textContent = confirmLabel }
      password.focus()
      password.select?.()
    }
  }

  email.addEventListener('keydown', (e) => {
    if (suggest.handleKey(e)) { e.preventDefault(); e.stopPropagation(); return }
    if (e.key === 'Enter') { e.preventDefault(); password.value ? submit() : password.focus() }
  })
  password.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit() }
  })
  for (const field of [email, password]) {
    field.addEventListener('input', () => { error.textContent = '' })
  }

  const swap = el('button.linkish', {
    text: mode === 'signup' ? 'Already have an account? Sign in' : 'New here? Create an account',
  })
  swap.addEventListener('click', () => { dismissLayer(); authDialog(mode === 'signup' ? 'signin' : 'signup') })

  dialog({
    title: mode === 'signup' ? 'Create an account' : 'Sign in',
    subtitle: mode === 'signup'
      ? 'Your board syncs to every browser you sign in from.'
      : 'Signing in restores this account\'s board. Anything currently on this device is kept as a backup you can restore from Settings.',
    body: [
      el('label.field__label', { text: 'Email' }),
      emailWrap,
      known.length
        ? el('p.field__hint', { text: 'Start typing to pick an account you have used here before.' })
        : null,
      el('label.field__label', { text: 'Password', style: { marginTop: '12px' } }),
      passwordWrap,
      error,
      swap,
    ],
    actions: [
      { label: 'Cancel', onClick: dismissLayer },
      { label: confirmLabel, tone: 'primary', onClick: submit },
    ],
  })
  requestAnimationFrame(() => (email.value ? password : email).focus())
}

function setupDialog() {
  const step = (title, desc) => el('div.step', {}, [
    el('div.step__title', { text: title }),
    el('div.step__desc', { text: desc }),
  ])

  dialog({
    title: 'Sync is not set up',
    subtitle: 'Add two values from a free Supabase project and sign-in starts working.',
    wide: true,
    body: el('div.steps', {}, [
      step('Create a project', 'supabase.com → New project. Free plan, no card needed.'),
      step('Create the table', 'SQL Editor → run the snippet from the README section "Sync".'),
      step('Turn off email confirmation', 'Authentication → Sign In / Providers → Email → uncheck "Confirm email". Otherwise Supabase sends a link, and a link cannot return to an extension.'),
      step('Copy two values', 'Settings → API → Project URL and the anon/public key.'),
      step('Paste them in', 'src/lib/supabase-config.js, then reload the extension.'),
    ]),
    actions: [
      { label: 'Close', onClick: dismissLayer },
      { label: 'Open Supabase', tone: 'primary', onClick: () => chrome.tabs.create({ url: 'https://supabase.com/dashboard' }) },
    ],
  })
}

function syncDescription(sync) {
  const used = formatBytes(sync.usedBytes)
  const quota = formatBytes(SYNC_QUOTA_BYTES)
  if (sync.status === SyncStatus.OVER_QUOTA) {
    return `Paused — this board needs ${used} and Chrome sync holds ${quota}. Everything still works here.`
  }
  return `A free extra, Chrome-to-Chrome only. Using ${used} of ${quota}.`
}

// ================================================================= import ===

function importDialog() {
  const fileInput = el('input', { type: 'file', accept: '.json,.html,.htm', style: { display: 'none' } })
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const parsed = file.name.endsWith('.json') ? parseLegacyBackup(text) : parseHtmlBookmarks(text)
      confirmImport(parsed, file.name)
    } catch (err) {
      toast(`Could not read that file: ${err.message}`)
    }
  })

  const pick = el('button.btn.btn--quiet.btn--sm', { text: 'Choose file' })
  pick.addEventListener('click', () => fileInput.click())

  const chrome_ = el('button.btn.btn--quiet.btn--sm', { text: 'Import' })
  chrome_.addEventListener('click', async () => {
    const tree = await chrome.bookmarks.getTree()
    confirmImport(parseBrowserBookmarks(tree[0].children ?? []), 'Chrome bookmarks')
  })

  dialog({
    title: 'Import',
    subtitle: 'Nothing is overwritten — imported spaces are added alongside what you already have.',
    body: el('div', {}, [
      settingRow('Backup file', 'A Tabspace backup, another manager’s JSON export, or an HTML bookmarks file.', pick),
      settingRow('Chrome bookmarks', 'Import the bookmarks already in this browser.', chrome_),
      fileInput,
    ]),
    actions: [{ label: 'Close', onClick: dismissLayer }],
  })
}

function confirmImport(parsed, sourceName) {
  const { stats } = parsed
  dismissLayer()
  const summary = [
    `${stats.spaces} space${stats.spaces === 1 ? '' : 's'}`,
    `${stats.folders} folders`,
    stats.groups ? `${stats.groups} groups` : null,
    `${stats.items} bookmarks`,
    stats.stickers ? `${stats.stickers} notes` : null,
  ].filter(Boolean).join(', ')

  dialog({
    title: 'Import preview',
    subtitle: sourceName,
    body: el('p', { text: `${summary} will be added.` }),
    actions: [
      { label: 'Cancel', onClick: dismissLayer },
      { label: 'Import', tone: 'primary', onClick: () => {
        store.dispatch('mergeSpaces', { spaces: parsed.spaces })
        dismissLayer()
        toast(`Imported ${stats.items} bookmarks`, undoAction())
      } },
    ],
  })
}

/** Netscape bookmarks HTML — what every browser and most tab managers export. */
function parseHtmlBookmarks(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const space = { id: uid(), title: 'Imported bookmarks', position: 1000, folders: [], widgets: [] }
  let position = 1000

  for (const h3 of doc.querySelectorAll('h3')) {
    const dl = h3.nextElementSibling
    if (!dl || dl.tagName !== 'DL') continue
    const links = [...dl.querySelectorAll(':scope > dt > a, :scope > a')]
    if (!links.length) continue
    space.folders.push({
      id: uid(),
      title: h3.textContent.trim() || 'Imported',
      color: FOLDER_COLORS[space.folders.length % FOLDER_COLORS.length],
      collapsed: false,
      position: (position += 1000),
      items: links.map((a, i) => ({
        id: uid(), type: 'bookmark',
        title: a.textContent.trim() || a.href,
        url: a.href, favicon: '',
        tags: (a.getAttribute('tags') || '').split(',').map((t) => t.trim()).filter(Boolean),
        position: (i + 1) * 1000,
      })),
    })
  }

  if (!space.folders.length) {
    const links = [...doc.querySelectorAll('a[href^="http"]')]
    if (!links.length) throw new Error('no bookmarks found in that file')
    space.folders.push({
      id: uid(), title: 'Imported', color: FOLDER_COLORS[0], collapsed: false, position: 1000,
      items: links.map((a, i) => ({
        id: uid(), type: 'bookmark', title: a.textContent.trim() || a.href,
        url: a.href, favicon: '', tags: [], position: (i + 1) * 1000,
      })),
    })
  }

  const items = space.folders.reduce((n, f) => n + f.items.length, 0)
  return { spaces: [space], stats: { spaces: 1, folders: space.folders.length, items, groups: 0, stickers: 0 } }
}

function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = el('a', { href: url, download: filename })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast(`Saved ${filename}`)
}

// ================================================================= toasts ===

function toast(message, action = null) {
  const node = el('div.toast', {}, [el('span', { text: message })])
  if (action) {
    const btn = el('button.toast__action', { text: action.label })
    btn.addEventListener('click', () => { action.onClick(); node.remove() })
    node.append(btn)
  }
  $('toasts').append(node)
  setTimeout(() => node.remove(), action ? 6000 : 2800)
}

function undoAction() {
  return { label: 'Undo', onClick: () => store.undo() }
}

// ============================================================== statusbar ===

/**
 * What the board holds, as one line. It used to sit in the status bar; that bar
 * is now just the two actions, so the count lives in Settings where the rest of
 * the board's own facts are.
 */
function boardSummary() {
  const state = store.state
  const folders = state.spaces.reduce((n, s) => n + s.folders.length, 0)
  return `${state.spaces.length} space${state.spaces.length === 1 ? '' : 's'} · ${folders} folder${folders === 1 ? '' : 's'} · ${countItems(state)} bookmarks`
}

/**
 * The account control lives in the top bar, not in Settings: if sync is off the
 * board exists on one machine only, and that should be visible without going
 * looking for it.
 */
function renderAccount() {
  const btn = $('btn-account')
  if (!btn) return
  const cloud = store.cloud.describe()
  btn.className = 'account'
  btn.onclick = null

  if (!cloud.configured) {
    btn.classList.add('account--warn')
    btn.replaceChildren(icon('cloudOff', { size: 15 }), el('span', { text: 'Sync off' }))
    btn.title = 'Sync is not configured — this board lives only on this computer.'
    btn.onclick = () => { dismissLayer(); setupDialog() }
    return
  }

  if (cloud.status === 'signed-out') {
    btn.classList.add('account--out')
    btn.replaceChildren(icon('cloud', { size: 15 }), el('span', { text: 'Sign in to sync' }))
    btn.title = 'Your board is only on this computer. Sign in to reach it from anywhere.'
    btn.onclick = () => { dismissLayer(); authDialog('signin') }
    return
  }

  if (cloud.status === 'error') {
    btn.classList.add('account--warn')
    btn.replaceChildren(icon('alert', { size: 15 }), el('span', { text: 'Sync problem' }))
    btn.title = cloud.error ?? 'Sync error'
    btn.onclick = settingsDialog
    return
  }

  const email = cloud.email ?? ''
  btn.classList.add('account--in')
  btn.replaceChildren(
    el('span.account__avatar', { text: email[0] ?? '?' }),
    el('span', { text: email.split('@')[0] || 'Signed in' }),
  )
  btn.title = `Signed in as ${email}. Your board syncs to every browser you sign in from.`
  btn.onclick = settingsDialog
}

function renderSyncPill() {
  const pill = $('sync-pill')
  if (!pill) return
  const sync = store.sync.describe()

  const dot = {
    [SyncStatus.IDLE]: '',
    [SyncStatus.PUSHING]: '.is-busy',
    [SyncStatus.PULLING]: '.is-busy',
    [SyncStatus.DISABLED]: '.is-off',
    [SyncStatus.OVER_QUOTA]: '.is-bad',
    [SyncStatus.ERROR]: '.is-bad',
  }[sync.status] ?? ''

  const label = {
    [SyncStatus.IDLE]: sync.pending ? 'Saving' : 'Saved',
    [SyncStatus.PUSHING]: 'Syncing',
    [SyncStatus.PULLING]: 'Syncing',
    [SyncStatus.DISABLED]: 'Local only',
    [SyncStatus.OVER_QUOTA]: 'Chrome sync full',
    [SyncStatus.ERROR]: 'Sync error',
  }[sync.status] ?? ''

  const fill = sync.percent > 90 ? '.is-bad' : sync.percent > 70 ? '.is-warn' : ''

  // The meter only appears once the quota is worth watching -- in the top bar it
  // is competing with the search box for room, and a bar sitting at 4% full is
  // not news. The exact figures stay in the tooltip either way.
  pill.title = `${label} — ${formatBytes(sync.usedBytes)} of ${formatBytes(SYNC_QUOTA_BYTES)} of Chrome sync storage`
  // Filtered, not passed straight through: replaceChildren stringifies whatever
  // is not a node, so a bare `null` for the absent meter rendered as the word
  // "null" next to the status. `el()` drops empty children for the same reason.
  pill.replaceChildren(...[
    el(`span.sync-dot${dot}`),
    el('span.sync-pill__label', { text: label }),
    sync.percent > 70
      ? el('span.meter', {}, [el(`span.meter__fill${fill}`, { style: { width: `${Math.max(3, sync.percent)}%` } })])
      : null,
  ].filter(Boolean))
}

// ============================================================== global ui ===

function wireUi() {
  // The column count depends on the board's width, so it has to be recomputed
  // when that width moves -- the window resizing, or the sidebar sliding open
  // and shut. Redrawing only when the width really changed keeps the observer
  // from chasing its own layout (a new scrollbar nudges clientWidth).
  //
  // The notes have to be redrawn with it. The sidebar animates open over a
  // quarter of a second, so the render that the toggle itself triggers still
  // measures the old, wider board; this is the pass that sees the final width
  // and pulls any note that no longer fits back into view.
  if (typeof ResizeObserver !== 'undefined') {
    const relayout = debounce(() => {
      if (Math.abs(boardMetrics().inner - laidOutAt) < 1) return
      renderBoard()
      renderCanvas()
    }, 80)
    // Border box, not content box: a scrollbar appearing narrows the content
    // box, and reacting to that could set the layout chasing its own tail.
    new ResizeObserver(relayout).observe($('board-scroll'), { box: 'border-box' })
  }

  // The vector, not the 128px PNG the browser shows in its own chrome: the mark
  // renders at 30px here, and a 30px sample of a 128px bitmap is visibly soft
  // beside the rest of the interface.
  $('brand-mark').append(el('img', { src: chrome.runtime.getURL('icons/icon.svg'), alt: '' }))
  $('btn-sidebar').append(icon('sidebar', { size: 18 }))
  $('btn-news').append(icon('news', { size: 18 }))
  $('btn-tags').append(icon('tag', { size: 18 }))
  $('btn-settings').append(icon('settings', { size: 18 }))
  $('search').before(icon('search', { size: 18 }))

  $('search').addEventListener('input', debounce((e) => {
    ui.search = e.target.value
    renderBoard()
    renderCanvas()
  }, 120))

  $('btn-settings').addEventListener('click', settingsDialog)
  $('btn-tags').addEventListener('click', tagManagerDialog)
  $('btn-theme').addEventListener('click', cycleTheme)

  $('btn-sidebar').addEventListener('click', () => {
    store.dispatch('updateSettings', {
      patch: { sidebarCollapsed: !store.state.settings.sidebarCollapsed },
    }, { undoable: false })
  })

  $('view-tabs').addEventListener('click', () => setSidebarView('tabs'))
  $('view-news').addEventListener('click', () => setSidebarView('news'))
  $('view-routines').addEventListener('click', () => setSidebarView('routines'))

  // The top-bar news button: opens the sidebar on the news view, and if that
  // is already what is showing, tucks the sidebar away again.
  $('btn-news').addEventListener('click', () => {
    const s = store.state.settings
    if (s.sidebarCollapsed) {
      store.dispatch('updateSettings', { patch: { sidebarCollapsed: false, sidebarView: 'news' } }, { undoable: false })
    } else if (s.sidebarView === 'news') {
      store.dispatch('updateSettings', { patch: { sidebarCollapsed: true } }, { undoable: false })
    } else {
      setSidebarView('news')
    }
  })

  $('btn-add-folder').addEventListener('click', addFolder)

  $('btn-add-note').addEventListener('click', () => {
    if (ui.search.trim() || ui.activeTags.size) return toast('Clear the search to add a note')
    createSticker(freeNoteSpot())
  })

  $('btn-sort-tabs').addEventListener('click', (e) => {
    menu(e.currentTarget, [
      { label: 'By title', iconName: 'sort', onClick: () => sortTabs('title') },
      { label: 'By website', iconName: 'sort', onClick: () => sortTabs('domain') },
      { label: 'By most recently used', iconName: 'sort', onClick: () => sortTabs('recent') },
    ])
  })

  $('btn-close-dupes').addEventListener('click', closeDuplicateTabs)

  $('save-suggest-dismiss').addEventListener('click', () => {
    $('save-suggest').hidden = true
  })

  $('btn-stash').addEventListener('click', async () => {
    if (!openTabs.length) return toast('Nothing to stash — you are already tidy')
    const space = currentSpace(store.state)
    const folderId = store.dispatch('addFolder', {
      spaceId: space.id,
      title: `Stashed ${new Date().toLocaleDateString()}`,
    })
    let position = 1000
    for (const tab of openTabs) {
      store.dispatch('addItem', {
        folderId,
        item: { title: tab.title, url: tab.url, favicon: tab.favIconUrl },
        position,
      }, { undoable: false })
      position += 1000
    }
    toast(`Stashed ${openTabs.length} tabs`, undoAction())
  })

  // Double-clicking empty board space drops a sticky note there.
  $('board-scroll').addEventListener('dblclick', (e) => {
    if (e.target.closest('.folder, .add-folder, .sticker, .empty-state')) return
    if (ui.search.trim() || ui.activeTags.size) return toast('Clear the search to add a note')
    createStickerAt(e.clientX, e.clientY)
  })

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault()
      const ok = e.shiftKey ? store.redo() : store.undo()
      toast(ok ? (e.shiftKey ? 'Redone' : 'Undone') : 'Nothing to undo')
    }
    if (e.key === '/' && !typing) { e.preventDefault(); $('search').focus() }
    if (e.key === 'Escape' && !typing) closeMenu()
  })

  // Dropping a link on empty board space makes a folder for it.
  $('board').addEventListener('dragover', (e) => e.preventDefault())
  $('board').addEventListener('drop', (e) => {
    if (e.target.closest('.folder')) return
    const data = readDrag(e)
    if (data?.kind !== 'tabs') return
    e.preventDefault()
    const space = currentSpace(store.state)
    const folderId = store.dispatch('addFolder', { spaceId: space.id, title: 'New folder' })
    let position = 1000
    for (const tab of data.payload) {
      const itemId = store.dispatch('addItem', { folderId, item: tab, position }, { undoable: false })
      position += 1000
      if (itemId) autoTag({ store, itemId, title: tab.title, url: tab.url, folder: 'New folder' })
    }
    ui.selectedTabIds.clear()
    toast(`Saved ${data.payload.length} tab${data.payload.length === 1 ? '' : 's'} to a new folder`, undoAction())
  })
}
