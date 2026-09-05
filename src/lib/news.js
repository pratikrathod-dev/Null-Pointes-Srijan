// The AI-news panel's engine: real feeds in, ten ranked stories out.
//
// The proof is the link. Every story shown comes from a feed the extension
// fetched itself (or, when the web-search plugin is on, from a URL MiMo
// actually retrieved and cited) -- MiMo chooses, dedupes, and writes the one-
// line summaries, but it never invents a story or a link. Anything it returns
// that cannot be traced back to a fetched item or a citation is dropped.
//
// No DOM or chrome.* work happens at import time; DOMParser and storage are
// only touched inside the functions, so the module loads under the import
// checker like the rest of lib/.

import { mimoChat, parseJsonReply, MIMO_MODEL } from './mimo.js'

// Each one is an origin in manifest.json's host_permissions; an extension page
// may fetch cross-origin only from hosts listed there.
export const NEWS_SOURCES = [
  { name: 'OpenAI', url: 'https://openai.com/news/rss.xml', cap: 8 },
  { name: 'Google AI', url: 'https://blog.google/technology/ai/rss/', cap: 8 },
  { name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', cap: 8 },
  { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', cap: 8 },
  { name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', cap: 12 },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', cap: 10 },
  { name: 'Ars Technica', url: 'https://arstechnica.com/ai/feed/', cap: 10 },
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage?points=100', cap: 16 },
  { name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', cap: 10 },
  { name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews', cap: 8 },
  { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', cap: 8 },
  { name: 'MarkTechPost', url: 'https://www.marktechpost.com/feed/', cap: 8 },
  { name: 'The Decoder', url: 'https://the-decoder.com/feed/', cap: 8 },
  { name: 'MIT News', url: 'https://news.mit.edu/topic/mitartificial-intelligence2-rss.xml', cap: 6 },
]

const HOUR = 60 * 60 * 1000

// `repeatAfterMs`: a story that was already shown in a list fetched longer ago
// than this is left out of the next run, so today's list is not yesterday's
// again. Within that window the list stays stable across refreshes.
export const NEWS_RANGES = {
  daily: { label: 'Today', windowHours: 36, widenToHours: 96, staleMs: 4 * HOUR, repeatAfterMs: 12 * HOUR },
  weekly: { label: 'This week', windowHours: 8 * 24, widenToHours: 14 * 24, staleMs: 24 * HOUR, repeatAfterMs: 6 * 24 * HOUR },
}

export const NEWS_CATEGORIES = [
  'release', 'free', 'open-source', 'product', 'research', 'funding', 'security', 'policy',
]

export const NEWS_COUNT = 10

const FETCH_TIMEOUT_MS = 12000
const MAX_CANDIDATES = 90

// ================================================================== feeds ===

/**
 * Fetch every source in parallel and return the candidate pool for a range,
 * newest first, deduplicated, capped per source so the busiest feeds cannot
 * crowd the rest out.
 */
export async function fetchCandidates({ range = 'daily', signal } = {}) {
  const spec = NEWS_RANGES[range] ?? NEWS_RANGES.daily
  const results = await Promise.all(NEWS_SOURCES.map((source) => fetchSource(source, signal)))

  const failed = results.filter((r) => !r.ok).map((r) => r.source.name)
  let all = results.flatMap((r) => r.items)

  const now = Date.now()
  let pool = withinHours(all, spec.windowHours, now)
  // A quiet day still deserves ten stories: widen the window rather than pad.
  if (pool.length < 25) pool = withinHours(all, spec.widenToHours, now)

  pool = dedupe(pool)
  pool.sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
  pool = capPerSource(pool).slice(0, MAX_CANDIDATES)
  pool.forEach((item, i) => { item.id = `c${i + 1}` })

  return {
    items: pool,
    sources: { ok: NEWS_SOURCES.length - failed.length, total: NEWS_SOURCES.length, failed },
    windowHours: pool.length && withinHours(pool, spec.windowHours, now).length === pool.length
      ? spec.windowHours
      : spec.widenToHours,
  }
}

async function fetchSource(source, outerSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const onOuter = () => controller.abort()
  outerSignal?.addEventListener('abort', onOuter, { once: true })
  try {
    const res = await fetch(source.url, {
      signal: controller.signal,
      cache: 'no-cache',
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8' },
    })
    if (!res.ok) return { ok: false, source, items: [] }
    const text = await res.text()
    return { ok: true, source, items: parseFeed(text, source.name) }
  } catch {
    return { ok: false, source, items: [] }
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuter)
  }
}

/**
 * RSS 2.0 or Atom, whichever the feed turns out to be. Returns
 * `{ title, url, source, published, snippet }` per entry, skipping anything
 * without a title, an http(s) link, and a parseable date.
 */
export function parseFeed(xmlText, sourceName) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  if (doc.querySelector('parsererror')) return []

  const out = []
  const nodes = doc.querySelectorAll('item, entry')
  for (const node of nodes) {
    const isAtom = node.localName === 'entry'
    const title = clean(childText(node, 'title'))
    const url = isAtom ? atomLink(node) : (childText(node, 'link') || childText(node, 'guid'))
    const published = childText(node, isAtom ? 'published' : 'pubDate')
      || childText(node, isAtom ? 'updated' : 'date')
      || childText(node, 'updated')
    const body = childText(node, isAtom ? 'summary' : 'description')
      || childText(node, isAtom ? 'content' : 'encoded')
      || ''

    const when = Date.parse(published)
    if (!title || !/^https?:\/\//i.test(url) || Number.isNaN(when)) continue

    out.push({
      title: title.slice(0, 160),
      url: url.trim(),
      source: sourceName,
      published: new Date(when).toISOString(),
      snippet: clean(stripHtml(body)).slice(0, 240),
    })
  }
  return out
}

function childText(node, localName) {
  for (const child of node.children) {
    if (child.localName === localName) return (child.textContent ?? '').trim()
  }
  return ''
}

function atomLink(node) {
  let fallback = ''
  for (const child of node.children) {
    if (child.localName !== 'link') continue
    const href = child.getAttribute('href') ?? ''
    const rel = child.getAttribute('rel') ?? 'alternate'
    if (rel === 'alternate' && href) return href
    if (!fallback && href) fallback = href
  }
  return fallback
}

function stripHtml(html) {
  if (!html) return ''
  if (!/[<&]/.test(html)) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return doc.body?.textContent ?? ''
}

function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function withinHours(items, hours, now) {
  const floor = now - hours * HOUR
  return items.filter((it) => {
    const t = Date.parse(it.published)
    return t >= floor && t <= now + HOUR
  })
}

function capPerSource(items) {
  const counts = new Map()
  const caps = new Map(NEWS_SOURCES.map((s) => [s.name, s.cap]))
  return items.filter((it) => {
    const n = (counts.get(it.source) ?? 0) + 1
    counts.set(it.source, n)
    return n <= (caps.get(it.source) ?? 8)
  })
}

// Same story syndicated twice, one URL with tracking noise attached, or the
// same event under two headlines ("OpenAI releases GPT-6" / "GPT-6 is here:
// what OpenAI shipped"). Items arrive newest first, so the first telling of a
// story is the one kept.
function dedupe(items) {
  const seenUrl = new Set()
  const kept = []
  for (const it of items) {
    const u = normalizeUrl(it.url)
    if (seenUrl.has(u)) continue
    if (kept.some((k) => sameStory(k.title, it.title))) continue
    seenUrl.add(u)
    kept.push({ ...it, url: u })
  }
  return kept
}

const STOPWORDS = new Set(('a an the and or of to in on for with from by at as is are was were be been its it this that these those ' +
  'new now how why what says say said will can could just here your you we our vs via after before over into about more than').split(' '))

export function titleTokens(title) {
  // "gpt-6" → gpt, 6 ; "5.1" stays one token ; single letters go, digits stay.
  const words = String(title ?? '').toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)*/g) ?? []
  return new Set(words.filter((w) => (w.length > 2 || /^\d/.test(w)) && !STOPWORDS.has(w)))
}

/**
 * Two headlines about the same event: enough of the meaningful words overlap.
 * Generic words shared by unrelated stories ("announces", "model") are not
 * enough on their own -- at least three shared words for normal-length
 * headlines, and a short headline must be contained in the other.
 */
export function sameStory(a, b) {
  const ta = titleTokens(a)
  const tb = titleTokens(b)
  if (!ta.size || !tb.size) return titleKey(a) === titleKey(b)
  let shared = 0
  for (const w of ta) if (tb.has(w)) shared += 1
  if (shared < 2) return false
  const smaller = Math.min(ta.size, tb.size)
  const jaccard = shared / (ta.size + tb.size - shared)
  if (smaller <= 3) return shared === smaller && jaccard >= 0.4
  return shared >= 3 && (jaccard >= 0.6 || shared / smaller >= 0.75)
}

export function normalizeUrl(raw) {
  try {
    const u = new URL(raw)
    u.hash = ''
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|source$|mc_)/i.test(k)) u.searchParams.delete(k)
    }
    let s = u.toString()
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1)
    return s
  } catch {
    return raw
  }
}

