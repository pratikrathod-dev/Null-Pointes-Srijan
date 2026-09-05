// Learned routines: notice what a person does with their tabs over and over,
// and offer -- never perform -- the repeated part.
//
// Everything here is device-local, under one chrome.storage.local key, and
// never enters the board state: routines are about *this machine's* tabs, and
// the event log would eat the sync quota in days. Detection is deterministic
// and runs entirely here; MiMo is only asked to *name* a routine, and sees
// hostnames, titles, an hour of day and a day count -- never a URL path, never
// page content, never anything from the board.
//
// Nothing in this file opens or closes a tab. It records, detects, and
// remembers what the person decided; the board owns the tap and the confirm.

import { uid } from './util.js'
import { mimoChat, parseJsonReply } from './mimo.js'

export const ROUTINE_MIN_DAYS = 3          // long spans: repeats on this many distinct days before it is offered
export const ROUTINE_MIN_REPEATS = 3       // short spans: the same sites together this many separate times
export const ROUTINE_EVENT_DAYS = 30       // rolling window of tab events kept
export const ROUTINE_EVENT_CAP = 3000      // hard cap on stored events, whatever the window says
export const ROUTINE_LOG_CAP = 200         // hard cap on the action log
export const ROUTINE_MIN_HOSTS = 2         // a routine is a cluster, not one site
export const ROUTINE_HOUR_SLACK = 1        // "same time of day" means within this many hours

// Detection looks at the shortest span first and widens until something
// repeats: the same sites together three times inside an hour is a routine
// worth offering today, not in a week. Short spans count separate bursts of
// activity; the long ones fall back to "same hour on different days".
export const ROUTINE_SPANS = [
  { id: '1h', label: 'Last hour', ms: 60 * 60 * 1000, burstGapMs: 8 * 60 * 1000, byDay: false },
  { id: '6h', label: 'Last 6 hours', ms: 6 * 60 * 60 * 1000, burstGapMs: 20 * 60 * 1000, byDay: false },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000, burstGapMs: 45 * 60 * 1000, byDay: false },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000, byDay: true },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000, byDay: true },
]

const STORAGE_KEY = 'tabspace.routines'
const TABMAP_KEY = 'tabspace.routines.tabs'   // chrome.storage.session: tabId → what it showed
const DAY = 24 * 60 * 60 * 1000
const TITLE_MAX = 80
const URL_MAX = 300

// ================================================================ storage ===

export function emptyRoutineStore() {
  return { tracking: true, events: [], routines: [], log: [] }
}

export async function readRoutineStore() {
  const got = await chrome.storage.local.get(STORAGE_KEY)
  const raw = got?.[STORAGE_KEY]
  const base = emptyRoutineStore()
  if (!raw || typeof raw !== 'object') return base
  return {
    tracking: raw.tracking !== false,
    events: Array.isArray(raw.events) ? raw.events : [],
    routines: Array.isArray(raw.routines) ? raw.routines : [],
    log: Array.isArray(raw.log) ? raw.log : [],
  }
}

export async function writeRoutineStore(store) {
  await chrome.storage.local.set({ [STORAGE_KEY]: prune(store) })
}

// The service worker can get two tab events in the same tick; a read-modify-
// write per event would lose one. Every write goes through this chain.
let chain = Promise.resolve()
export function updateRoutineStore(fn) {
  const run = async () => {
    const store = await readRoutineStore()
    const result = await fn(store)
    await writeRoutineStore(store)
    return result
  }
  chain = chain.then(run, run)
  return chain
}

/** Apply the rolling window and the caps. Returns the same object. */
export function prune(store, now = Date.now()) {
  const floor = now - ROUTINE_EVENT_DAYS * DAY
  store.events = store.events.filter((e) => e.t >= floor)
  if (store.events.length > ROUTINE_EVENT_CAP) store.events = store.events.slice(-ROUTINE_EVENT_CAP)
  if (store.log.length > ROUTINE_LOG_CAP) store.log = store.log.slice(-ROUTINE_LOG_CAP)
  return store
}

export function logAction(store, { action, routineId = null, name = '', reason = '' }) {
  store.log.push({ t: Date.now(), action, routineId, name, reason })
  return store
}

// ========================================================== tab recording ===

// Called by the service worker. A tab counts as "opened" the first time it
// finishes loading a real web page, and again if it later lands on a different
// site; it counts as "closed" when it goes away. Extension pages, chrome://
// and the like are never recorded.

export function trackableUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null
  try {
    const u = new URL(url)
    u.hash = ''
    return u.toString().slice(0, URL_MAX)
  } catch {
    return null
  }
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

async function readTabMap() {
  try {
    const got = await chrome.storage.session.get(TABMAP_KEY)
    return got?.[TABMAP_KEY] ?? {}
  } catch {
    return {}
  }
}

