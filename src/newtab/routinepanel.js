// The Routines view of the sidebar: the two routines every board ships with,
// what is being tracked right now, how far the search has had to widen, the
// routines learned so far, and the activity log. All of it in the open, next
// to the tabs it is about, rather than behind Settings.
//
// This module only draws. Every tap is handed back to the board through
// `actions`, because the board owns the confirm dialog and the undo toast.

import { el, faviconEl } from '../lib/util.js'
import { icon } from '../lib/icons.js'
import { timeAgo } from '../lib/news.js'
import { hourLabel, ROUTINE_MIN_REPEATS, ROUTINE_MIN_DAYS, ROUTINE_EVENT_DAYS, BUILT_IN_ROUTINES } from '../lib/routines.js'

const RECENT_EVENTS = 6
const RECENT_LOG = 8

/**
 * @param {object} deps
 * @param {(id: string) => HTMLElement} deps.$
 * @param {object} deps.actions   accept, decline, run, skip, forget, runBuiltin, setTracking
 */
export function mountRoutinePanel({ $, actions }) {
  /** @param {{store: object, report: Array, now: number}} snap */
  function render(snap) {
    const host = $('routines-body')
    if (!snap) { host.replaceChildren(); return }
    const { store, report, now } = snap
    host.replaceChildren(
      builtinCard(store, now),
      trackingCard(store, now),
      searchCard(store, report),
      routinesCard(store, now),
      activityCard(store),
    )
  }

  // --------------------------------------------------------- live tracking

  function trackingCard(store, now) {
    const on = store.tracking !== false
    const lastHour = store.events.filter((e) => now - e.t <= 60 * 60 * 1000).length
    const recent = [...store.events].sort((a, b) => b.t - a.t).slice(0, RECENT_EVENTS)

    const toggle = el('button.btn.btn--quiet.btn--sm', { text: on ? 'Pause' : 'Resume' })
    toggle.addEventListener('click', () => actions.setTracking(!on))

    return el('div.rp-card', {}, [
      head(on ? 'live' : 'paused', on ? 'Tracking live' : 'Tracking paused', toggle),
      el('div.rp-card__line', {
        text: `${store.events.length} tab event${store.events.length === 1 ? '' : 's'} in the last ${ROUTINE_EVENT_DAYS} days · ${lastHour} in the last hour`,
      }),
      recent.length
        ? el('div.rp-events', {}, recent.map((e) => el('div.rp-event', {}, [
          el('span.rp-event__kind', { text: e.k === 'close' ? 'closed' : 'opened', class: `rp-event__kind rp-event__kind--${e.k}` }),
          faviconEl({ url: e.u || `https://${e.h}/`, favicon: '' }, true),
          el('span.rp-event__host', { text: e.h, title: e.ti || e.h }),
          el('span.rp-event__when', { text: timeAgo(new Date(e.t).toISOString(), now) }),
        ])))
        : el('div.rp-card__muted', { text: on ? 'Open a web page and it shows up here.' : 'Nothing is recorded while paused.' }),
    ])
  }

  // ---------------------------------------------------------- the search

  function searchCard(store, report) {
    const rows = report.map((r) => {
      const state = {
        found: 'found one',
        known: 'matched a routine',
        nothing: 'no repeat yet',
        empty: 'no events',
        skipped: '—',
      }[r.state] ?? r.state
      return el(`div.rp-span.rp-span--${r.state}`, {}, [
        el('span.rp-span__label', { text: r.label }),
        el('span.rp-span__count', { text: `${r.events} event${r.events === 1 ? '' : 's'}` }),
        el('span.rp-span__state', { text: state }),
      ])
    })
    const widened = report.findIndex((r) => r.state === 'found')
    const summary = widened === -1
      ? `Looking for the same sites opened (or closed) together ${ROUTINE_MIN_REPEATS} separate times. The window starts at an hour and widens until something repeats.`
      : `Found a repeat in the ${report[widened].label.toLowerCase()} window.`
    return el('div.rp-card', {}, [
      head('search', 'Looking for patterns'),
      el('div.rp-card__line', { text: summary }),
      el('div.rp-spans', {}, rows),
      el('div.rp-card__muted', { text: `Short windows count separate bursts; the 7- and 30-day windows need the same hour on ${ROUTINE_MIN_DAYS} different days.` }),
    ])
  }

  // ------------------------------------------------------------ built-in

  function builtinCard(store, now) {
    const busy = store.busyBuiltin ?? null
    return el('div.rp-card.rp-card--demo', {}, [
      head('demo', 'Ready to run'),
      el('div.rp-routines', {}, BUILT_IN_ROUTINES.map((b) => {
        const last = store.builtin?.[b.id]?.lastRunAt
        const run = btn(busy === b.id ? 'Working…' : b.action, 'primary', () => actions.runBuiltin(b))
        run.disabled = Boolean(busy)
        return el('div.rp-routine.rp-routine--ready', {}, [
          el('div.rp-routine__top', {}, [
            el('div.rp-routine__name', { text: b.name }),
            el('span.rp-status.rp-status--ready', { text: last ? 'ran ' + timeAgo(new Date(last).toISOString(), now) : 'ready' }),
          ]),
          el('div.rp-routine__desc', { text: b.description }),
          el('div.rp-actions', {}, [run]),
        ])
      })),
      el('div.rp-card__muted', { text: 'Both ask before touching the board or your tabs, and both can be undone from the toast.' }),
    ])
  }

  // ------------------------------------------------------------ routines

  function routinesCard(store, now) {
    const list = [...store.routines].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt)
    return el('div.rp-card', {}, [
      head('routines', `Learned${list.length ? ` · ${list.length}` : ''}`),
      list.length
        ? el('div.rp-routines', {}, list.map((r) => routineRow(r, now)))
        : el('div.rp-card__muted', { text: 'Nothing learned yet. Open the same sites together three times and the offer appears here and at the top of Open tabs.' }),
    ])
  }

  function rank(r) {
    return { offered: 0, accepted: 1, declined: 2 }[r.status] ?? 3
  }

  function routineRow(r, now) {
    const verb = r.kind === 'wrapup' ? 'Closes' : 'Opens'
    const when = r.byDay === false ? `seen ${r.seen}× today` : `around ${hourLabel(r.hour)} · ${r.seen} days`
    const buttons = []
    if (r.status === 'offered') {
      buttons.push(btn('Yes, set it up', 'primary', () => actions.accept(r)))
      buttons.push(btn('Not now', 'quiet', () => actions.decline(r)))
    } else if (r.status === 'accepted') {
      buttons.push(btn(r.kind === 'wrapup' ? 'Close them' : 'Open them', 'primary', () => actions.run(r)))
      buttons.push(btn('Forget', 'quiet', () => actions.forget(r)))
    } else {
      buttons.push(btn('Forget', 'quiet', () => actions.forget(r)))
    }

    return el(`div.rp-routine.rp-routine--${r.status}`, {}, [
      el('div.rp-routine__top', {}, [
        el('div.rp-routine__name', { text: r.name }),
        el(`span.rp-status.rp-status--${r.status}`, { text: r.status }),
      ]),
      r.description ? el('div.rp-routine__desc', { text: r.description }) : null,
      el('div.rp-routine__sub', { text: `${verb} ${r.hosts.length} sites · ${when}${r.lastRunAt ? ` · last run ${timeAgo(new Date(r.lastRunAt).toISOString(), now)}` : ''}` }),
      el('div.rp-hosts', {}, r.hosts.map((h, i) => el('span.rp-host', { title: r.titles[i] || h }, [
        faviconEl({ url: r.urls[i], favicon: '' }, true), el('span', { text: h }),
      ]))),
      el('div.rp-actions', {}, buttons),
    ])
  }

  // ------------------------------------------------------------ activity

  function activityCard(store) {
    const entries = store.log.slice(-RECENT_LOG).reverse()
    return el('div.rp-card', {}, [
      head('log', 'Activity'),
      entries.length
        ? el('div.rp-log', {}, entries.map((e) => el('div.rp-log__row', {}, [
          el('span.rp-log__when', { text: timeAgo(new Date(e.t).toISOString()) }),
          el('span.rp-log__what', {}, [el('b', { text: e.action }), e.name ? ` · ${e.name}` : '', e.reason ? ` — ${e.reason}` : '']),
        ])))
        : el('div.rp-card__muted', { text: 'Every offer, accept, decline, run and undo is written here, with its reason.' }),
    ])
  }

  // --------------------------------------------------------------- bits

  function head(kind, title, control = null) {
    const iconName = { live: 'repeat', paused: 'repeat', search: 'search', routines: 'layers', demo: 'flame', log: 'note' }[kind] ?? 'repeat'
    return el('div.rp-card__head', {}, [
      el(`span.rp-dot.rp-dot--${kind}`),
      icon(iconName, { size: 13 }),
      el('span.rp-card__title', { text: title }),
      el('span.spacer'),
      control,
    ])
  }

  function btn(label, tone, onClick) {
    const b = el(`button.btn.btn--${tone === 'primary' ? 'primary' : 'quiet'}.btn--sm`, { text: label })
    b.addEventListener('click', onClick)
    return b
  }

  return { render }
}
