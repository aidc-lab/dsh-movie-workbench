/**
 * dsh-movie-workbench Host data layer.
 *
 * `createHandler(config)` returns the single `(req, res) => Promise<void>`
 * handler registered by `index.js` for the `/movie-workbench/api` prefix.
 * It dispatches `status`, `search`, `trending`, `detail`, `torrents` and
 * `image` per the authoritative contract documented in `README.md`, fans
 * provider searches/recommendations/torrent queries out in parallel, and
 * proxies posters around Douban's Referer requirement.
 *
 * The handler owns the full response lifecycle: it always answers (or stays
 * silent if the socket is already gone) and never rejects. No console output.
 *
 * Plain ESM, Node 24 globals only, no dependencies.
 */

import {
  DEFAULT_USER_AGENT,
  ProviderError,
  fetchDoubanDetail,
  isAllowedImageUrl,
  isDoubanHost,
  isTimeoutError,
  parseTmdbCredential,
  recommendDouban,
  recommendImdb,
  recommendTmdb,
  resolveTmdbCredential,
  searchDouban,
  searchImdb,
  searchTmdb,
  searchTorrentsBitsearch,
  searchTorrentsBt4g,
} from './providers.js'

/** Route prefix registered with the DSH web server. */
export const API_PREFIX = '/movie-workbench/api'

/** Host half version reported by `/status` (mirrors package.json). */
const VERSION = '1.0.0'

const DEFAULT_MAX_RESULTS = 12
const DEFAULT_REQUEST_TIMEOUT_MS = 8000
const DEFAULT_LANG = 'zh-CN'
const MAX_QUERY_CHARS = 120
const MAX_LANG_CHARS = 32
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Contract v1.2: `/trending?limit=` is an integer 1–30 (larger values clamp). */
const MAX_TRENDING_LIMIT = 30

/** Contract v1.3: `/torrents` providers and request bounds. */
const TORRENT_SOURCES = ['bitsearch', 'bt4g']
const DEFAULT_TORRENT_LIMIT = 20
const MAX_TORRENT_LIMIT = 30
const MAX_TORRENT_QUERY_CHARS = 160
/** Scraped index pages are slower than the JSON APIs; give them a floor. */
const TORRENT_TIMEOUT_FLOOR_MS = 15000

/** Provider order for `source=all` (also the merge order). */
const SOURCES = ['tmdb', 'imdb', 'douban']

const SOURCE_LABELS = { tmdb: 'TMDB', imdb: 'IMDb', douban: 'Douban', bt4g: 'BT4G', bitsearch: 'BitSearch' }

const CORS_HEADERS = { 'access-control-allow-origin': '*' }

/**
 * Create the HTTP handler for the whole Host half.
 *
 * @param {object} [config] plugin row config: `tmdbApiKey`, `maxResults`,
 *   `requestTimeoutMs`, `userAgent`
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 *   handler owning the full response lifecycle; it never rejects
 */
