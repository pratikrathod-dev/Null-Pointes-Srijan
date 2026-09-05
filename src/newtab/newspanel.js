// The AI news view of the sidebar: ten stories, ranked by MiMo, every one of
// them a real link from a feed the extension fetched itself.
//
// The board script owns the sidebar switch and calls in here; this module owns
// everything inside the news panel plus the MiMo rows in Settings.

import { el, faviconEl, hostnameOf } from '../lib/util.js'
import { icon } from '../lib/icons.js'
import { menu } from '../lib/dialogs.js'
import { currentSpace } from '../lib/model.js'
import { readMimoConfig, writeMimoConfig, testMimoKey, isTokenPlanKey, MIMO_MODEL } from '../lib/mimo.js'
import {
  loadNews, readNewsCache, isNewsStale, timeAgo, NEWS_RANGES, NEWS_SOURCES, NEWS_COUNT,
} from '../lib/news.js'

const CATEGORY_LABEL = {
  release: 'Release',
  free: 'Free',
  'open-source': 'Open source',
  product: 'Product',
  research: 'Research',
  funding: 'Funding',
  security: 'Security',
  policy: 'Policy',
}

/**
 * @param {object} deps
 * @param {import('../lib/store.js').Store} deps.store
 * @param {(msg: string, action?: {label: string, onClick: () => void}) => void} deps.toast
 * @param {() => void} deps.openSettings
 * @param {(id: string) => HTMLElement} deps.$
 * @param {() => boolean} deps.isVisible   whether the news view is the one showing
 */
