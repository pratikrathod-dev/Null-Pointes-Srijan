// Side panel: a vertical tab strip with your saved folders underneath.
// Same store as the board, so anything saved here shows up there immediately.

import { Store } from '../lib/store.js'
import { bySortPosition, el, faviconEl, debounce, safeUrl } from '../lib/util.js'
import { currentSpace, isGroup } from '../lib/model.js'
import { icon } from '../lib/icons.js'

const store = new Store()
const $ = (id) => document.getElementById(id)

let openTabs = []
let activeTabId = null
let filter = ''
const collapsed = new Set()

// Section open/shut is a per-device convenience, so it lives in localStorage
// rather than travelling through sync with the board itself.
const shutSections = new Set(JSON.parse(localStorage.getItem('shutSections') || '[]'))

function wireSection(name) {
  const head = document.getElementById(`head-${name}`)
  const caret = document.getElementById(`caret-${name}`)
  const body = document.getElementById(name === 'tabs' ? 'tabs' : 'saved')

  const paint = () => {
    const shut = shutSections.has(name)
    caret.classList.toggle('is-collapsed', shut)
    body.classList.toggle('sp__collapsed', shut)
  }

  const toggle = (e) => {
    if (e.target.closest('button')) return          // the ⧉ action, not the header
    shutSections.has(name) ? shutSections.delete(name) : shutSections.add(name)
    localStorage.setItem('shutSections', JSON.stringify([...shutSections]))
    paint()
  }

  head.addEventListener('click', toggle)
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e) }
  })
  paint()
}

;(async function boot() {
  await store.init()
  applyTheme()
  store.addEventListener('change', () => { applyTheme(); renderSaved() })

  await refreshTabs()
  renderTabs()
  renderSaved()

  const refresh = debounce(async () => { await refreshTabs(); renderTabs(); renderSaved() }, 120)
  for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onAttached', 'onDetached', 'onActivated']) {
    chrome.tabs[ev]?.addListener(refresh)
  }

  $('filter').addEventListener('input', debounce((e) => {
    filter = e.target.value.trim().toLowerCase()
    renderTabs()
    renderSaved()
  }, 120))

  $('brand-mark').append(el('img', { src: chrome.runtime.getURL('icons/icon_128.png'), alt: '' }))
  $('btn-board').append(icon('layers', { size: 16 }))
  $('btn-close-dupes').append(icon('copy', { size: 14 }))
  $('caret-tabs').append(icon('chevronDown', { size: 12 }))
  $('caret-saved').append(icon('chevronDown', { size: 12 }))

  wireSection('tabs')
  wireSection('saved')

  $('btn-board').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-board' }))
  $('btn-close-dupes').addEventListener('click', closeDuplicateTabs)

  window.addEventListener('beforeunload', () => { store.flush(); store.dispose() })
})()

function applyTheme() {
  const pref = store.state.settings.theme
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.font = store.state.settings.fontFamily ?? 'inter'
}

async function refreshTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true })
  const hidePinned = store.state.settings.hidePinnedTabs
  openTabs = tabs.filter((t) => !(hidePinned && t.pinned))
  activeTabId = tabs.find((t) => t.active)?.id ?? null
}

function closeTabButton(tabId) {
  const btn = el('button.icon-btn.icon-btn--sm', { title: 'Close tab' })
  btn.append(icon('close', { size: 13 }))
  btn.addEventListener('click', (e) => { e.stopPropagation(); chrome.tabs.remove(tabId) })
  return btn
}

const matches = (text) => !filter || String(text ?? '').toLowerCase().includes(filter)
const normalise = (url) => String(url ?? '').replace(/\/+$/, '').toLowerCase()

// ------------------------------------------------------------- open tabs ---

function renderTabs() {
  const host = $('tabs')
  const shown = openTabs.filter((t) => matches(t.title) || matches(t.url))
  $('tab-count').textContent = String(shown.length)

  if (!shown.length) {
    host.replaceChildren(el('div.sp__empty', { text: filter ? 'No matches.' : 'No tabs open. Bold.' }))
    return
  }

  host.replaceChildren(...shown.map((tab) => {
    const row = el(
      `div.sp__row${tab.id === activeTabId ? '.is-active' : ''}${tab.pinned ? '.sp__row--pinned' : ''}`,
      { draggable: true, title: `${tab.title}\n${tab.url}` },
      [
        faviconEl({ url: tab.url ?? '', favicon: tab.favIconUrl }, true),
        el('span.sp__title', { text: tab.title || tab.url || '' }),
        closeTabButton(tab.id),
      ],
    )
    row.addEventListener('click', () => chrome.tabs.update(tab.id, { active: true }))
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'copy'
      e.dataTransfer.setData('application/x-tabspace', JSON.stringify({
        kind: 'tabs',
        payload: [{ title: tab.title, url: tab.url, favicon: tab.favIconUrl }],
      }))
    })
    return row
  }))
}

