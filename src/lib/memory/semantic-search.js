// Semantic Search: token-based matching + importance/recency ranking.
//
// This is a purely client-side search engine — no API calls, no embeddings.
// It breaks queries into tokens and matches them across multiple fields
// (title, tags, URL, domain) with weighted scoring, then combines with
// importance and recency for final ranking.
//
// The existing keyword search in visibleFolders() continues to work exactly
// as before. Semantic search is an additional layer that can be called to
// enrich or re-rank results.

import { tokenise, domainOf } from './types.js'
import { computeImportance, computePermanentImportance } from './importance-engine.js'

/**
 * Build a search index from all permanent items in the store state.
 *
 * Call this once when the board loads or state changes. The index is a flat
 * array of entry objects that can be searched quickly.
 *
 * @param {object} state  The full store state
 * @returns {IndexEntry[]}
 */
export function buildIndex(state) {
  const entries = []

  for (const space of state.spaces ?? []) {
    for (const folder of space.folders ?? []) {
      for (const item of folder.items ?? []) {
        if (item.type === 'group') {
          // Index the group itself
          entries.push(indexEntry(item, folder, space))
          // And each child
          for (const child of item.groupItems ?? []) {
            entries.push(indexEntry(child, folder, space, item))
          }
        } else {
          entries.push(indexEntry(item, folder, space))
        }
      }
    }
  }

  return entries
}

/**
 * Search the index using a natural-language query.
 *
 * Returns results ranked by a combined score of:
 *  - Token match quality (how many query tokens match, and where)
 *  - Importance (from the importance engine)
 *  - Recency (more recent = higher)
 *
 * @param {IndexEntry[]} index       Built by buildIndex()
 * @param {string}                   query  Natural language query
 * @param {object} [options]
 * @param {Map<string, object>} [options.tempEntries]  Temporary memory for cross-referencing
 * @param {number} [options.limit]   Max results (default 20)
 * @returns {SearchResult[]}
 */
export function semanticSearch(index, query, { tempEntries, limit = 20 } = {}) {
  const tokens = tokenise(query)
  if (!tokens.length) return []

  // Also extract domain-like tokens (e.g. "github" from "that github repo")
  const domainTokens = tokens.filter((t) => t.length >= 3)

  const scored = []

  for (const entry of index) {
    let matchScore = 0
    const matchedFields = []

    // Title match (highest weight)
    const titleHits = countTokenHits(tokens, entry.titleTokens)
    if (titleHits > 0) {
      matchScore += titleHits * 3
      matchedFields.push('title')
    }

    // Tag match (high weight — tags are curated)
    const tagHits = countTokenHits(tokens, entry.tagTokens)
    if (tagHits > 0) {
      matchScore += tagHits * 2.5
      matchedFields.push('tags')
    }

    // URL/domain match (medium weight)
    const domainHits = domainTokens.filter((t) => entry.domain.includes(t)).length
    if (domainHits > 0) {
      matchScore += domainHits * 1.5
      matchedFields.push('domain')
    }

    // URL path token match (lower weight)
    const urlHits = countTokenHits(tokens, entry.urlTokens)
    if (urlHits > 0) {
      matchScore += urlHits * 0.5
      matchedFields.push('url')
    }

    if (matchScore === 0) continue

    // Normalise match score to 0-1 range
    const maxPossible = tokens.length * 3 // all tokens matching title
    const normalisedMatch = Math.min(matchScore / maxPossible, 1)

    // Importance bonus (0, 0.1, or 0.2)
    const imp = entry.importance
    const importanceBonus = imp === 'high' ? 0.2 : imp === 'medium' ? 0.1 : 0

    // Recency bonus (0 to 0.15)
    const recencyBonus = recencyFromTimestamp(entry.lastActive)

    // Cross-reference with temporary memory for same URL
    let tempBonus = 0
    if (tempEntries) {
      const temp = tempEntries.get(entry.urlNorm)
      if (temp) {
        // Boost if the user has been actively browsing this recently
        const tempAge = Date.now() - temp.lastActive
        if (tempAge < 60 * 60 * 1000) tempBonus = 0.15 // last hour
        else if (tempAge < 24 * 60 * 60 * 1000) tempBonus = 0.05 // today
      }
    }

    const finalScore = normalisedMatch + importanceBonus + recencyBonus + tempBonus

    scored.push({
      item: entry.item,
      folder: entry.folder,
      space: entry.space,
      group: entry.group,
      score: finalScore,
      matchedFields,
      importance: imp,
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

// ------------------------------------------------------------- helpers ---

function indexEntry(item, folder, space, group = null) {
  const title = item.title || item.url || ''
  const url = item.url || ''
  const tags = item.tags ?? []
  const domain = domainOf(url)

  return {
    item,
    folder,
    space,
    group,
    titleTokens: tokenise(title),
    tagTokens: tags.flatMap(tokenise),
    urlTokens: tokenise(url.replace(/^https?:\/\//, '')),
    domain,
    urlNorm: url.replace(/\/+$/, '').toLowerCase(),
    importance: computePermanentImportance(item),
    lastActive: item.lastVisited || item.created || 0,
  }
}

/** Count how many query tokens appear in the field tokens. */
function countTokenHits(queryTokens, fieldTokens) {
  if (!fieldTokens.length) return 0
  const fieldSet = new Set(fieldTokens)
  let hits = 0
  for (const t of queryTokens) {
    // Check exact match or prefix match (e.g. "react" matches "reactjs")
    if (fieldSet.has(t)) { hits += 1; continue }
    for (const ft of fieldSet) {
      if (ft.startsWith(t) || t.startsWith(ft)) { hits += 1; break }
    }
  }
  return hits
}

/** Recency bonus from a timestamp: 0 to 0.15. */
function recencyFromTimestamp(ts) {
  if (!ts) return 0
  const age = Date.now() - ts
  const day = 24 * 60 * 60 * 1000
  if (age < day) return 0.15
  if (age < 7 * day) return 0.1
  if (age < 30 * day) return 0.05
  return 0
}

/**
 * @typedef {Object} IndexEntry
 * @property {object} item         The board item
 * @property {object} folder       Parent folder
 * @property {object} space        Parent space
 * @property {object|null} group   Parent group (if nested)
 * @property {string[]} titleTokens
 * @property {string[]} tagTokens
 * @property {string[]} urlTokens
 * @property {string} domain
 * @property {string} urlNorm
 * @property {string} importance   'low' | 'medium' | 'high'
 * @property {number} lastActive
 */

/**
 * @typedef {Object} SearchResult
 * @property {object} item
 * @property {object} folder
 * @property {object} space
 * @property {object|null} group
 * @property {number} score
 * @property {string[]} matchedFields
 * @property {string} importance
 */
