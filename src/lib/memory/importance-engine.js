// Importance Engine: scores browsing items LOW / MEDIUM / HIGH.
//
// Purely observational — reads activity signals and returns a score.
// Never modifies user data or board state. Independent from core features.

import { IMPORTANCE } from './types.js'

/**
 * Compute importance for a temporary memory entry.
 *
 * Signals:
 *  - Time spent active on the page
 *  - Number of revisits (visit count)
 *  - Whether the user explicitly saved it
 *  - Recency of last visit
 *
 * @param {object} entry  A TempEntry from TemporaryMemory
 * @returns {'low' | 'medium' | 'high'}
 */
export function computeImportance(entry) {
  if (!entry) return IMPORTANCE.LOW

  // Explicit save is an immediate HIGH signal
  if (entry.saved) return IMPORTANCE.HIGH

  const score = timeScore(entry.activeDuration)
    + revisitScore(entry.visitCount)
    + recencyScore(entry.lastActive)

  // Thresholds tuned for typical browsing:
  //   0-2  -> LOW   (brief glance, single visit)
  //   3-5  -> MEDIUM (revisited or lingered)
  //   6+   -> HIGH  (strong engagement)
  if (score >= 6) return IMPORTANCE.HIGH
  if (score >= 3) return IMPORTANCE.MEDIUM
  return IMPORTANCE.LOW
}

/**
 * Score based on cumulative active time.
 *   < 30s   -> 0  (tab opened but barely viewed)
 *   30s-2m  -> 1  (quick read)
 *   2m-10m  -> 2  (engaged reading)
 *   10m+    -> 3  (deep engagement)
 */
function timeScore(ms) {
  const sec = ms / 1000
  if (sec < 30) return 0
  if (sec < 120) return 1
  if (sec < 600) return 2
  return 3
}

/**
 * Score based on how many times the user returned.
 *   1 visit   -> 0
 *   2-3       -> 1
 *   4-7       -> 2
 *   8+        -> 3
 */
function revisitScore(count) {
  if (count <= 1) return 0
  if (count <= 3) return 1
  if (count <= 7) return 2
  return 3
}

/**
 * Score based on how recently the page was active.
 *   > 7 days  -> 0
 *   1-7 days  -> 1
 *   Today     -> 2
 */
function recencyScore(lastActive) {
  const age = Date.now() - lastActive
  const day = 24 * 60 * 60 * 1000
  if (age > 7 * day) return 0
  if (age > day) return 1
  return 2
}

/**
 * Compute importance for a permanent Tabspace item (bookmark/note).
 *
 * Uses different signals since permanent items don't have browsing duration:
 *  - Number of tags (more tags = more curated)
 *  - Whether it has a URL (bookmarks are more actionable than notes)
 *  - Age since creation (newer = slightly more relevant)
 *
 * @param {object} item  A board item from the store
 * @returns {'low' | 'medium' | 'high'}
 */
export function computePermanentImportance(item) {
  if (!item) return IMPORTANCE.LOW

  let score = 0

  // Tags signal curation
  const tagCount = item.tags?.length ?? 0
  if (tagCount >= 3) score += 2
  else if (tagCount >= 1) score += 1

  // Bookmarks are more actionable than notes
  if (item.type === 'bookmark' && item.url) score += 1

  // Groups with many items signal organised research
  if (item.type === 'group' && (item.groupItems?.length ?? 0) >= 3) score += 1

  if (score >= 3) return IMPORTANCE.HIGH
  if (score >= 2) return IMPORTANCE.MEDIUM
  return IMPORTANCE.LOW
}