export function mountNewsPanel({ store, toast, openSettings, $, isVisible }) {
  const state = {
    loading: false,
    stage: '',
    error: null,        // { message, code }
    data: null,         // payload from loadNews / cache
    controller: null,
    unseen: false,      // a refresh landed while the tab view was showing
  }

  const range = () => (NEWS_RANGES[store.state.settings.newsRange] ? store.state.settings.newsRange : 'daily')

  // ---------------------------------------------------------------- wiring

  $('btn-news-refresh').append(icon('refresh', { size: 16 }))
  $('btn-news-refresh').addEventListener('click', () => refresh({ force: true }))

  $('news-range').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]')
    if (!btn || btn.dataset.range === range()) return
    store.dispatch('updateSettings', { patch: { newsRange: btn.dataset.range } }, { undoable: false })
    state.data = null
    state.error = null
    ensureLoaded()
  })

  // ------------------------------------------------------------- loading

  /** Show what we have; fetch if we have nothing or it has gone stale. */
  async function ensureLoaded() {
    const r = range()
    render()
    if (state.loading) return
    if (state.data?.range === r && !isNewsStale(state.data, r)) return

    const cached = await readNewsCache(r)
    if (cached) {
      state.data = cached
      render()
      if (!isNewsStale(cached, r)) return
    }

    const { apiKey } = await readMimoConfig()
    if (!apiKey && !cached) {
      state.error = { message: 'Add your MiMo API key in Settings to rank the news.', code: 'no-key' }
      render()
      return
    }
    // Stale cache but no key: keep showing the cache rather than fail loudly.
    if (!apiKey) return
    await refresh({ force: false })
  }

  async function refresh({ force = false, plain = false } = {}) {
    if (state.loading) return
    const r = range()
    const { apiKey, webSearch } = await readMimoConfig()

    if (!apiKey && !plain) {
      state.error = { message: 'Add your MiMo API key in Settings to rank the news.', code: 'no-key' }
      state.loading = false
      render()
      return
    }

    state.loading = true
    state.error = null
    state.stage = 'Reading feeds…'
    state.controller = new AbortController()
    render()

    try {
      const payload = await loadNews({
        range: r,
        apiKey: plain ? '' : apiKey,
        webSearch,
        allowPlain: plain,
        signal: state.controller.signal,
        onStage: (s) => { state.stage = s; renderStatus() },
      })
      state.data = payload
      if (!isVisible()) state.unseen = true
      if (force) toast(payload.ai ? `Top ${payload.items.length} picked by MiMo` : `Newest ${payload.items.length} stories`)
    } catch (err) {
      if (err?.name === 'AbortError') return
      state.error = { message: err?.message ?? 'Something went wrong.', code: err?.code ?? null }
    } finally {
      state.loading = false
      state.controller = null
      render()
    }
  }

  /** Called by the board when the news view becomes the visible one. */
  function shown() {
    state.unseen = false
    $('news-dot').hidden = true
    ensureLoaded()
  }

  // ------------------------------------------------------------ rendering

  function render() {
    renderRange()
    renderStatus()
    renderList()
    $('news-dot').hidden = !state.unseen
  }

  function renderRange() {
    const r = range()
    for (const btn of $('news-range').querySelectorAll('[data-range]')) {
      const on = btn.dataset.range === r
      btn.classList.toggle('is-active', on)
      btn.setAttribute('aria-checked', on ? 'true' : 'false')
    }
  }

  function renderStatus() {
    const btn = $('btn-news-refresh')
    btn.classList.toggle('is-busy', state.loading)
    btn.disabled = state.loading
    const label = $('news-updated')
    if (state.loading) label.textContent = state.stage
    else if (state.data?.fetchedAt) label.textContent = `Updated ${timeAgo(state.data.fetchedAt)}`
    else label.textContent = ''
  }

  function renderList() {
    const list = $('news-list')
    const scroll = list.scrollTop
    list.replaceChildren()

    if (state.loading && !state.data) {
      list.append(el('div.news-skeleton', {}, Array.from({ length: NEWS_COUNT }, () => el('div.news-skeleton__card'))))
      return
    }

    if (state.error && !state.data) {
      list.append(errorBox())
      return
    }

    if (!state.data) return

    if (state.error) list.append(errorBox())

    for (const item of state.data.items) list.append(card(item))
    list.append(footer())
    list.scrollTop = scroll
  }

  function errorBox() {
    const noKey = state.error.code === 'no-key'
    const actions = []
    if (noKey) {
      actions.push(quietBtn('Add MiMo key', openSettings))
      actions.push(quietBtn('Show newest without AI', () => refresh({ force: true, plain: true })))
    } else {
      actions.push(quietBtn('Try again', () => refresh({ force: true })))
      if (/key|credit|rate-limit/i.test(state.error.message)) actions.push(quietBtn('Open Settings', openSettings))
    }
    return el('div.news-state.news-state--error', {}, [
      el('div.news-state__title', { text: noKey ? 'No MiMo key yet' : 'Could not load the news' }),
      el('div.news-state__desc', { text: state.error.message }),
      el('div.news-state__actions', {}, actions),
    ])
  }

  function quietBtn(label, onClick) {
    const b = el('button.btn.btn--quiet.btn--sm', { text: label })
    b.addEventListener('click', onClick)
    return b
  }

  function card(item) {
    const cat = CATEGORY_LABEL[item.category] ? item.category : 'product'
    const node = el(`a.news-card.news-card--${cat}`, {
      href: item.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: item.originalTitle && item.originalTitle !== item.title ? item.originalTitle : null,
    })

    const head = el('div.news-card__head', {}, [
      el('span.news-card__tag', { text: CATEGORY_LABEL[cat] }),
      item.free && cat !== 'free' ? el('span.news-card__tag.news-card__tag--free', { text: 'Free' }) : null,
      item.heat != null
        ? el('span.news-card__heat', { title: 'How much MiMo thinks this matters' }, [icon('flame', { size: 11 }), String(item.heat)])
        : null,
    ])

    const meta = el('div.news-card__meta', {}, [
      faviconEl({ url: item.url, favicon: '' }, true),
      el('span', { text: item.source || hostnameOf(item.url) }),
      el('span.dot', { text: '·' }),
      el('span', { text: item.fromSearch ? 'via MiMo search' : timeAgo(item.published) }),
    ])

    const save = el('button.icon-btn.icon-btn--sm.news-card__save', { type: 'button', title: 'Save to a folder' })
    save.append(icon('bookmark', { size: 14 }))
    save.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      saveMenu(save, item)
    })

    node.append(
      el('div.news-card__rank', { text: String(item.rank) }),
      el('div.news-card__body', {}, [
        head,
        el('div.news-card__title', { text: item.title }),
        item.summary ? el('div.news-card__summary', { text: item.summary }) : null,
        meta,
      ]),
      save,
    )
    return node
  }

  function saveMenu(anchor, item) {
    const space = currentSpace(store.state)
    const folders = space?.folders ?? []
    if (!folders.length) return toast('Make a folder on the board first')
    menu(anchor, [
      { heading: 'Save to' },
      ...folders.map((f) => ({
        label: f.title,
        iconName: 'folder',
        onClick: () => {
          store.dispatch('addItem', {
            folderId: f.id,
            item: { type: 'bookmark', title: item.title, url: item.url, favicon: '', tags: ['ai-news'] },
          })
          toast(`Saved to ${f.title}`, { label: 'Undo', onClick: () => store.undo() })
        },
      })),
    ])
  }

  function footer() {
    const d = state.data
    const period = NEWS_RANGES[d.range]?.label ?? ''
    const text = d.ai
      ? `${period}: top ${d.items.length} picked by ${MIMO_MODEL} from ${d.candidates} stories across ${d.sources.ok} sources${d.usedWebSearch ? ', plus MiMo web search' : ''}. Every link is the original source.`
      : `${period}: newest ${d.items.length} of ${d.candidates} stories across ${d.sources.ok} sources, not ranked by AI. Add a MiMo key in Settings for the ranked list.`
    const failed = d.sources.failed?.length ? ` Could not reach: ${d.sources.failed.join(', ')}.` : ''
    return el('div.news__foot', { text: text + failed })
  }

  return { ensureLoaded, refresh, shown, render }
}