function titleKey(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 64)
}

// =================================================================== MiMo ===

/**
 * Ask MiMo for the ten hottest stories out of the candidate pool.
 *
 * With `webSearch` on (direct keys only, plugin enabled in the MiMo console)
 * the model may add stories it found itself; those are kept only when their
 * URL appears among the citations the API returned, so a link is never taken
 * on the model's word alone.
 */
export async function rankWithMimo({ apiKey, webSearch = false, range = 'daily', candidates, signal }) {
  const spec = NEWS_RANGES[range] ?? NEWS_RANGES.daily
  const brief = candidates.map((c) => ({
    id: c.id,
    title: c.title,
    source: c.source,
    published: c.published.slice(0, 16).replace('T', ' '),
    snippet: c.snippet.slice(0, 200),
  }))

  const system = [
    'You are the editor of a short daily briefing on AI and the technology industry, read by developers and builders.',
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    'You pick the stories that matter most and write tight, factual one-liners. You never invent facts, names, or links.',
  ].join(' ')

  const user = [
    `Below are ${brief.length} candidate stories gathered from RSS feeds for the period "${spec.label.toLowerCase()}" (roughly the last ${spec.windowHours} hours).`,
    '',
    `Choose exactly ${NEWS_COUNT} for the briefing. What counts as hot, in priority order:`,
    '1. New AI model releases and major upgrades from any lab (frontier or open-weight), including agents, coding models, and on-device models.',
    '2. Anything released free or open-source that a developer or ordinary user can actually use now (free tiers, open weights, free tools).',
    '3. Major product launches or shutdowns from big platforms; large funding rounds, acquisitions, or leadership changes at AI companies.',
    '4. Significant research results, benchmarks, or safety findings.',
    '5. Security incidents, outages, or policy/regulation with real impact on developers.',
    '',
    'Rules:',
    '- Merge duplicates: if several candidates cover the same event, pick the one from the most authoritative source and count the event once.',
    '- Prefer a spread of sources and topics over three angles on one story.',
    '- Skip opinion pieces, listicles, sponsored content, and minor incremental updates.',
    '- "headline": rewrite as a plain, specific headline, at most 90 characters, no clickbait, no trailing period.',
    '- "summary": one sentence, at most 170 characters, saying what happened and why it matters. Facts only from the candidate text.',
    `- "category": one of ${NEWS_CATEGORIES.map((c) => `"${c}"`).join(', ')}.`,
    '- "free": true only if the story is about something people can use at no cost (free tier, open weights, free tool).',
    '- "heat": your 1-100 estimate of how much this matters to the audience this ${spec.label.toLowerCase()}.',
    webSearch
      ? '- You may also use web search to find a major story from this period that the candidates missed (for example a frontier model release from OpenAI, Anthropic, Google, Meta, xAI, Mistral, DeepSeek, Alibaba Qwen, or Xiaomi). For such a story, give "url" and "source" instead of "id", and only use a URL you actually retrieved.'
      : '- Only use candidate ids from the list. Do not add stories that are not in the list.',
    '',
    'Reply with JSON only, in this exact shape:',
    '{"items":[{"id":"c12","headline":"...","summary":"...","category":"release","free":false,"heat":90}]}',
    '',
    'Candidates:',
    JSON.stringify(brief),
  ].join('\n')

  const { text, citations } = await mimoChat({
    apiKey,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    json: true,
    webSearch,
    temperature: 0.2,
    maxTokens: 3000,
    signal,
  })

  const parsed = parseJsonReply(text)
  const raw = Array.isArray(parsed?.items) ? parsed.items : []
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const cited = new Map(citations.map((c) => [normalizeUrl(c.url), c]))

  const items = []
  const usedUrls = new Set()
  const isRepeat = (title, url) => usedUrls.has(url)
    || items.some((i) => sameStory(i.title, title) || sameStory(i.originalTitle, title))
  for (const r of raw) {
    if (items.length >= NEWS_COUNT) break
    let base = null
    if (typeof r?.id === 'string' && byId.has(r.id)) {
      base = byId.get(r.id)
    } else if (typeof r?.url === 'string') {
      const u = normalizeUrl(r.url)
      const cite = cited.get(u)
      if (!cite) continue // a link the API did not vouch for
      base = {
        title: cite.title || String(r.headline ?? '').trim(),
        url: u,
        source: String(r.source ?? '').trim() || hostOf(u),
        published: new Date().toISOString(),
        snippet: '',
        fromSearch: true,
      }
    }
    if (!base) continue
    const headline = String(r.headline ?? '').trim().slice(0, 120) || base.title
    if (isRepeat(base.title, base.url) || isRepeat(headline, base.url)) continue
    usedUrls.add(base.url)

    items.push({
      rank: items.length + 1,
      title: headline,
      originalTitle: base.title,
      url: base.url,
      source: base.source,
      published: base.published,
      summary: String(r.summary ?? '').trim().slice(0, 220) || base.snippet,
      category: NEWS_CATEGORIES.includes(r.category) ? r.category : guessCategory(base),
      free: r.free === true,
      heat: clampHeat(r.heat),
      fromSearch: base.fromSearch === true,
    })
  }

  // The model coming up short is not a reason to show fewer than ten: top up
  // from the newest unused candidates, clearly unranked (no heat).
  if (items.length < NEWS_COUNT) {
    for (const c of candidates) {
      if (items.length >= NEWS_COUNT) break
      if (isRepeat(c.title, c.url)) continue
      usedUrls.add(c.url)
      items.push(plainItem(c, items.length + 1))
    }
  }

  return { items, model: MIMO_MODEL, usedWebSearch: webSearch }
}