async function writeTabMap(map) {
  try { await chrome.storage.session.set({ [TABMAP_KEY]: map }) } catch { /* no session area */ }
}

export async function recordTabLoaded(tabId, tab) {
  const url = trackableUrl(tab?.url)
  if (!url) return
  const h = hostOf(url)
  const map = await readTabMap()
  const previous = map[tabId]
  const ti = String(tab.title ?? '').slice(0, TITLE_MAX)
  map[tabId] = { h, ti, u: url }
  await writeTabMap(map)
  if (previous?.h === h) return                 // same site, a reload or in-site navigation
  await updateRoutineStore((store) => {
    if (!store.tracking) return
    store.events.push({ t: Date.now(), k: 'open', h, ti, u: url })
  })
}

export async function recordTabClosed(tabId) {
  const map = await readTabMap()
  const meta = map[tabId]
  if (!meta) return
  delete map[tabId]
  await writeTabMap(map)
  await updateRoutineStore((store) => {
    if (!store.tracking) return
    store.events.push({ t: Date.now(), k: 'close', h: meta.h, ti: meta.ti, u: meta.u })
  })
}

// ============================================================== detection ===

function dayKey(t) {
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function hourDistance(a, b) {
  const d = Math.abs(a - b)
  return Math.min(d, 24 - d)
}

/**
 * Hosts that recur on ROUTINE_MIN_DAYS distinct days around the same hour.
 * Returns [{ host, hour, days: Set<string>, url, title }] -- the hour is the
 * centre of the band where that host recurs most.
 */
function recurringHosts(events) {
  const byHost = new Map()
  for (const e of events) {
    if (!e.h) continue
    const list = byHost.get(e.h) ?? []
    list.push(e)
    byHost.set(e.h, list)
  }

  const out = []
  for (const [host, list] of byHost) {
    // The hour this host is opened at most often, so a band that merely brushes
    // the real time (9:05 counted under an 8 o'clock centre) does not win a tie.
    const hourCounts = new Map()
    for (const e of list) {
      const h = new Date(e.t).getHours()
      hourCounts.set(h, (hourCounts.get(h) ?? 0) + 1)
    }
    const mode = [...hourCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]

    let best = null
    for (let centre = 0; centre < 24; centre += 1) {
      const days = new Set()
      for (const e of list) {
        if (hourDistance(new Date(e.t).getHours(), centre) <= ROUTINE_HOUR_SLACK) days.add(dayKey(e.t))
      }
      if (days.size < ROUTINE_MIN_DAYS) continue
      const better = !best
        || days.size > best.days.size
        || (days.size === best.days.size && hourDistance(centre, mode) < hourDistance(best.centre, mode))
      if (better) best = { centre, days }
    }
    if (!best) continue

    // The URL to reopen: the one this host was opened at most often in the band.
    const counts = new Map()
    let title = ''
    for (const e of list) {
      if (hourDistance(new Date(e.t).getHours(), best.centre) > ROUTINE_HOUR_SLACK) continue
      counts.set(e.u, (counts.get(e.u) ?? 0) + 1)
      title = e.ti || title
    }
    const url = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? `https://${host}/`
    out.push({ host, hour: best.centre, days: best.days, url, title })
  }
  return out
}

/** Group recurring hosts whose bands overlap into one cluster per hour band. */
function clusterByHour(hosts) {
  const sorted = [...hosts].sort((a, b) => a.hour - b.hour)
  const clusters = []
  for (const h of sorted) {
    const home = clusters.find((c) => c.some((m) => hourDistance(m.hour, h.hour) <= ROUTINE_HOUR_SLACK))
    if (home) home.push(h)
    else clusters.push([h])
  }
  return clusters
    .filter((c) => c.length >= ROUTINE_MIN_HOSTS)
    .map((members) => {
      // Days on which at least two of the members showed up together.
      const dayCounts = new Map()
      for (const m of members) for (const d of m.days) dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1)
      const together = [...dayCounts.entries()].filter(([, n]) => n >= 2).map(([d]) => d).sort()
      const hour = Math.round(members.reduce((s, m) => s + m.hour, 0) / members.length) % 24
      return { members, days: together, hour }
    })
    .filter((c) => c.days.length >= ROUTINE_MIN_DAYS)
    .sort((a, b) => b.members.length - a.members.length || b.days.length - a.days.length)
}

export function routineSignature(kind, hosts) {
  return `${kind}|${[...hosts].sort().join(',')}`
}

function overlapsExisting(kind, hosts, existing) {
  const set = new Set(hosts)
  return existing.some((r) => {
    if (r.kind !== kind) return false
    const shared = r.hosts.filter((h) => set.has(h)).length
    return shared >= Math.ceil(Math.min(r.hosts.length, hosts.length) * 2 / 3)
  })
}