// =============================================================== settings ===

/**
 * The MiMo rows for the Settings dialog. `config` is the already-read MiMo
 * config so the dialog can stay synchronous once it has it.
 */
export function mimoSettingRows({ config, settingRow, toggleControl, toast, onKeySaved, onRefresh }) {
  const input = el('input.field.field--key', {
    type: 'password',
    placeholder: 'sk-… or tp-…',
    autocomplete: 'off',
    spellcheck: false,
    autocapitalize: 'none',
  })
  input.value = config.apiKey ?? ''

  const reveal = el('button.icon-btn.icon-btn--sm', { type: 'button', title: 'Show key' })
  reveal.append(icon('eye', { size: 15 }))
  reveal.addEventListener('click', () => {
    const shown = input.type === 'text'
    input.type = shown ? 'password' : 'text'
    reveal.replaceChildren(icon(shown ? 'eye' : 'eyeOff', { size: 15 }))
    reveal.title = shown ? 'Show key' : 'Hide key'
  })

  const save = el('button.btn.btn--quiet.btn--sm', { text: 'Save & test' })
  save.addEventListener('click', async () => {
    const key = input.value.trim()
    save.disabled = true
    save.textContent = key ? 'Testing…' : 'Saving…'
    try {
      await writeMimoConfig({ apiKey: key })
      if (!key) {
        toast('MiMo key removed')
      } else {
        const result = await testMimoKey(key)
        if (result.ok) toast(`MiMo key works — ${MIMO_MODEL}${isTokenPlanKey(key) ? ' (Token Plan)' : ''}`)
        else toast(result.error)
      }
      onKeySaved?.(key)
    } finally {
      save.disabled = false
      save.textContent = 'Save & test'
    }
  })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click() })

  const sourceNames = NEWS_SOURCES.map((s) => s.name).join(', ')

  return [
    settingRow('MiMo API key',
      `Powers the AI news panel. The key stays on this device — it is never synced, exported, or sent anywhere except Xiaomi's API. Keys starting sk- use the direct API; tp- keys use the Token Plan endpoint. Model: ${MIMO_MODEL}.`,
      [input, reveal, save]),

    settingRow('MiMo web search',
      'Lets MiMo search the web for a big story the feeds missed, and only keeps links it actually retrieved. Direct sk- keys only, with the Web Search plugin switched on in the MiMo console — Xiaomi bills searches separately.',
      toggleControl(config.webSearch === true, async (v) => {
        await writeMimoConfig({ webSearch: v })
      })),

    settingRow('News sources',
      `Fourteen feeds, fetched straight from the publisher so every story has a real link: ${sourceNames}. MiMo only ranks and summarises; it never adds a story that is not in a feed or a citation.`,
      (() => {
        const b = el('button.btn.btn--quiet.btn--sm', { text: 'Refresh news' })
        b.addEventListener('click', () => onRefresh?.())
        return b
      })()),
  ]
}