export function createHandler(config = {}) {
  const settings = normalizeSettings(config)

  return async function moviesWorkbenchHandler(req, res) {
    try {
      if (!res || typeof res.writeHead !== 'function') return
      const method = readMethod(req)

      if (method === 'OPTIONS') {
        writeResponse(
          res,
          204,
          {
            ...CORS_HEADERS,
            'access-control-allow-headers': 'x-mw-tmdb-key',
            'access-control-allow-methods': 'GET, HEAD, OPTIONS',
            'access-control-max-age': '86400',
          },
          null,
        )
        return
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(
          req,
          res,
          405,
          {
            ok: false,
            code: 'method_not_allowed',
            message: `Method ${method} is not allowed.`,
          },
          { allow: 'GET, HEAD, OPTIONS' },
        )
        return
      }

      const requestUrl = parseRequestUrl(req)
      if (!requestUrl) {
        sendJson(req, res, 400, {
          ok: false,
          code: 'internal_error',
          message: 'Malformed request URL.',
        })
        return
      }

      if (
        requestUrl.pathname !== API_PREFIX &&
        !requestUrl.pathname.startsWith(`${API_PREFIX}/`)
      ) {
        sendJson(req, res, 404, {
          ok: false,
          code: 'not_found',
          message: 'Unknown endpoint.',
        })
        return
      }

      const endpoint = requestUrl.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
      switch (endpoint) {
        case '/status':
          handleStatus(req, res, settings)
          return
        case '/search':
          await handleSearch(req, res, requestUrl.searchParams, settings)
          return
        case '/trending':
          await handleTrending(req, res, requestUrl.searchParams, settings)
          return
        case '/detail':
          await handleDetail(req, res, requestUrl.searchParams, settings)
          return
        case '/torrents':
          await handleTorrents(req, res, requestUrl.searchParams, settings)
          return
        case '/image':
          await handleImage(req, res, requestUrl.searchParams, settings)
          return
        default:
          sendJson(req, res, 404, {
            ok: false,
            code: 'not_found',
            message: `Unknown endpoint "${endpoint}".`,
          })
      }
    } catch {
      // Last-resort guard: a broken socket or an unexpected bug must not escape
      // the route handler (the DSH web server would answer 400 and log it).
      sendJson(req, res, 500, {
        ok: false,
        code: 'internal_error',
        message: 'Unexpected error while handling the request.',
      })
    }
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                               */
/* ------------------------------------------------------------------ */

/**
 * `GET /status` — availability of the Host-side credential and the limits.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} settings
 */
function handleStatus(req, res, settings) {
  let tmdbConfigured = false
  try {
    tmdbConfigured = Boolean(resolveTmdbCredential(settings.tmdbApiKey))
  } catch {
    tmdbConfigured = false
  }
  sendJson(req, res, 200, {
    ok: true,
    version: VERSION,
    sources: {
      tmdb: { configured: tmdbConfigured },
      imdb: { configured: true },
      douban: { configured: true },
    },
    limits: {
      maxResults: settings.maxResults,
      requestTimeoutMs: settings.requestTimeoutMs,
    },
  })
}

/**
 * `GET /search?q=&source=&lang=` — parallel provider fan-out with per-provider
 * error collection. A valid request is always HTTP 200 with `ok: true`, even
 * when every provider fails.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} searchParams
 * @param {object} settings
 */
async function handleSearch(req, res, searchParams, settings) {
  const rawQuery = (searchParams.get('q') || '').trim()
  if (!rawQuery) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'empty_query',
      message: 'The "q" query parameter is required.',
    })
    return
  }
  const query = rawQuery.slice(0, MAX_QUERY_CHARS)

  const { requested: requestedSource, source, valid } = parseSourceParam(searchParams)
  if (!valid) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_source',
      message: `Unsupported source "${requestedSource}". Use one of: all, tmdb, imdb, douban.`,
    })
    return
  }

  const lang = parseLangParam(searchParams)
  const credential = resolveRequestCredential(req, settings)

  const startedAt = Date.now()
  const names = source === 'all' ? SOURCES : [source]
  const { results, errors } = await collectProviderRows(names, (name) =>
    searchSource(name, { query, lang, credential, settings }),
  )

  sendJson(req, res, 200, {
    ok: true,
    query,
    source,
    lang,
    tookMs: Math.max(0, Date.now() - startedAt),
    results,
    errors,
  })
}

/**
 * `GET /trending?source=&lang=&limit=` — the idle page's recommendation set, and
 * the longer per-channel "see all" lists. Same envelope family as `/search`
 * (no `q` and no `query` echo); a valid request is always HTTP 200 with
 * `ok: true`, even when every provider fails. The optional `limit` (1–30)
 * overrides the configured `maxResults` for this request (v1.2).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} searchParams
 * @param {object} settings
 */