// ---- short spans: bursts of activity ---------------------------------------

/** Consecutive events closer than `gapMs` form one burst. */
function bursts(events, gapMs) {
  const sorted = [...events].sort((a, b) => a.t - b.t)
  const out = []
  for (const e of sorted) {
    const cur = out[out.length - 1]
    if (cur && e.t - cur.end <= gapMs) { cur.end = e.t; cur.events.push(e) }
    else out.push({ start: e.t, end: e.t, events: [e] })
  }
  for (const b of out) b.hosts = new Set(b.events.map((e) => e.h))
  return out
}

/**
 * Sites that show up together in ROUTINE_MIN_REPEATS separate bursts. Returns
 * the same cluster shape as clusterByHour so makeRoutine can take either.
 */
function detectSessionCluster(events, span) {
  const all = bursts(events, span.burstGapMs)
  if (all.length < ROUTINE_MIN_REPEATS) return null

  const count = new Map()
  for (const b of all) for (const h of b.hosts) count.set(h, (count.get(h) ?? 0) + 1)
  const cands = [...count.entries()]
    .filter(([, n]) => n >= ROUTINE_MIN_REPEATS)
    .sort((a, b) => b[1] - a[1])
    .map(([h]) => h)
  if (cands.length < ROUTINE_MIN_HOSTS) return null

  for (const seed of cands) {
    const together = (a, b) => all.filter((x) => x.hosts.has(a) && x.hosts.has(b)).length
    const mates = cands.filter((h) => h !== seed && together(seed, h) >= ROUTINE_MIN_REPEATS)
    if (!mates.length) continue
    const names = [seed, ...mates]
    const occ = all.filter((x) => names.filter((h) => x.hosts.has(h)).length >= 2)
    if (occ.length < ROUTINE_MIN_REPEATS) continue

    const members = names.map((host) => {
      const counts = new Map()
      let title = ''
      for (const x of occ) for (const e of x.events) {
        if (e.h !== host) continue
        counts.set(e.u, (counts.get(e.u) ?? 0) + 1)
        title = e.ti || title
      }
      const url = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? `https://${host}/`
      return { host, hour: modeHour(occ.map((x) => x.start)), url, title }
    })
    // Simulated only if every event *of these sites* was seeded; a real tab
    // that happened to open in the same burst does not make it real.
    const sim = occ.every((x) => x.events.filter((e) => names.includes(e.h)).every((e) => e.sim === true))
    return {
      members,
      days: [...new Set(occ.map((x) => dayKey(x.start)))].sort(),
      occurrences: occ.length,
      hour: modeHour(occ.map((x) => x.start)),
      sim,
    }
  }
  return null
}

