// Small shared helpers. No dependencies — this project has no build step.

/** Monotonic-ish unique id. Collision-safe enough for a single-user board. */
let idCounter = 0
export function uid() {
  idCounter = (idCounter + 1) % 1000
  return `${Date.now().toString(36)}${idCounter.toString(36).padStart(2, '0')}`
}

/** Stable per-installation device id, used to ignore our own sync echoes. */
export function deviceId() {
  let id = localStorage.getItem('deviceId')
  if (!id) {
    id = (crypto.randomUUID?.() ?? uid())
    localStorage.setItem('deviceId', id)
  }
  return id
}

export function debounce(fn, ms) {
  let t = null
  const wrapped = (...args) => {
    clearTimeout(t)
    t = setTimeout(() => { t = null; fn(...args) }, ms)
  }
  wrapped.flush = (...args) => {
    if (t !== null) { clearTimeout(t); t = null; fn(...args) }
  }
  wrapped.cancel = () => { clearTimeout(t); t = null }
  wrapped.pending = () => t !== null
  return wrapped
}

/** Ordering helper: next position at the end of a list. */
export function nextPosition(list) {
  return list.reduce((max, x) => Math.max(max, x.position ?? 0), 0) + 1000
}

/** Ordering helper: a position that sorts between two neighbours. */
export function positionBetween(before, after) {
  if (before == null && after == null) return 1000
  if (before == null) return after.position - 1000
  if (after == null) return before.position + 1000
  return (before.position + after.position) / 2
}

export function bySortPosition(a, b) {
  return (a.position ?? 0) - (b.position ?? 0)
}

/** Chrome's own favicon service — no network call to a third party. */
export function faviconUrl(pageUrl, size = 32) {
  try {
    const u = new URL(chrome.runtime.getURL('/_favicon/'))
    u.searchParams.set('pageUrl', pageUrl)
    u.searchParams.set('size', String(size))
    return u.toString()
  } catch {
    return ''
  }
}

/**
 * The last-resort icon: a plain globe outline, no lettering. Only used when a
 * site genuinely has no icon anywhere.
 */
export function genericTile() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"'
    + ' fill="none" stroke="#5f6368" stroke-width="1.6" stroke-linecap="round">'
    + '<circle cx="12" cy="12" r="8.5"/>'
    + '<path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5z"/>'
    + '</svg>'
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

// Whether the two public icon services may be used. They are the only step that
// leaves the machine, so the board makes it a setting.
let allowOnlineIcons = true
export function setOnlineIcons(enabled) { allowOnlineIcons = enabled !== false }

/**
 * Where to look for a site's icon, best first.
 *
 * Chrome's own cache comes first — it is local, free and the only source whose
 * pixels can be measured. But it only knows sites this profile has actually
 * visited, and a great many modern sites (Notion, Grok, v0, Perplexity…) are
 * single-page apps that 404 on /favicon.ico and declare their icon through a
 * build-hashed <link rel="icon"> instead. A URL captured months ago goes stale
 * when they redeploy. The two public services resolve all of those correctly,
 * so they are the reliable catch-all at the end.
 */
function iconSources({ url, favicon }) {
  const chain = []
  if (url) chain.push(faviconUrl(url))
  if (favicon) chain.push(favicon)

  let host = ''
  try { host = new URL(url).hostname } catch { /* not a real URL */ }

  if (host) {
    chain.push(`https://${host}/favicon.ico`)
    if (allowOnlineIcons) {
      chain.push(`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`)
      chain.push(`https://icons.duckduckgo.com/ip3/${host}.ico`)
    }
  }

  chain.push(genericTile())
  return chain
}

// Chrome's /_favicon/ endpoint answers 200 with a generic placeholder for any
// URL it has no real icon for, so an `error` handler alone never fires. We
// fingerprint that placeholder once and compare against it.
let placeholderPromise = null
const analysisCache = new Map()

// Once a host resolves, remember which source won so later renders start there
// instead of walking the whole chain again.
const resolvedByHost = new Map()

function placeholderSignature() {
  placeholderPromise ??= analyse(faviconUrl('https://no-such-site.invalid')).catch(() => null)
  return placeholderPromise
}

/**
 * Decode an icon and measure it: how much is opaque, how bright those pixels
 * are, and a hash for placeholder comparison.
 *
 * Only same-origin sources (Chrome's /_favicon/ endpoint and our inline data
 * URIs) can be read back from a canvas — a remote icon taints it. Those return
 * null, and the caller keeps the default plate.
 */
async function analyse(src) {
  if (analysisCache.has(src)) return analysisCache.get(src)

  const sameOrigin = src.startsWith('chrome-extension://') || src.startsWith('data:')
  if (!sameOrigin) return null

  const img = new Image()
  img.src = src
  await img.decode()

  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 16
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, 16, 16)
  ctx.drawImage(img, 0, 0, 16, 16)

  const { data } = ctx.getImageData(0, 0, 16, 16)
  let hash = 2166136261
  let opaque = 0
  let luma = 0

  for (let i = 0; i < data.length; i += 4) {
    hash = ((hash ^ data[i]) * 16777619) >>> 0
    hash = ((hash ^ data[i + 3]) * 16777619) >>> 0
    if (data[i + 3] <= 24) continue
    opaque += 1
    // Rec. 709 luma, good enough for a light/dark decision.
    luma += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
  }

  const result = { hash, opaque, brightness: opaque ? luma / opaque : 0 }
  analysisCache.set(src, result)
  return result
}