async function handleTrending(req, res, searchParams, settings) {
  const { requested: requestedSource, source, valid } = parseSourceParam(searchParams)
  if (!valid) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_source',
      message: `Unsupported source "${requestedSource}". Use one of: all, tmdb, imdb, douban.`,
    })
    return
  }

  const lang = parseLangParam(searchParams)
  const credential = resolveRequestCredential(req, settings)
  const limit = parseLimitParam(searchParams, settings.maxResults)

  const startedAt = Date.now()
  const names = source === 'all' ? SOURCES : [source]
  const { results, errors } = await collectProviderRows(names, (name) =>
    recommendSource(name, { lang, credential, settings, limit }),
  )

  sendJson(req, res, 200, {
    ok: true,
    source,
    lang,
    tookMs: Math.max(0, Date.now() - startedAt),
    results,
    errors,
  })
}

/**
 * `GET /detail?source=douban&id=<subject id>` — lazy synopsis enrichment for
 * the detail page (contract v1.4). Douban's suggestion/search payloads carry no
 * synopsis, so the page asks for it when it opens a title. Always HTTP 200 with
 * `ok: true` for a well-formed request; an upstream failure is reported in
 * `errors` and `detail` stays `null` so the page can keep its empty state.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} searchParams
 * @param {object} settings
 */
async function handleDetail(req, res, searchParams, settings) {
  const requestedSource = (searchParams.get('source') || '').trim().toLowerCase()
  if (!requestedSource) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_source',
      message: 'The "source" query parameter is required. Use one of: douban.',
    })
    return
  }
  if (requestedSource !== 'douban') {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_source',
      message: `Unsupported source "${requestedSource}". Use one of: douban.`,
    })
    return
  }

  const rawId = (searchParams.get('id') || '').trim()
  if (!rawId) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'empty_id',
      message: 'The "id" query parameter is required.',
    })
    return
  }
  if (!/^\d{1,12}$/.test(rawId)) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_id',
      message: `Unsupported subject id "${rawId.slice(0, 40)}".`,
    })
    return
  }

  const startedAt = Date.now()
  let detail = null
  const errors = []
  try {
    detail = await fetchDoubanDetail({
      id: rawId,
      timeoutMs: settings.requestTimeoutMs,
      userAgent: settings.userAgent,
    })
  } catch (error) {
    errors.push(providerFailure('douban', error))
  }

  sendJson(req, res, 200, {
    ok: true,
    source: 'douban',
    id: rawId,
    tookMs: Math.max(0, Date.now() - startedAt),
    detail,
    errors,
  })
}

/**
 * `GET /torrents?q=&alt=&source=&limit=` — search public BT indexes for one
 * title from its detail page (contract v1.3).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} searchParams
 * @param {object} settings
 */