/** Newest-first without a model: the "preview without AI" fallback. */
export function rankPlain(candidates) {
  const scored = candidates.map((c) => ({ c, s: heuristicScore(c) }))
  scored.sort((a, b) => b.s - a.s || Date.parse(b.c.published) - Date.parse(a.c.published))
  return scored.slice(0, NEWS_COUNT).map(({ c }, i) => plainItem(c, i + 1))
}

function plainItem(c, rank) {
  return {
    rank,
    title: c.title,
    originalTitle: c.title,
    url: c.url,
    source: c.source,
    published: c.published,
    summary: c.snippet,
    category: guessCategory(c),
    free: /\b(free|open[- ]source|open[- ]weights?)\b/i.test(`${c.title} ${c.snippet}`),
    heat: null,
    fromSearch: false,
  }
}

const HOT_WORDS = /\b(releases?|launch(?:es|ed)?|announc(?:es|ed)|introduc(?:es|ing)|unveil(?:s|ed)?|open[- ]sourc(?:e|es|ed)|open[- ]weights?|gpt|claude|gemini|llama|mistral|deepseek|qwen|mimo|grok|copilot|agent|model|free)\b/i

function heuristicScore(c) {
  let s = 0
  if (HOT_WORDS.test(c.title)) s += 3
  if (/\b(openai|anthropic|google|deepmind|meta|microsoft|apple|nvidia|xai|hugging face)\b/i.test(`${c.title} ${c.source}`)) s += 2
  if (c.source === 'Hacker News') s += 1
  return s
}