/** True if this icon is blank, or is Chrome's "no icon known" placeholder. */
async function isUninformative(src) {
  try {
    const mine = await analyse(src)
    if (!mine) return false                        // remote icon: take it at its word
    if (mine.opaque < 8) return true               // essentially empty
    const placeholder = await placeholderSignature()
    return Boolean(placeholder) && mine.hash === placeholder.hash
  } catch {
    return false
  }
}

/**
 * A favicon on a plate whose colour is chosen from the icon itself: a pale or
 * white icon gets a dark plate, a dark one gets a white plate. Both stay
 * legible in either theme, and nothing is drawn over the artwork.
 */
export function faviconEl(source, small = false) {
  const wrap = document.createElement('span')
  wrap.className = `favicon${small ? ' favicon--sm' : ''}`

  const img = document.createElement('img')
  img.alt = ''
  img.loading = 'lazy'
  img.referrerPolicy = 'no-referrer'
  wrap.append(img)

  let host = ''
  try { host = new URL(source.url).hostname } catch { /* not a real URL */ }

  const chain = iconSources(source)
  // A host we have already resolved starts from its winner.
  const known = host && resolvedByHost.get(host)
  let step = known ? Math.max(0, chain.indexOf(known)) : 0

  const paintPlate = async (src) => {
    const measured = await analyse(src).catch(() => null)
    if (!measured || !measured.opaque) return
    // Above this the artwork is essentially white and would vanish on white.
    wrap.classList.toggle('favicon--onDark', measured.brightness > 0.7)
  }

  const advance = () => {
    step += 1
    if (step < chain.length) img.src = chain[step]
    else cleanup()
  }

  const onLoad = async () => {
    const src = chain[step]
    if (step < chain.length - 1 && await isUninformative(src)) { advance(); return }
    if (host && src !== genericTile()) resolvedByHost.set(host, src)
    await paintPlate(src)
    cleanup()
  }

  const cleanup = () => {
    img.removeEventListener('error', advance)
    img.removeEventListener('load', onLoad)
  }

  img.addEventListener('error', advance)
  img.addEventListener('load', onLoad)
  img.src = chain[step]
  return wrap
}

/** Forget cached results so every icon is looked up again. */
export function forgetFavicons() {
  resolvedByHost.clear()
  analysisCache.clear()
  placeholderPromise = null
}

// Schemes a bookmark is allowed to point at. Everything else is refused.
const SAFE_SCHEMES = new Set(['http:', 'https:', 'ftp:', 'ftps:', 'mailto:'])

/**
 * A URL that is safe to put in an href or hand to chrome.tabs.
 *
 * Bookmarks do not only come from the current browser: they arrive from
 * imported bookmark HTML and from shared backup files, and neither is
 * trustworthy. A `javascript:` or `data:` bookmark would resolve against the
 * board's own extension origin -- a far more privileged place than an ordinary
 * page -- so anything outside the browsable schemes above is refused rather
 * than rewritten into something that merely looks safe.
 *
 * Returns '' when the URL must not be followed. A scheme-less bookmark like
 * "example.com" is treated as an ordinary https address, not as an attack.
 */
export function safeUrl(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return ''

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value)
  try {
    const parsed = new URL(hasScheme ? value : `https://${value}`)
    if (!SAFE_SCHEMES.has(parsed.protocol)) return ''
    // Give back what was stored when it already carried a scheme, so the URL a
    // person saved is the URL they see and copy.
    return hasScheme ? value : parsed.href
  } catch {
    return ''
  }
}

export function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

// These are *enumerated* attributes, not boolean ones: they need the literal
// string "true"/"false". Writing draggable="" (what a boolean attribute wants)
// is an invalid value, and the element silently becomes undraggable.
const ENUMERATED_ATTRS = new Set(['draggable', 'contenteditable', 'spellcheck'])

/**
 * Tiny DOM builder: el('div.foo', {onclick}, [children]).
 *
 * There is deliberately no innerHTML option — everything goes in as text or as
 * a real node, so a bookmark title or note body can never be parsed as markup.
 */
export function el(spec, props = {}, children = []) {
  const [tag, ...classes] = spec.split('.')
  const node = document.createElement(tag || 'div')
  if (classes.length) node.className = classes.join(' ')

  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue
    if (v === false && !ENUMERATED_ATTRS.has(k)) continue
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else if (k === 'text') node.textContent = v
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v)
    else if (ENUMERATED_ATTRS.has(k)) node.setAttribute(k, v === true ? 'true' : String(v))
    else node.setAttribute(k, v === true ? '' : v)
  }

  for (const c of [].concat(children)) {
    if (c == null || c === false) continue
    node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return node
}

export function byteLength(str) {
  return new TextEncoder().encode(str).length
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}
