// Auto-tagging: generates tags for bookmarks using MiMo.
//
// Called after a tab is saved so the bookmark gets smart tags without the user
// having to think about it. Every call is fire-and-forget from the caller's
// point of view — the tags appear on the bookmark once MiMo replies, and the
// board re-renders through the normal store change cycle.

import { mimoChat, parseJsonReply, readMimoConfig } from './mimo.js'

/**
 * Ask MiMo to generate 3–5 short tags for a bookmark.
 *
 * @param {object} opts
 * @param {string}  opts.title   page title
 * @param {string}  opts.url     page URL
 * @param {string} [opts.folder] folder name, for context
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string[]>}  empty array when tagging is skipped or fails
 */
export async function generateTags({ title, url, folder, signal } = {}) {
  const { apiKey, autoTag } = await readMimoConfig()
  if (!apiKey || autoTag === false) return []

  const prompt = `Generate 3-5 short tags (1-2 words each, lowercase) for this bookmark.

Title: ${title || url}
URL: ${url}${folder ? `\nFolder: ${folder}` : ''}

Rules:
- Tags should describe the topic, technology, or purpose
- Use existing conventions: "react", "css", "ai", "tool", "docs", "video", etc.
- No duplicates, no spaces in tags, keep them concise
- Return ONLY a JSON object: {"tags": ["tag1", "tag2", "tag3"]}`

  try {
    const { text } = await mimoChat({
      apiKey,
      messages: [{ role: 'user', content: prompt }],
      json: true,
      temperature: 0.2,
      maxTokens: 200,
      signal,
    })
    const parsed = parseJsonReply(text)
    if (Array.isArray(parsed.tags)) {
      return parsed.tags
        .map((t) => String(t).trim().toLowerCase().replace(/\s+/g, '-'))
        .filter(Boolean)
        .slice(0, 5)
    }
  } catch {
    // Silently skip tagging on any error — the bookmark is already saved.
  }
  return []
}

/**
 * In-flight tag requests, keyed by normalised URL. If the same URL is saved
 * again before the first request finishes, the earlier one is aborted.
 */
const inflight = new Map()

/**
 * Fire-and-forget: generate tags and add them to an existing bookmark.
 *
 * @param {object}  opts
 * @param {object}  opts.store    the Store instance
 * @param {string}  opts.itemId   id of the bookmark that was just created
 * @param {string}  opts.title    page title
 * @param {string}  opts.url      page URL
 * @param {string} [opts.folder]  folder name, for prompt context
 */
export function autoTag({ store, itemId, title, url, folder }) {
  const key = normUrl(url)

  // Abort any in-flight request for the same URL.
  const prev = inflight.get(key)
  if (prev) prev.abort()

  const controller = new AbortController()
  inflight.set(key, controller)

  generateTags({ title, url, folder, signal: controller.signal })
    .then((tags) => {
      inflight.delete(key)
      if (!tags.length) return
      for (const tag of tags) {
        store.dispatch('addTag', { itemId, tag })
      }
    })
    .catch(() => { inflight.delete(key) })
}

function normUrl(url) {
  return String(url ?? '').replace(/\/+$/, '').toLowerCase()
}
