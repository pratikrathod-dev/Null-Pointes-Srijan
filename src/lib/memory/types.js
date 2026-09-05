// Shared constants and helpers for the Hybrid Memory & Retrieval system.

/** Importance levels returned by the importance engine. */
export const IMPORTANCE = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' }

/** Storage key for temporary browsing context — separate from board state. */
export const TEMP_MEMORY_KEY = 'tabspace.tempMemory'

/** How long temporary entries live before automatic cleanup (7 days). */
export const TEMP_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Maximum temporary entries before oldest are pruned. */
export const TEMP_MAX_ENTRIES = 500

/** Extract domain from a URL, stripping www. */
export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

/** Normalise a URL for deduplication. */
export function normUrl(url) {
  return String(url ?? '').replace(/\/+$/, '').toLowerCase()
}

/** Tokenise text into lowercase words, stripping common noise. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'are',
  'this', 'that', 'not', 'no', 'do', 'does', 'did', 'has', 'have',
  'had', 'will', 'can', 'may', 'its', 'you', 'your', 'we', 'they',
  'he', 'she', 'how', 'what', 'when', 'where', 'which', 'who', 'whom',
  'why', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'than', 'too', 'very', 'just', 'about', 'above',
  'into', 'through', 'during', 'before', 'after', 'out', 'up', 'down',
])

export function tokenise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
}