async function handleTorrents(req, res, searchParams, settings) {
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
  const queries = alt ? [query, alt] : [query]
  const names = source === 'all' ? TORRENT_SOURCES : [source]
  const startedAt = Date.now()
  const outcomes = await Promise.all(
    names.map(async (name) => {
      try {
        return { source: name, rows: await torrentSource(name, { queries, settings }) }
      } catch (error) {
        return { source: name, error: providerFailure(name, error) }
      }
    }),
  )
  const groups = outcomes
    .filter((outcome) => !outcome.error)
    .map((outcome) => ({ source: outcome.source, rows: outcome.rows }))
  const errors = outcomes.filter((outcome) => outcome.error).map((outcome) => outcome.error)

  sendJson(req, res, 200, {
    ok: true,
    query,
    alt: alt || null,
    tookMs: Math.max(0, Date.now() - startedAt),
    results: mergeTorrentProviders(groups, limit),
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
function parseTorrentLimit(searchParams) {
  const raw = (searchParams.get('limit') || '').trim()
  if (!raw) return DEFAULT_TORRENT_LIMIT
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TORRENT_LIMIT
  return Math.min(MAX_TORRENT_LIMIT, Math.floor(value))
}

/**
 * Run one torrent provider across its queries and merge the rows.
 *
 * @param {'bt4g' | 'bitsearch'} name
 * @param {{ queries: string[], settings: object }} context
 * @returns {Promise<object[]>} deduped rows sorted by seeders (nulls last)
 */
async function torrentSource(name, { queries, settings }) {
  const rows = []
  const timeoutMs = Math.max(settings.requestTimeoutMs, TORRENT_TIMEOUT_FLOOR_MS)
  for (const query of queries) {
    const options = {
      query,
      timeoutMs,
      userAgent: settings.userAgent,
    }
    const found = name === 'bt4g'
      ? await searchTorrentsBt4g(options)
      : await searchTorrentsBitsearch(options)
    rows.push(...found)
  }
  return mergeTorrentRows(rows, Number.POSITIVE_INFINITY)
}

/**
 * Deduplicate torrent rows by info hash and sort by seeders descending, with
 * unknown swarm counts last.
 *
 * @param {object[]} rows
 * @param {number} limit
 * @returns {object[]}
 */
function mergeTorrentRows(rows, limit) {
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
 * provider contributes its own top rows up to a quota, the groups are
 * interleaved one row at a time, duplicates by info hash are dropped, and the
 * result is capped at `limit`.
 *
 * @param {{ source: string, rows: object[] }[]} groups
 * @param {number} limit
 * @returns {object[]}
 */
function mergeTorrentProviders(groups, limit) {
  if (groups.length === 0) return []
  if (groups.length === 1) return groups[0].rows.slice(0, limit)
  const quota = Math.max(4, Math.ceil(limit / groups.length))
  const capped = groups.map((group) => ({
    source: group.source,
    rows: group.rows.slice(0, quota),
  }))
  const merged = []
  const seen = new Set()
  let index = 0
  let added = true
  while (added && merged.length < limit) {
    added = false
    for (const group of capped) {
      if (merged.length >= limit) break
      const row = group.rows[index]
      if (!row) continue
      added = true
      if (!row.id || seen.has(row.id)) continue
      seen.add(row.id)
      merged.push(row)
    }
    index += 1
  }
  return merged
}

/**
 * `GET /image?url=` — stream one poster back, because Douban images answer
 * HTTP 418 unless the request carries a Douban Referer.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} searchParams
 * @param {object} settings
 */
async function handleImage(req, res, searchParams, settings) {
  const rawUrl = (searchParams.get('url') || '').trim()
  if (!rawUrl) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_request',
      message: 'The "url" query parameter is required.',
    })
    return
  }
  if (!isAllowedImageUrl(rawUrl)) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_request',
      message: 'The image URL is not an allowed https poster URL.',
    })
    return
  }

  const target = new URL(rawUrl)
  const headers = {
    'user-agent': settings.userAgent || DEFAULT_USER_AGENT,
    accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  }
  if (isDoubanHost(target.hostname)) headers.referer = 'https://movie.douban.com/'

  let upstream
  try {
    upstream = await fetch(target, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(settings.requestTimeoutMs),
    })
  } catch (error) {
    sendImageFailure(req, res, error)
    return
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    discardBody(upstream)
    sendJson(req, res, 502, {
      ok: false,
      code: 'upstream_error',
      message: 'The image host redirected the request.',
    })
    return
  }
  if (!upstream.ok) {
    discardBody(upstream)
    sendJson(req, res, 502, {
      ok: false,
      code: 'upstream_error',
      message: `The image host responded with HTTP ${upstream.status}.`,
    })
    return
  }

  const contentType = readContentType(upstream)
  if (!contentType || !contentType.startsWith('image/')) {
    discardBody(upstream)
    sendJson(req, res, 502, {
      ok: false,
      code: 'upstream_error',
      message: 'The image host did not return an image.',
    })
    return
  }

  const declaredLength = Number(upstream.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    discardBody(upstream)
    sendJson(req, res, 502, {
      ok: false,
      code: 'upstream_error',
      message: 'The image is larger than the 8 MiB limit.',
    })
    return
  }

  let body
  try {
    body = await readBodyWithLimit(upstream, MAX_IMAGE_BYTES)
  } catch (error) {
    sendImageFailure(req, res, error)
    return
  }

  writeResponse(
    res,
    200,
    {
      'content-type': contentType,
      'content-length': String(body.byteLength),
      'cache-control': 'public, max-age=86400',
      ...CORS_HEADERS,
      'x-content-type-options': 'nosniff',
    },
    readMethod(req) === 'HEAD' ? null : body,
  )
}