async function closeDuplicateTabs() {
  const all = await chrome.tabs.query({ currentWindow: true })
  const seen = new Set()
  const doomed = []
  for (const tab of all) {
    const url = normalise(tab.url)
    if (!url || tab.pinned) continue
    if (seen.has(url)) doomed.push(tab.id)
    else seen.add(url)
  }
  if (!doomed.length) return toast('No duplicate tabs')
  await chrome.tabs.remove(doomed)
  await refreshTabs()
  renderTabs()
  toast(`Closed ${doomed.length} duplicate${doomed.length === 1 ? '' : 's'}`)
}

// ----------------------------------------------------------- saved items ---

function renderSaved() {
  const host = $('saved')
  const space = currentSpace(store.state)
  if (!space) return

  const rows = []
  let total = 0

  for (const folder of [...space.folders].sort(bySortPosition)) {
    const kids = [...folder.items].sort(bySortPosition)
    const visible = filter ? kids.filter(itemMatches) : kids
    if (filter && !visible.length && !matches(folder.title)) continue

    const isOpen = !collapsed.has(folder.id) || Boolean(filter)
    rows.push(folderHead(folder, isOpen))
    if (!isOpen) continue

    for (const item of (filter && !matches(folder.title) ? visible : kids)) {
      if (isGroup(item)) {
        const inner = [...item.groupItems].sort(bySortPosition)
        const shown = filter && !matches(item.title) ? inner.filter(itemMatches) : inner
        if (filter && !shown.length && !matches(item.title)) continue
        rows.push(el('div.sp__row.sp__group', {}, [
          icon('chevronDown', { size: 12 }),
          el('span.sp__title', { text: item.title }),
          el('span.sp__count', { text: String(item.groupItems.length) }),
        ]))
        for (const child of shown) { rows.push(savedRow(child, true)); total += 1 }
      } else {
        rows.push(savedRow(item, false))
        total += 1
      }
    }
  }

  $('saved-count').textContent = String(total)
  host.replaceChildren(...(rows.length
    ? rows
    : [el('div.sp__empty', { text: filter ? 'Nothing saved matches.' : 'Drag a tab onto a folder to save it.' })]))
}

function itemMatches(item) {
  if (isGroup(item)) {
    return matches(item.title) || item.groupItems.some(itemMatches)
  }
  return matches(item.title) || matches(item.url) || (item.tags ?? []).some(matches)
}

function folderHead(folder, isOpen) {
  const head = el('div.sp__folder', {}, [
    icon('chevronDown', { size: 13, className: isOpen ? 'sp__caret' : 'sp__caret is-collapsed' }),
    el('span.sp__dot', { style: { background: folder.color } }),
    el('span.sp__title', { text: folder.title }),
    el('span.sp__count', { text: String(folder.items.length) }),
  ])

  head.addEventListener('click', () => {
    collapsed.has(folder.id) ? collapsed.delete(folder.id) : collapsed.add(folder.id)
    renderSaved()
  })

  head.addEventListener('dragover', (e) => { e.preventDefault(); head.classList.add('is-drop-target') })
  head.addEventListener('dragleave', () => head.classList.remove('is-drop-target'))
  head.addEventListener('drop', (e) => {
    e.preventDefault()
    head.classList.remove('is-drop-target')
    const raw = e.dataTransfer.getData('application/x-tabspace')
      || e.dataTransfer.getData('text/uri-list')
      || e.dataTransfer.getData('text/plain')
    if (!raw) return

    let payload
    try {
      const parsed = JSON.parse(raw)
      payload = parsed.kind === 'tabs' ? parsed.payload : null
    } catch {
      if (/^https?:/i.test(raw.trim())) payload = [{ title: raw.trim(), url: raw.trim() }]
    }
    if (!payload?.length) return

    for (const tab of payload) {
      store.dispatch('addItem', {
        folderId: folder.id,
        item: { title: tab.title, url: tab.url, favicon: tab.favicon ?? '' },
      })
    }
    store.flush()
    toast(`Saved to "${folder.title}"`)
  })

  return head
}

function savedRow(item, nested) {
  if (item.type === 'note') {
    return el(`div.sp__row.${nested ? 'sp__row--deep' : 'sp__row--nested'}`, {
      text: item.title,
      style: { color: 'var(--text-dim)', fontStyle: 'italic' },
    })
  }
  const row = el(`div.sp__row.${nested ? 'sp__row--deep' : 'sp__row--nested'}`, {
    title: `${item.title}\n${item.url}`,
  }, [
    faviconEl(item, true),
    el('span.sp__title', { text: item.title }),
  ])
  row.addEventListener('click', (e) => {
    // Same scheme check as the board: an imported bookmark is not trusted just
    // because it is being opened from a narrower piece of UI.
    const target = safeUrl(item.url)
    if (!target) { toast('That bookmark does not point at a web page'); return }
    const newTab = store.state.settings.openInNewTab !== (e.ctrlKey || e.metaKey)
    if (newTab) chrome.tabs.create({ url: target })
    else chrome.tabs.update({ url: target })
  })
  return row
}

function toast(message) {
  const node = el('div.toast', { text: message })
  $('toasts').append(node)
  setTimeout(() => node.remove(), 2400)
}
