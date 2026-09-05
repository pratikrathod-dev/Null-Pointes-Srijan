// Xiaomi MiMo client. One model, one endpoint, one call shape.
//
// The key lives in chrome.storage.local on its own, outside the board state:
// state is synced across devices and written into backups, and an API key
// belongs in neither. Nothing here touches the DOM or chrome.* at import time,
// so the module loads under the import checker like the rest of lib/.

const STORAGE_KEY = 'tabspace.mimo'

export const MIMO_MODEL = 'mimo-v2.5-pro'

// Pay-as-you-go keys (sk-) and Token Plan keys (tp-) are served from different
// hosts, and the web-search plugin is only offered on the direct one.
const DIRECT_BASE = 'https://api.xiaomimimo.com/v1'
const TOKEN_PLAN_BASE = 'https://token-plan-cn.xiaomimimo.com/v1'

export function isTokenPlanKey(apiKey) {
  return typeof apiKey === 'string' && apiKey.trim().startsWith('tp-')
}

export function baseUrlFor(apiKey) {
  return isTokenPlanKey(apiKey) ? TOKEN_PLAN_BASE : DIRECT_BASE
}

/** @returns {Promise<{apiKey: string, webSearch: boolean}>} */
export async function readMimoConfig() {
  const got = await chrome.storage.local.get(STORAGE_KEY)
  const saved = got?.[STORAGE_KEY] ?? {}
  return {
    apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : '',
    webSearch: saved.webSearch === true,
  }
}

export async function writeMimoConfig(patch) {
  const current = await readMimoConfig()
  const next = { ...current, ...patch }
  if (typeof next.apiKey === 'string') next.apiKey = next.apiKey.trim()
  await chrome.storage.local.set({ [STORAGE_KEY]: next })
  return next
}

/** A key with the middle blanked, for showing in Settings. */
export function maskKey(apiKey) {
  const k = (apiKey ?? '').trim()
  if (k.length <= 10) return k ? '•'.repeat(k.length) : ''
  return `${k.slice(0, 6)}…${k.slice(-4)}`
}

/**
 * One chat completion.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {boolean} [opts.json]        ask for a JSON object back
 * @param {boolean} [opts.webSearch]   attach MiMo's built-in web_search tool
 * @param {number}  [opts.temperature]
 * @param {number}  [opts.maxTokens]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{text: string, citations: Array<{url: string, title: string}>, usage: object|null}>}
 */
export async function mimoChat({
  apiKey, messages, json = false, webSearch = false, temperature = 0.3, maxTokens = 4000, signal,
}) {
  const key = (apiKey ?? '').trim()
  if (!key) throw new MimoError('No MiMo API key. Add one in Settings.', 'no-key')

  const body = {
    model: MIMO_MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  }
  if (json) body.response_format = { type: 'json_object' }
  // The tool is only honoured on direct keys with the plugin switched on in the
  // MiMo console; on anything else it is rejected, so it is never sent blind.
  if (webSearch && !isTokenPlanKey(key)) body.tools = [{ type: 'web_search', web_search: {} }]

  let res = await post(key, body, signal)

  // A 400 for the response_format or tools field is the endpoint being
  // pickier than the docs; drop the optional part and go again once.
  if (res.status === 400 && (body.response_format || body.tools)) {
    const detail = await safeText(res)
    if (/response_format|tools|web_search/i.test(detail)) {
      delete body.response_format
      delete body.tools
      res = await post(key, body, signal)
    } else {
      throw new MimoError(explain(400, detail), 'bad-request')
    }
  }

  if (!res.ok) throw new MimoError(explain(res.status, await safeText(res)), `http-${res.status}`)

  const data = await res.json()
  const message = data?.choices?.[0]?.message ?? {}
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((p) => p?.text ?? '').join('')
      : ''

  const citations = []
  const seen = new Set()
  for (const a of [].concat(message.annotations ?? [], message.url_citations ?? [])) {
    const c = a?.url_citation ?? a
    const url = typeof c?.url === 'string' ? c.url : null
    if (!url || seen.has(url)) continue
    seen.add(url)
    citations.push({ url, title: typeof c.title === 'string' ? c.title : '' })
  }

  return { text, citations, usage: data?.usage ?? null }
}

/** A one-token round trip, so Settings can say whether a key works. */
export async function testMimoKey(apiKey) {
  try {
    const { text } = await mimoChat({
      apiKey,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      maxTokens: 8,
      temperature: 0,
    })
    return { ok: true, reply: text.trim() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * Pull a JSON object out of a model reply. Models that were asked for JSON
 * still sometimes wrap it in a code fence or a sentence, so the first balanced
 * object in the text is what gets parsed.
 */
export function parseJsonReply(text) {
  const raw = String(text ?? '').trim()
  try { return JSON.parse(raw) } catch { /* fall through */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    try { return JSON.parse(fenced[1]) } catch { /* fall through */ }
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch { /* fall through */ }
  }
  throw new MimoError('MiMo replied with something that was not JSON.', 'bad-json')
}

export class MimoError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'MimoError'
    this.code = code
  }
}

// ------------------------------------------------------------------ internal

async function post(key, body, signal) {
  const url = `${baseUrlFor(key)}/chat/completions`
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new MimoError(`Could not reach ${new URL(url).host} — check your connection.`, 'network')
  }
}

async function safeText(res) {
  try { return await res.text() } catch { return '' }
}

function explain(status, detail) {
  let serverMessage = ''
  try {
    const parsed = JSON.parse(detail)
    serverMessage = parsed?.error?.message ?? parsed?.message ?? ''
  } catch {
    serverMessage = detail.slice(0, 200)
  }
  if (status === 401 || status === 403) return 'MiMo rejected the API key. Check it in Settings.'
  if (status === 402) return 'MiMo says the account has no credit left.'
  if (status === 429) return 'MiMo is rate-limiting this key. Try again in a moment.'
  if (status >= 500) return `MiMo is having trouble (${status}). Try again shortly.`
  return serverMessage ? `MiMo error ${status}: ${serverMessage}` : `MiMo error ${status}.`
}