/* ------------------------------------------------------------------ */
/* Provider helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Read the optional `source` parameter (default `all`).
 *
 * @param {URLSearchParams} searchParams
 * @returns {{ requested: string, source: string, valid: boolean }}
 */
function parseSourceParam(searchParams) {
  const requested = (searchParams.get('source') || '').trim().toLowerCase()
  const source = requested || 'all'
  return { requested, source, valid: source === 'all' || SOURCES.includes(source) }
}

/**
 * Read the optional `lang` parameter (default `zh-CN`).
 *
 * @param {URLSearchParams} searchParams
 * @returns {string}
 */
function parseLangParam(searchParams) {
  const requested = (searchParams.get('lang') || '').trim()
  return requested ? requested.slice(0, MAX_LANG_CHARS) : DEFAULT_LANG
}

/**
 * Read the optional `/trending` `limit` parameter (contract v1.2): an integer
 * 1–30 that overrides the configured `maxResults` for this request. Invalid
 * values (non-numeric, zero, negative) fall back to `maxResults`; values above
 * 30 clamp to 30.
 *
 * @param {URLSearchParams} searchParams
 * @param {number} fallback configured `maxResults`
 * @returns {number}
 */
function parseLimitParam(searchParams, fallback) {
  const raw = (searchParams.get('limit') || '').trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  const limit = Math.floor(value)
  if (limit < 1) return fallback
  return Math.min(MAX_TRENDING_LIMIT, limit)
}

/**
 * Resolve the TMDB credential for one request: the `x-mw-tmdb-key` header
 * first, then plugin config, then `process.env.TMDB_API_KEY`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object} settings
 * @returns {{ kind: 'bearer' | 'v3', value: string } | null}
 */
