import { ProviderError, browseDouban, browseImdb, browseTmdb, isTimeoutError, recommendDouban, recommendImdb, recommendTmdb, searchDouban, searchImdb, searchTmdb, searchTorrentsBitsearchPage, searchTorrentsBt4g } from '../providers.js'
import { BROWSE_PAGE_SIZE, SOURCE_LABELS, TORRENT_TIMEOUT_FLOOR_MS } from './config.js'

/**
 * Run one torrent provider across its queries and merge the rows.
 *
 * @param {'bt4g' | 'bitsearch'} name
 * @param {{ queries: string[], settings: object, page?: number }} context
 * @returns {Promise<{ rows: object[], hasMore: boolean }>} deduped rows; each spelling is seeders-sorted, localized spelling first
 */
export async function torrentSource(name, { queries, settings, page = 1 }) {
  const groups = []
  let hasMore = false
  const timeoutMs = Math.max(settings.requestTimeoutMs, TORRENT_TIMEOUT_FLOOR_MS)
  for (const query of queries) {
    const options = {
      query,
      page,
      timeoutMs,
      userAgent: settings.userAgent,
    }
    /* BT4G's RSS endpoint is a single page, so it never reports more. */
    const found = name === 'bt4g'
      ? { rows: await searchTorrentsBt4g(options), hasMore: false }
      : await searchTorrentsBitsearchPage(options)
    if (found.hasMore) hasMore = true
    groups.push(mergeTorrentRows(found.rows, Number.POSITIVE_INFINITY))
  }
  /* Keep each spelling's order, but favour the localized spelling (`alt` is the
     title shown in the UI): sorting the union by seeders lets well-seeded
     original-language releases hide every localized result. */
  if (groups.length === 1) return { rows: groups[0], hasMore }
  const rows = []
  const seen = new Set()
  const cursors = groups.map(() => 0)
  const weights = groups.map((_, index) => index === groups.length - 1 ? 2 : 1)
  let added = true
  while (added) {
    added = false
    for (let index = 0; index < groups.length; index += 1) {
      for (let step = 0; step < weights[index]; step += 1) {
        const row = groups[index][cursors[index]]
        if (!row) break
        cursors[index] += 1
        added = true
        if (seen.has(row.id)) continue
        seen.add(row.id)
        rows.push(row)
      }
    }
  }
  return { rows, hasMore }
}
/**
 * Deduplicate torrent rows by info hash and sort by seeders descending, with
 * unknown swarm counts last.
 *
 * @param {object[]} rows
 * @param {number} limit
 * @returns {object[]}
 */
export function mergeTorrentRows(rows, limit) {
  const byId = new Map()
  for (const row of rows) {
    if (!row || !row.id || !row.magnet) continue
    if (!byId.has(row.id)) byId.set(row.id, row)
  }
  const merged = Array.from(byId.values()).sort((left, right) => {
    const a = left.seeders === null || left.seeders === undefined ? -1 : left.seeders
    const b = right.seeders === null || right.seeders === undefined ? -1 : right.seeders
    return b - a
  })
  if (!Number.isFinite(limit)) return merged
  return merged.slice(0, limit)
}
/**
 * Merge provider groups so `source=all` shows every index instead of letting the
 * index with published seeders push the other one past the result cap. Each
 * provider contributes up to a quota, then spare slots are filled round-robin
 * from whichever provider still has rows. Duplicates by info hash are dropped.
 *
 * @param {{ source: string, rows: object[] }[]} groups
 * @param {number} limit
 * @returns {object[]}
 */
export function mergeTorrentProviders(groups, limit) {
  if (groups.length === 0) return []
  if (groups.length === 1) return groups[0].rows.slice(0, limit)
  const quota = Math.max(4, Math.ceil(limit / groups.length))
  const cursors = groups.map(() => 0)
  const merged = []
  const seen = new Set()
  const take = (index) => {
    const rows = groups[index].rows
    while (cursors[index] < rows.length) {
      const row = rows[cursors[index]]
      cursors[index] += 1
      if (!row || !row.id || seen.has(row.id)) continue
      seen.add(row.id)
      merged.push(row)
      return true
    }
    return false
  }
  for (let round = 0; round < quota && merged.length < limit; round += 1) {
    for (let index = 0; index < groups.length && merged.length < limit; index += 1) {
      take(index)
    }
  }
  /* A provider with only a few rows must not leave holes in the page. */
  let added = true
  while (added && merged.length < limit) {
    added = false
    for (let index = 0; index < groups.length && merged.length < limit; index += 1) {
      if (take(index)) added = true
    }
  }
  return merged
}
/**
 * Fan providers out in parallel and collect rows plus per-provider failures.
 * A rejected provider contributes only an `errors` entry and never fails the
 * response.
 *
 * @param {string[]} names
 * @param {(name: string) => Promise<object[]>} load
 * @returns {Promise<{ results: object[], errors: object[] }>}
 */
