// Related Finder: finds Tabspace items related to the current tab.
//
// Given a tab's metadata (title, URL, domain), compares against all permanent
// items in the store and returns the top 3 most relevant matches.
// Uses the same token-based matching as semantic search, plus domain overlap.

import { tokenise, domainOf, normUrl } from './types.js'
import { computePermanentImportance } from './importance-engine.js'

/**
 * Find items related to the given tab context.
 *
 * @param {object} opts
 * @param {string} opts.title    Current tab title
 * @param {string} opts.url      Current tab URL
 * @param {object} opts.state    Full store state
 * @param {Map<string, object>} [opts.tempEntries]  Temporary memory for extra signals
 * @param {number} [opts.limit]  Max results (default 3)
 * @returns {RelatedResult[]}
 */
export function findRelated({ title, url, state, tempEntries, limit = 3 }) {
  if (!title && !url) return []

  const queryDomain = domainOf(url || '')
  const queryTokens = tokenise(title)
  const queryNorm = normUrl(url || '')

  if (!queryTokens.length && !queryDomain) return []

  const scored = []

  for (const space of state.spaces ?? []) {
    for (const folder of space.folders ?? []) {
      for (const item of folder.items ?? []) {
        // Skip self
        if (item.type === 'bookmark' && normUrl(item.url) === queryNorm) continue

        const result = scoreItem(item, queryDomain, queryTokens, queryNorm, tempEntries, folder, space)
        if (result) {
          scored.push(result)
          // Also check group children
          if (item.type === 'group') {
            for (const child of item.groupItems ?? []) {
              if (normUrl(child.url) === queryNorm) continue
              const childResult = scoreItem(child, queryDomain, queryTokens, queryNorm, tempEntries, folder, space, item)
              if (childResult) scored.push(childResult)
            }
          }
        }
      }
    }
  }

  scored.sort((a, b) => b.score - a.score)

  // Deduplicate by item id
  const seen = new Set()
  const results = []
  for (const entry of scored) {
    if (seen.has(entry.item.id)) continue
    seen.add(entry.item.id)
    results.push(entry)
    if (results.length >= limit) break
  }

  return results
}

// ------------------------------------------------------------- helpers ---

function scoreItem(item, queryDomain, queryTokens, queryNorm, tempEntries, folder, space, group = null) {
  const title = item.title || item.url || ''
  const url = item.url || ''
  const domain = domainOf(url)
  const tags = item.tags ?? []
  const itemTokens = tokenise(title)

  let score = 0
  const reasons = []

  // Domain match (strong signal — same site often means related content)
  if (queryDomain && domain && queryDomain === domain) {
    score += 3
    reasons.push(`same domain (${domain})`)
  }

  // Token overlap in title
  const titleHits = tokenOverlap(queryTokens, itemTokens)
  if (titleHits > 0) {
    score += titleHits * 2
    reasons.push('similar title')
  }

  // Tag overlap
  const tagTokens = tags.flatMap(tokenise)
  const tagHits = tokenOverlap(queryTokens, tagTokens)
  if (tagHits > 0) {
    score += tagHits * 1.5
    reasons.push('shared tags')
  }

  // Cross-reference: was the user browsing a page from the same domain?
  if (tempEntries && domain) {
    for (const [, temp] of tempEntries) {
      if (temp.domain === domain && (Date.now() - temp.lastActive) < 24 * 60 * 60 * 1000) {
        score += 0.5
        reasons.push('recently browsed')
        break
      }
    }
  }

  // Importance bonus
  const imp = computePermanentImportance(item)
  if (imp === 'high') score += 0.5
  else if (imp === 'medium') score += 0.2

  if (score < 1.5) return null // threshold: must have at least one real signal

  return {
    item,
    folder,
    space,
    group,
    score,
    reasons,
    importance: imp,
  }
}

/** Count how many tokens from a appear in b (with prefix matching). */
function tokenOverlap(a, b) {
  if (!a.length || !b.length) return 0
  const bSet = new Set(b)
  let hits = 0
  for (const t of a) {
    if (bSet.has(t)) { hits += 1; continue }
    for (const bt of bSet) {
      if (bt.startsWith(t) || t.startsWith(bt)) { hits += 1; break }
    }
  }
  return hits
}

/**
 * @typedef {Object} RelatedResult
 * @property {object} item
 * @property {object} folder
 * @property {object} space
 * @property {object|null} group
 * @property {number} score
 * @property {string[]} reasons  Human-readable reasons for the match
 * @property {string} importance
 */
