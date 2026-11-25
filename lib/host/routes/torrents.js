import { DEFAULT_TORRENT_LIMIT, MAX_TORRENT_LIMIT, MAX_TORRENT_PAGE, MAX_TORRENT_QUERY_CHARS, TORRENT_PAGE_SOURCES, TORRENT_SOURCES } from '../config.js'
import { sendJson } from '../http.js'
import { mergeTorrentProviders, providerFailure, torrentSource } from '../sources.js'

/**
 * `GET /torrents?q=&alt=&source=&limit=` — search public BT indexes for one
 * title from its detail page (contract v1.3).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} searchParams
 * @param {object} settings
 */
export async function handleTorrents(req, res, searchParams, settings) {
  const rawQuery = (searchParams.get('q') || '').trim()
  if (!rawQuery) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'empty_query',
      message: 'The "q" query parameter is required.',
    })
    return
  }
  const query = rawQuery.slice(0, MAX_TORRENT_QUERY_CHARS)
  const rawAlt = (searchParams.get('alt') || '').trim()
  const alt = rawAlt && rawAlt !== query ? rawAlt.slice(0, MAX_TORRENT_QUERY_CHARS) : ''

  const requestedSource = (searchParams.get('source') || '').trim().toLowerCase()
  const source = requestedSource || 'all'
  if (source !== 'all' && !TORRENT_SOURCES.includes(source)) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_source',
      message: `Unsupported source "${requestedSource}". Use one of: all, bt4g, bitsearch.`,
    })
    return
  }

  const limit = parseTorrentLimit(searchParams)
  const page = parseTorrentPage(searchParams)
  if (page === null) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_page',
      message: `The "page" query parameter must be an integer between 1 and ${MAX_TORRENT_PAGE}.`,
    })
    return
  }
  /* BT4G's RSS endpoint is a single page, so page 2+ only asks the indexes
     that can page; an explicit bt4g page 2 is a valid, empty page. */
  const pageable = page > 1
  const names = (source === 'all' ? TORRENT_SOURCES : [source])
    .filter((name) => !pageable || TORRENT_PAGE_SOURCES.indexOf(name) !== -1)
  const queries = alt ? [query, alt] : [query]
  const startedAt = Date.now()
  const outcomes = await Promise.all(
    names.map(async (name) => {
      try {
        return { source: name, ...(await torrentSource(name, { queries, settings, page })) }
      } catch (error) {
        return { source: name, error: providerFailure(name, error) }
      }
    }),
  )
  const groups = outcomes
    .filter((outcome) => !outcome.error)
    .map((outcome) => ({ source: outcome.source, rows: outcome.rows }))
  const errors = outcomes.filter((outcome) => outcome.error).map((outcome) => outcome.error)
  const hasMore = outcomes.some((outcome) => !outcome.error && outcome.hasMore)

  sendJson(req, res, 200, {
    ok: true,
    query,
    alt: alt || null,
    page,
    tookMs: Math.max(0, Date.now() - startedAt),
    results: mergeTorrentProviders(groups, limit),
    hasMore,
    errors,
  })
}
/**
 * Read the optional `/torrents` `limit` parameter (contract v1.3): an integer
 * 1–30, default 20.
 *
 * @param {URLSearchParams} searchParams
 * @returns {number}
 */
export function parseTorrentLimit(searchParams) {
  const raw = (searchParams.get('limit') || '').trim()
  if (!raw) return DEFAULT_TORRENT_LIMIT
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TORRENT_LIMIT
  return Math.min(MAX_TORRENT_LIMIT, Math.floor(value))
}
/**
 * Read the optional `/torrents` `page` parameter (contract v1.12): an integer
 * 1–20, default 1. Returns null for an invalid value.
 *
 * @param {URLSearchParams} searchParams
 * @returns {number | null}
 */
export function parseTorrentPage(searchParams) {
  const raw = (searchParams.get('page') || '').trim()
  if (!raw) return 1
  const value = Number(raw)
  if (!Number.isFinite(value) || Math.floor(value) !== value || value < 1 || value > MAX_TORRENT_PAGE) {
    return null
  }
  return value
}