function resolveRequestCredential(req, settings) {
  const headerCredential = parseTmdbCredential(readHeader(req, 'x-mw-tmdb-key'))
  return headerCredential || resolveTmdbCredential(settings.tmdbApiKey)
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
async function collectProviderRows(names, load) {
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
async function searchSource(name, { query, lang, credential, settings }) {
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
async function recommendSource(name, { lang, credential, settings, limit }) {
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
 * Convert a provider rejection into a contract `errors[]` entry.
 *
 * @param {string} source
 * @param {unknown} error
 * @returns {{ source: string, code: string, message: string }}
 */
function providerFailure(source, error) {
  const label = SOURCE_LABELS[source] || source
  if (error instanceof ProviderError && error.code) {
    return { source, code: error.code, message: error.message || `${label} request failed.` }
  }
  if (isTimeoutError(error)) {
    return { source, code: 'timeout', message: `${label} request timed out.` }
  }
  return { source, code: 'upstream_error', message: `${label} request failed.` }
}

/* ------------------------------------------------------------------ */
/* Image helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Read a streamed image body while enforcing the byte cap.
 *
 * @param {Response} response
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
async function readBodyWithLimit(response, limit) {
  const stream = response.body
  if (!stream || typeof stream.getReader !== 'function') {
    const fallback = Buffer.from(await response.arrayBuffer())
    if (fallback.byteLength > limit) throw new ImageTooLargeError()
    return fallback
  }
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || !value.byteLength) continue
      total += value.byteLength
      if (total > limit) throw new ImageTooLargeError()
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    try {
      await reader.cancel()
    } catch {
      /* body already gone */
    }
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
  return Buffer.concat(chunks, total)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 */
function sendImageFailure(req, res, error) {
  sendJson(req, res, 502, {
    ok: false,
    code: 'upstream_error',
    message: imageFailureMessage(error),
  })
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function imageFailureMessage(error) {
  if (error instanceof ImageTooLargeError) return error.message
  if (isTimeoutError(error)) return 'The image request timed out.'
  return 'The image request failed.'
}

/**
 * @param {Response} response
 * @returns {string} lower-case media type without parameters, or ''
 */
function readContentType(response) {
  const raw = response.headers.get('content-type') || ''
  return raw.split(';', 1)[0].trim().toLowerCase()
}

/**
 * Drop an upstream body quietly.
 *
 * @param {Response} response
 */
function discardBody(response) {
  try {
    if (response.body && typeof response.body.cancel === 'function') {
      const pending = response.body.cancel()
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    }
  } catch {
    /* irrelevant */
  }
}

/** Internal marker for a body that exceeds the poster size cap. */
class ImageTooLargeError extends Error {
  constructor() {
    super('The image is larger than the 8 MiB limit.')
    this.name = 'ImageTooLargeError'
  }
}

/* ------------------------------------------------------------------ */
/* Request / response helpers                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolve plugin config into a frozen, fully populated settings object.
 *
 * @param {unknown} config
 * @returns {{ maxResults: number, requestTimeoutMs: number, userAgent: string, tmdbApiKey: string }}
 */
function normalizeSettings(config) {
  const source = config && typeof config === 'object' ? config : {}
  const maxResults =
    Number.isFinite(source.maxResults) && source.maxResults >= 1
      ? Math.floor(source.maxResults)
      : DEFAULT_MAX_RESULTS
  const requestTimeoutMs =
    Number.isFinite(source.requestTimeoutMs) && source.requestTimeoutMs >= 1
      ? Math.floor(source.requestTimeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS
  const userAgent =
    typeof source.userAgent === 'string' && source.userAgent.trim()
      ? source.userAgent.trim()
      : DEFAULT_USER_AGENT
  const tmdbApiKey = typeof source.tmdbApiKey === 'string' ? source.tmdbApiKey.trim() : ''
  return Object.freeze({ maxResults, requestTimeoutMs, userAgent, tmdbApiKey })
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {string} upper-case method, 'GET' when absent
 */
function readMethod(req) {
  return req && typeof req.method === 'string' && req.method ? req.method.toUpperCase() : 'GET'
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ pathname: string, searchParams: URLSearchParams } | null}
 */
function parseRequestUrl(req) {
  const target = req && typeof req.url === 'string' && req.url ? req.url : '/'
  try {
    const url = new URL(target, 'http://movie-workbench.local')
    return { pathname: url.pathname, searchParams: url.searchParams }
  } catch {
    return null
  }
}

/**
 * Read one request header as a string (Node lower-cases header names).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name
 * @returns {string}
 */
function readHeader(req, name) {
  const headers = req && req.headers ? req.headers : null
  if (!headers) return ''
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return ''
}

/**
 * Send a JSON response with the contract's CORS/JSON headers.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {object} payload
 * @param {Record<string, string>} [extraHeaders]
 */
function sendJson(req, res, statusCode, payload, extraHeaders) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    statusCode = 500
    body = '{"ok":false,"code":"internal_error","message":"Failed to serialize the response."}'
  }
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    ...CORS_HEADERS,
    'x-content-type-options': 'nosniff',
    ...(extraHeaders || {}),
  }
  writeResponse(res, statusCode, headers, readMethod(req) === 'HEAD' ? null : body)
}

/**
 * Write a response, tolerating a missing / destroyed / already-closed socket.
 * This is the only place that touches `res.writeHead` / `res.end`.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {Record<string, string>} headers
 * @param {string | Buffer | null} body `null` sends headers without a body
 */
function writeResponse(res, statusCode, headers, body) {
  if (!res || typeof res.writeHead !== 'function' || typeof res.end !== 'function') return
  try {
    if (res.destroyed || res.writableEnded) return
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(statusCode, headers)
    if (body === null || body === undefined) res.end()
    else res.end(body)
  } catch {
    try {
      if (!res.destroyed && typeof res.destroy === 'function') res.destroy()
    } catch {
      /* socket already gone */
    }
  }
}
