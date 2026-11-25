import { resolveTmdbCredential } from '../../providers.js'
import { BROWSE_CATEGORIES, BROWSE_PAGE_SIZE, MAX_BROWSE_CURSOR_CHARS, MAX_BROWSE_PAGE, MAX_QUERY_CHARS, SOURCES, VERSION } from '../config.js'
import { sendJson } from '../http.js'
import { parseBrowsePage, parseLangParam, parseLimitParam, parseSourceParam, resolveRequestCredential } from '../params.js'
import { browseSource, collectProviderRows, providerFailure, recommendSource, searchSource } from '../sources.js'

/**
 * `GET /status` — availability of the Host-side credential and the limits.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} settings
 */
export function handleStatus(req, res, settings) {
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
export async function handleSearch(req, res, searchParams, settings) {
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
export async function handleTrending(req, res, searchParams, settings) {
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
 * `GET /browse?source=&category=&page=` — one page of a channel's browse
 * categories (contract v1.6): TMDB has `trending` / `movie` / `tv`, IMDb and
 * Douban have `movie` / `tv`. Always HTTP 200 with `ok: true` for a well-formed
 * request; an upstream failure is reported in `errors` with an empty page so the
 * client can show the channel's own error state.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} searchParams
 * @param {object} settings
 */
export async function handleBrowse(req, res, searchParams, settings) {
  const requestedSource = (searchParams.get('source') || '').trim().toLowerCase()
  if (!requestedSource) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_source',
      message: 'The "source" query parameter is required. Use one of: tmdb, imdb, douban.',
    })
    return
  }
  const categories = BROWSE_CATEGORIES[requestedSource]
  if (!categories) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_source',
      message: `Unsupported source "${requestedSource}". Use one of: tmdb, imdb, douban.`,
    })
    return
  }

  const requestedCategory = (searchParams.get('category') || '').trim().toLowerCase()
  const category = requestedCategory || categories[0]
  if (categories.indexOf(category) === -1) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_category',
      message: `Unsupported category "${requestedCategory}". Use one of: ${categories.join(', ')}.`,
    })
    return
  }

  const page = parseBrowsePage(searchParams)
  if (!page) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_page',
      message: `The "page" query parameter must be an integer between 1 and ${MAX_BROWSE_PAGE}.`,
    })
    return
  }

  const cursor = (searchParams.get('cursor') || '').trim()
  if (cursor.length > MAX_BROWSE_CURSOR_CHARS) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_cursor',
      message: `The "cursor" query parameter must be at most ${MAX_BROWSE_CURSOR_CHARS} characters.`,
    })
    return
  }

  const lang = parseLangParam(searchParams)
  const credential = resolveRequestCredential(req, settings)
  const startedAt = Date.now()
  const envelope = {
    ok: true,
    source: requestedSource,
    category,
    categories: Array.from(categories),
    page,
    pageSize: BROWSE_PAGE_SIZE,
  }
  try {
    const { items, hasMore, next } = await browseSource(requestedSource, {
      category,
      page,
      cursor,
      lang,
      credential,
      settings,
    })
    sendJson(req, res, 200, {
      ...envelope,
      tookMs: Math.max(0, Date.now() - startedAt),
      items,
      hasMore: Boolean(hasMore),
      next: next ? String(next) : null,
      errors: [],
    })
  } catch (error) {
    sendJson(req, res, 200, {
      ...envelope,
      tookMs: Math.max(0, Date.now() - startedAt),
      items: [],
      hasMore: false,
      next: null,
      errors: [providerFailure(requestedSource, error)],
    })
  }
}