export async function collectProviderRows(names, load) {
  const outcomes = await Promise.all(
    names.map(async (name) => {
      try {
        return { source: name, results: await load(name) }
      } catch (error) {
        return { source: name, error: providerFailure(name, error) }
      }
    }),
  )
  const results = []
  const errors = []
  for (const outcome of outcomes) {
    if (outcome.error) errors.push(outcome.error)
    else if (Array.isArray(outcome.results)) results.push(...outcome.results)
  }
  return { results, errors }
}
/**
 * Run one provider.
 *
 * @param {string} name provider id (`tmdb`, `imdb`, `douban`)
 * @param {object} context
 * @param {string} context.query
 * @param {string} context.lang
 * @param {{ kind: 'bearer' | 'v3', value: string } | null} context.credential
 * @param {object} context.settings
 * @returns {Promise<object[]>}
 */
export async function searchSource(name, { query, lang, credential, settings }) {
  const common = {
    query,
    lang,
    maxResults: settings.maxResults,
    timeoutMs: settings.requestTimeoutMs,
    userAgent: settings.userAgent,
  }
  switch (name) {
    case 'tmdb':
      return searchTmdb({ ...common, credential })
    case 'imdb':
      return searchImdb(common)
    case 'douban':
      return searchDouban(common)
    default:
      throw new ProviderError('bad_source', `Unknown source "${name}".`)
  }
}
/**
 * Run one recommendation provider.
 *
 * @param {string} name provider id (`tmdb`, `imdb`, `douban`)
 * @param {object} context
 * @param {string} context.lang
 * @param {{ kind: 'bearer' | 'v3', value: string } | null} context.credential
 * @param {object} context.settings
 * @param {number} context.limit per-provider row cap for this request
 * @returns {Promise<object[]>}
 */
export async function recommendSource(name, { lang, credential, settings, limit }) {
  const common = {
    lang,
    maxResults: limit,
    timeoutMs: settings.requestTimeoutMs,
    userAgent: settings.userAgent,
  }
  switch (name) {
    case 'tmdb':
      return recommendTmdb({ ...common, credential })
    case 'imdb':
      return recommendImdb(common)
    case 'douban':
      return recommendDouban(common)
    default:
      throw new ProviderError('bad_source', `Unknown source "${name}".`)
  }
}
/**
 * Run one channel browse provider (contract v1.6).
 *
 * @param {string} name provider id (`tmdb`, `imdb`, `douban`)
 * @param {object} context
 * @param {string} context.category
 * @param {number} context.page
 * @param {string} context.lang
 * @param {{ kind: 'bearer' | 'v3', value: string } | null} context.credential
 * @param {object} context.settings
 * @param {object} [context.filters] Douban-only sort/filter view
 * @returns {Promise<{ items: object[], hasMore: boolean }>}
 */
export async function browseSource(name, { category, page, cursor, lang, credential, settings, filters }) {
  const common = {
    category,
    page,
    cursor,
    pageSize: BROWSE_PAGE_SIZE,
    timeoutMs: settings.requestTimeoutMs,
    userAgent: settings.userAgent,
  }
  switch (name) {
    case 'tmdb':
      return browseTmdb({ ...common, lang, credential })
    case 'imdb':
      return browseImdb(common)
    case 'douban':
      return browseDouban({ ...common, filters })
    default:
      throw new ProviderError('bad_source', `Unknown source "${name}".`)
  }
}
/**
 * Convert a provider rejection into a contract `errors[]` entry.
 *
 * @param {string} source
 * @param {unknown} error
 * @returns {{ source: string, code: string, message: string }}
 */
export function providerFailure(source, error) {
  const label = SOURCE_LABELS[source] || source
  if (error instanceof ProviderError && error.code) {
    return { source, code: error.code, message: error.message || `${label} request failed.` }
  }
  if (isTimeoutError(error)) {
    return { source, code: 'timeout', message: `${label} request timed out.` }
  }
  return { source, code: 'upstream_error', message: `${label} request failed.` }
}