function modeHour(times) {
  const counts = new Map()
  for (const t of times) {
    const h = new Date(t).getHours()
    counts.set(h, (counts.get(h) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
}

// ---- the search -------------------------------------------------------------

/**
 * Walk the spans, shortest first, and return the first not-yet-offered
 * routine plus a report of what each span held -- the report is what the
 * Routines panel shows while nothing has repeated yet.
 *
 *   morning -- sites opened together (same burst, or same hour on several days)
 *   wrapup  -- sites closed together
 *
 * A cluster that is (mostly) the same as a routine already offered, accepted
 * or declined is not offered again.
 */
export function detectRoutineReport(store, now = Date.now()) {
  const events = prune({ ...store, events: [...store.events] }, now).events
  const report = []
  let routine = null

  for (const span of ROUTINE_SPANS) {
    const inSpan = events.filter((e) => now - e.t <= span.ms)
    const entry = { span: span.id, label: span.label, events: inSpan.length, found: null, state: 'empty' }
    report.push(entry)
    if (routine) { entry.state = 'skipped'; continue }
    if (!inSpan.length) continue
    entry.state = 'nothing'

    for (const [kind, k] of [['morning', 'open'], ['wrapup', 'close']]) {
      const ofKind = inSpan.filter((e) => e.k === k)
      const clusters = span.byDay
        ? clusterByHour(recurringHosts(ofKind))
        : [detectSessionCluster(ofKind, span)].filter(Boolean)
      for (const cluster of clusters) {
        const names = cluster.members.map((m) => m.host)
        if (overlapsExisting(kind, names, store.routines)) { entry.state = 'known'; continue }
        routine = makeRoutine(kind, cluster, span)
        entry.found = routine.name
        entry.state = 'found'
        break
      }
      if (routine) break
    }
  }
  return { routine, report }
}

export function detectRoutine(store, now = Date.now()) {
  return detectRoutineReport(store, now).routine
}

function makeRoutine(kind, cluster, span) {
  const hosts = cluster.members.map((m) => m.host)
  const seen = cluster.occurrences ?? cluster.days.length
  return {
    id: uid(),
    kind,
    name: fallbackName(kind, hosts, cluster.hour),
    description: '',
    named: false,                                   // true once MiMo has named it
    hosts,
    urls: cluster.members.map((m) => m.url),
    titles: cluster.members.map((m) => m.title),
    hour: cluster.hour,
    days: cluster.days,
    seen,
    span: span.id,
    byDay: span.byDay,
    sim: cluster.sim === true,
    status: 'offered',
    signature: routineSignature(kind, hosts),
    createdAt: Date.now(),
    lastRunAt: null,
    lastPromptedAt: null,
  }
}

export function fallbackName(kind, hosts, hour) {
  const when = hourLabel(hour)
  const list = hosts.slice(0, 3).map((h) => h.split('.')[0]).join(', ')
  return kind === 'wrapup' ? `Wrap-up around ${when}` : `${list} around ${when}`
}

export function hourLabel(hour) {
  const h = ((hour % 24) + 24) % 24
  const suffix = h < 12 ? 'am' : 'pm'
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve} ${suffix}`
}

/**
 * True when `now` falls inside a routine's hour band. A routine learned from
 * bursts inside a day has no time-of-day signal, so it is always due.
 */
export function inBand(routine, now = Date.now()) {
  if (routine.byDay === false) return true
  return hourDistance(new Date(now).getHours(), routine.hour) <= ROUTINE_HOUR_SLACK
}

export function isToday(t, now = Date.now()) {
  return t != null && dayKey(t) === dayKey(now)
}

// ============================================================== simulation ===

// A pretend morning, so the whole offer -> confirm -> run -> undo flow can be
// seen without waiting for a real habit to form. Every seeded event and any
// routine learned from them is marked `sim`, so they can be cleared without
// touching the real record, which keeps being written underneath.
export const SIMULATION_SITES = [
  { h: 'github.com', u: 'https://github.com/notifications', ti: 'Notifications - GitHub' },
  { h: 'mail.google.com', u: 'https://mail.google.com/mail/u/0/#inbox', ti: 'Inbox - Gmail' },
  { h: 'notion.so', u: 'https://www.notion.so/', ti: 'Team workspace - Notion' },
  { h: 'calendar.google.com', u: 'https://calendar.google.com/calendar/u/0/r', ti: 'Google Calendar' },
]

/** Three bursts of the simulation sites inside the last hour. */
export function simulationEvents(now = Date.now()) {
  const out = []
  for (const minutesAgo of [52, 31, 9]) {
    SIMULATION_SITES.forEach((site, i) => {
      out.push({ t: now - minutesAgo * 60 * 1000 + i * 45 * 1000, k: 'open', h: site.h, ti: site.ti, u: site.u, sim: true })
    })
  }
  return out
}

export function hasSimulation(store) {
  return store.events.some((e) => e.sim) || store.routines.some((r) => r.sim)
}

export function clearSimulation(store) {
  store.events = store.events.filter((e) => !e.sim)
  store.routines = store.routines.filter((r) => !r.sim)
  return store
}

// =================================================================== MiMo ===

/**
 * Ask MiMo for a name and a one-line description. Exactly what crosses the
 * wire: hostnames, tab titles (≤ 80 chars), the hour, the weekdays it recurred
 * on, and how many days. No URLs, no page content, nothing from the board.
 */
export async function nameRoutine({ apiKey, routine, signal }) {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const days = [...new Set(routine.days.map((d) => weekdays[new Date(`${d}T12:00:00`).getDay()]))]
  const verb = routine.kind === 'wrapup' ? 'closes' : 'opens'
  const howOften = routine.byDay === false
    ? `${routine.seen} separate times today`
    : `on ${routine.seen} different days (${days.join(', ')})`

  const user = [
    `A person ${verb} these browser tabs together around ${hourLabel(routine.hour)}, and has done so ${howOften}.`,
    '',
    JSON.stringify(routine.hosts.map((h, i) => ({ site: h, title: routine.titles[i] || '' }))),
    '',
    'Give this habit a short, friendly name (at most 4 words, no quotes, no punctuation at the end) and one plain sentence (at most 100 characters) describing what it does. Do not mention AI or the word "routine".',
    'Reply with JSON only: {"name":"...","description":"..."}',
  ].join('\n')

  const { text } = await mimoChat({
    apiKey,
    messages: [
      { role: 'system', content: 'You name repeated browsing habits in a warm, specific, brief way. You never invent details that are not in the data.' },
      { role: 'user', content: user },
    ],
    json: true,
    temperature: 0.4,
    maxTokens: 120,
    signal,
  })
  const parsed = parseJsonReply(text)
  const name = String(parsed?.name ?? '').trim().replace(/[.!]+$/, '').slice(0, 40)
  const description = String(parsed?.description ?? '').trim().slice(0, 120)
  if (!name) throw new Error('MiMo did not return a name.')
  return { name, description }
}