function guessCategory(c) {
  const t = `${c.title} ${c.snippet}`
  if (/\b(open[- ]sourc|open[- ]weight)/i.test(t)) return 'open-source'
  if (/\bfree\b/i.test(t)) return 'free'
  if (/\b(releas|launch|introduc|unveil|announc|now available)/i.test(t)) return 'release'
  if (/\b(raises?|funding|acquir|acquisition|valuation|ipo)\b/i.test(t)) return 'funding'
  if (/\b(vulnerab|breach|exploit|malware|hack|outage|cve)\b/i.test(t)) return 'security'
  if (/\b(regulat|law|policy|court|lawsuit|ban|government|eu\b|senate)/i.test(t)) return 'policy'
  if (/\b(paper|research|study|benchmark|arxiv)\b/i.test(t)) return 'research'
  return 'product'
}

function clampHeat(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return null
  return Math.max(1, Math.min(100, Math.round(v)))
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

// ================================================================== cache ===

const cacheKey = (range) => `tabspace.news.${range}`

export async function readNewsCache(range) {
  const got = await chrome.storage.local.get(cacheKey(range))
  const saved = got?.[cacheKey(range)]
  return saved && Array.isArray(saved.items) ? saved : null
}

export async function writeNewsCache(range, payload) {
  await chrome.storage.local.set({ [cacheKey(range)]: payload })
}

export function isNewsStale(cache, range) {
  if (!cache?.fetchedAt) return true
  const spec = NEWS_RANGES[range] ?? NEWS_RANGES.daily
  return Date.now() - Date.parse(cache.fetchedAt) > spec.staleMs
}

/**
 * The whole pipeline: feeds → MiMo → cache. `onStage` gets a short status
 * string as each step starts, for the panel to show.
 *
 * With no key, `allowPlain` decides between throwing (so the panel can ask for
 * a key) and returning the newest-first fallback, flagged `ai: false`.
 */
export async function loadNews({ range = 'daily', apiKey = '', webSearch = false, allowPlain = false, signal, onStage } = {}) {
  onStage?.('Reading feeds…')
  const fetched = await fetchCandidates({ range, signal })
  const { sources, windowHours } = fetched
  // Leave out what an earlier list already showed, unless that would leave
  // too little to choose from.
  const seen = await readSeen()
  const fresh = withoutSeen(fetched.items, seen, range)
  const candidates = fresh.length >= 15 ? fresh : fetched.items
  if (!candidates.length) {
    throw new Error(sources.ok === 0
      ? 'None of the news feeds could be reached. Check your connection.'
      : 'The feeds returned nothing for this period.')
  }

  let ranked
  let ai = false
  if (apiKey) {
    onStage?.(`Asking MiMo to pick ${NEWS_COUNT} of ${candidates.length}…`)
    ranked = await rankWithMimo({ apiKey, webSearch, range, candidates, signal })
    ai = true
  } else if (allowPlain) {
    ranked = { items: rankPlain(candidates), model: null, usedWebSearch: false }
  } else {
    const err = new Error('Add your MiMo API key in Settings to rank the news.')
    err.code = 'no-key'
    throw err
  }

  const payload = {
    range,
    fetchedAt: new Date().toISOString(),
    items: ranked.items,
    ai,
    model: ranked.model,
    usedWebSearch: ranked.usedWebSearch,
    candidates: candidates.length,
    sources,
    windowHours,
  }
  await writeNewsCache(range, payload)
  await markSeen(ranked.items, seen)
  return payload
}

// ------------------------------------------------------------ seen ledger

// URL → when it was last shown, kept for two weeks. Shared by both ranges: a
// story that headlined today should not headline again tomorrow, whichever
// list it was in.
const SEEN_KEY = 'tabspace.news.seen'
const SEEN_TTL = 14 * 24 * HOUR

export async function readSeen() {
  const got = await chrome.storage.local.get(SEEN_KEY)
  const raw = got?.[SEEN_KEY]
  const now = Date.now()
  const out = {}
  if (raw && typeof raw === 'object') {
    for (const [url, iso] of Object.entries(raw)) {
      const t = Date.parse(iso)
      if (!Number.isNaN(t) && now - t < SEEN_TTL) out[url] = iso
    }
  }
  return out
}

async function markSeen(items, seen) {
  const now = new Date().toISOString()
  const next = { ...seen }
  for (const it of items) {
    // A story shown earlier keeps its first-shown time: that is what decides
    // whether it is "old news" on the next run.
    if (!next[it.url]) next[it.url] = now
  }
  await chrome.storage.local.set({ [SEEN_KEY]: next })
}

export function withoutSeen(items, seen, range, now = Date.now()) {
  const after = (NEWS_RANGES[range] ?? NEWS_RANGES.daily).repeatAfterMs
  const shownTitles = []
  const cutoff = []
  for (const [url, iso] of Object.entries(seen)) {
    if (now - Date.parse(iso) > after) cutoff.push(url)
  }
  const old = new Set(cutoff)
  for (const it of items) if (old.has(it.url)) shownTitles.push(it.title)
  return items.filter((it) => !old.has(it.url) && !shownTitles.some((t) => sameStory(t, it.title)))
}

/** "3h ago", "2d ago" -- coarse on purpose; the panel is not a clock. */
export function timeAgo(iso, now = Date.now()) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const mins = Math.max(0, Math.round((now - t) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days}d ago`
  return `${Math.round(days / 7)}w ago`
}
