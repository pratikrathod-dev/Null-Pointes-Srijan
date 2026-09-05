// Toolbar popup: save the current tab into any folder, in one click.

import { Store } from '../lib/store.js'
import { bySortPosition, el, faviconEl, hostnameOf } from '../lib/util.js'
import { icon } from '../lib/icons.js'
import { ask, dismissLayer } from '../lib/dialogs.js'
import { autoTag } from '../lib/auto-tag.js'

const store = new Store()
const $ = (id) => document.getElementById(id)

let tab = null
let filter = ''
let activeIndex = 0
let rows = []

;(async function boot() {
  await store.init({ poll: false })
  applyTheme()
  ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })

  renderTab()
  renderFolders()

  $('filter').addEventListener('input', (e) => {
    filter = e.target.value.toLowerCase()
    activeIndex = 0
    renderFolders()
  })

  $('filter').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, rows.length - 1); renderFolders() }
    if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); renderFolders() }
    if (e.key === 'Enter') { e.preventDefault(); rows[activeIndex] && save(rows[activeIndex].folder) }
  })

  $('btn-new-folder').addEventListener('click', async () => {
    const title = await ask({
      title: 'New folder',
      label: 'Name',
      value: hostnameOf(tab?.url ?? '') || '',
      confirmLabel: 'Create and save',
      validate: (v) => (v ? null : 'Give the folder a name.'),
    })
    if (!title) return
    const space = store.state.spaces.find((s) => s.id === store.state.settings.currentSpaceId) ?? store.state.spaces[0]
    const folderId = store.dispatch('addFolder', { spaceId: space.id, title })
    dismissLayer()
    save({ id: folderId, title })
  })

  $('btn-open-board').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'open-board' })
    window.close()
  })
})()

function applyTheme() {
  const pref = store.state.settings.theme
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.font = store.state.settings.fontFamily ?? 'inter'
}

function renderTab() {
  if (!tab) return
  $('current-tab').replaceChildren(
    faviconEl({ url: tab.url ?? '', favicon: tab.favIconUrl }),
    el('div.popup__tab-body', {}, [
      el('div.popup__tab-title', { text: tab.title || tab.url || '' }),
      el('div.popup__tab-host', { text: hostnameOf(tab.url ?? '') }),
    ]),
  )
}

function renderFolders() {
  const host = $('folders')
  const url = normalise(tab?.url ?? '')

  rows = store.state.spaces.flatMap((space) =>
    [...space.folders].sort(bySortPosition).map((folder) => ({
      space, folder,
      saved: folder.items.some((i) => normalise(i.url ?? '') === url),
    })))

  if (filter) {
    rows = rows.filter(({ space, folder }) =>
      folder.title.toLowerCase().includes(filter) || space.title.toLowerCase().includes(filter))
  }

  if (!rows.length) {
    host.replaceChildren(el('div.popup__empty', {
      text: filter ? 'No folder matches that.' : 'No folders yet — make one below.',
    }))
    return
  }

  activeIndex = Math.min(activeIndex, rows.length - 1)
  host.replaceChildren(...rows.map(({ space, folder, saved }, i) => el(
    `button.popup__folder${i === activeIndex ? '.is-active' : ''}`,
    { onclick: () => save(folder) },
    [
      el('span.popup__dot', { style: { background: folder.color } }),
      el('span.popup__folder-title', { text: folder.title }),
      store.state.spaces.length > 1 ? el('span.popup__folder-space', { text: space.title }) : null,
      saved ? el('span.popup__saved', { text: 'saved' }) : null,
    ],
  )))
}

function normalise(url) {
  return String(url).replace(/\/+$/, '').toLowerCase()
}

async function save(folder) {
  if (!tab) return
  const itemId = store.dispatch('addItem', {
    folderId: folder.id,
    item: { title: tab.title, url: tab.url, favicon: tab.favIconUrl },
  })
  if (itemId) autoTag({ store, itemId, title: tab.title, url: tab.url, folder: folder.title })
  $('toasts').append(el('div.toast', { text: `Saved to "${folder.title}"` }))
  // Wait for the write to land before the popup is torn down.
  await store.flushNow()
  setTimeout(() => window.close(), 400)
}
