/**
 * dsh-movie-workbench Host data layer.
 *
 * `createHandler(config)` returns the single `(req, res) => Promise<void>`
 * handler registered by `index.js` for the `/movie-workbench/api` prefix.
 * It dispatches `status`, `search`, `trending`, `browse`, `charts`, `chart`,
 * `detail`, `torrents`
 * and `image` per the authoritative contract documented in `README.md`, fans
 * provider searches/recommendations/torrent queries out in parallel, and
 * proxies posters around Douban's Referer requirement.
 *
 * The handler owns the full response lifecycle: it always answers (or stays
 * silent if the socket is already gone) and never rejects. No console output.
 *
 * Plain ESM, Node 24 globals only, no dependencies.
 *
 * Contract v1.11: `/charts` takes `kind=movie|tv` (default movie) and `/chart`
 * resolves the kind from the chart id (official ids or the `tv-` id prefix).
 * Contract v1.13: `/detail` also serves TMDB movie details (collection lookup)
 * and `/collection` lists every part of a TMDB collection.
 * Contract v1.14: `/series` follows IMDb's sequel/prequel connections, and
 * `/chart?id=collection:<id>` opens any official Douban subject collection a
 * title belongs to (`/detail?source=douban` now reports them).
 */

import {
  DEFAULT_USER_AGENT,
  ProviderError,
  DOUBAN_ANNUAL_YEARS,
  DOUBAN_CHART_IDS,
  DOUBAN_CHART_KINDS,
  DOUBAN_GENRES,
  DOUBAN_GENRE_SORTS,
  browseDouban,
  browseImdb,
  browseTmdb,
  doubanChartKind,
  fetchDoubanChartItems,
  fetchDoubanChartMeta,
  fetchDoubanTagChartItems,
  fetchDoubanDetail,
  fetchImdbDetail,
  fetchImdbSeries,
  fetchTmdbCollection,
  fetchTmdbMovieDetail,
  listDoubanCharts,
  parseDoubanChartRef,
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
const VERSION = '1.8.0'

const DEFAULT_MAX_RESULTS = 12
const DEFAULT_REQUEST_TIMEOUT_MS = 8000
const DEFAULT_LANG = 'zh-CN'
const MAX_QUERY_CHARS = 120
const MAX_LANG_CHARS = 32
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Contract v1.2: `/trending?limit=` is an integer 1–30 (larger values clamp). */
const MAX_TRENDING_LIMIT = 30

/** Contract v1.6: `/browse` categories, page size and page cap. */
const BROWSE_PAGE_SIZE = 20
const MAX_BROWSE_PAGE = 100
/** IMDb browse cursors are opaque tokens; cap them defensively. */
const MAX_BROWSE_CURSOR_CHARS = 4096
const BROWSE_CATEGORIES = Object.freeze({
  tmdb: Object.freeze(['trending', 'movie', 'tv']),
  imdb: Object.freeze(['featured', 'movie', 'tv']),
  douban: Object.freeze(['popular', 'movie', 'tv']),
})

/** Contract v1.8: `/charts` and `/chart` bounds (Douban official charts). */
const CHART_PAGE_SIZE = 20
const MAX_CHART_PAGE_SIZE = 30
const MAX_CHART_START = 1000

/** Contract v1.3: `/torrents` providers and request bounds. */
const TORRENT_SOURCES = ['bitsearch', 'bt4g']
const DEFAULT_TORRENT_LIMIT = 20
const MAX_TORRENT_LIMIT = 30
const MAX_TORRENT_QUERY_CHARS = 160
const MAX_TORRENT_PAGE = 20
/** BitSearch returns about 20 cards per result page. */
const BITSEARCH_PAGE_SIZE = 20
/** Providers that can page past the first result page (BT4G's RSS has one page). */
const TORRENT_PAGE_SOURCES = Object.freeze(['bitsearch'])
/** Scraped index pages are slower than the JSON APIs; give them a floor. */
const TORRENT_TIMEOUT_FLOOR_MS = 15000

/** Contract v1.17: `POST /pick` bounds (AI chooses the best BT row). */
const PICK_MAX_ROWS = 30
const PICK_MAX_BODY_BYTES = 512 * 1024
const PICK_LLM_TIMEOUT_MS = 45000
const PICK_MAX_TOKENS = 3000
const PICK_MAX_ID_CHARS = 200
const PICK_MAX_TITLE_CHARS = 500
const PICK_MAX_PROMPT_CHARS = 4000
const PICK_PREFERENCE_KEYS = ['quality', 'language', 'subtitle']
const PICK_PREFERENCE_OPTIONS = Object.freeze({
  quality: ['best', 'balanced', 'compact'],
  language: ['any', 'zh', 'en', 'ja', 'original'],
  subtitle: ['any', 'zh', 'bilingual', 'none'],
})
const PICK_PREFERENCE_DEFAULTS = Object.freeze({ quality: 'balanced', language: 'any', subtitle: 'any' })
const PICK_PREFERENCE_LABELS = Object.freeze({
  zh: {
    quality: { title: '画质', best: '最高画质', balanced: '均衡', compact: '小体积' },
    language: { title: '语言', any: '不限', zh: '国语/普通话', en: '英语', ja: '日语', original: '原声' },
    subtitle: { title: '字幕', any: '不限', zh: '中文字幕', bilingual: '中英双语', none: '不需要字幕' },
    priority: '用户偏好（请优先满足，无法满足时再按综合质量排序）：',
  },
  en: {
    quality: { title: 'Quality', best: 'Best quality', balanced: 'Balanced', compact: 'Small size' },
    language: { title: 'Language', any: 'Any', zh: 'Mandarin', en: 'English', ja: 'Japanese', original: 'Original audio' },
    subtitle: { title: 'Subtitles', any: 'Any', zh: 'Chinese', bilingual: 'Bilingual', none: 'None' },
    priority: 'Viewer preferences (prefer these when possible, then rank by overall quality):',
  },
})
/** Routing id for session-scoped LLM providers; picks are auxiliary calls. */
const PICK_LLM_SESSION_ID = 'movie-workbench-pick'

/** Contract v1.18: `/models` catalog cache and bounds. */
const MODELS_CACHE_TTL_MS = 60 * 1000
const MODEL_LOOKUP_TIMEOUT_MS = 8000
const MODEL_MAX_PROVIDERS = 12

/** Provider order for `source=all` (also the merge order). */
const SOURCES = ['tmdb', 'imdb', 'douban']

const SOURCE_LABELS = { tmdb: 'TMDB', imdb: 'IMDb', douban: 'Douban', bt4g: 'BT4G', bitsearch: 'BitSearch' }

const CORS_HEADERS = { 'access-control-allow-origin': '*' }

/**
 * Create the HTTP handler for the whole Host half.
 *
 * @param {object} [config] plugin row config: `tmdbApiKey`, `maxResults`,
 *   `requestTimeoutMs`, `userAgent`
 * @param {object} [services] optional live Host services used by `POST /pick`:
 *   `getLlm()` returns the DSH LLM service or null, `getSelection()` returns
 *   the profile's default `{ provider, model }` selection or null
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 *   handler owning the full response lifecycle; it never rejects
 */
export function createHandler(config = {}, services = {}) {
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
            'access-control-allow-headers': 'content-type, x-mw-tmdb-key',
            'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
            'access-control-max-age': '86400',
          },
          null,
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

      // `/pick` is the only POST endpoint; everything else stays read-only.
      if (endpoint === '/pick') {
        if (method !== 'POST') {
          sendJson(
            req,
            res,
            405,
            { ok: false, code: 'method_not_allowed', message: `Method ${method} is not allowed.` },
            { allow: 'POST, OPTIONS' },
          )
          return
        }
      } else if (method !== 'GET' && method !== 'HEAD') {
        sendJson(
          req,
          res,
          405,
          { ok: false, code: 'method_not_allowed', message: `Method ${method} is not allowed.` },
          { allow: 'GET, HEAD, OPTIONS' },
        )
        return
      }

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
        case '/browse':
          await handleBrowse(req, res, requestUrl.searchParams, settings)
          return
        case '/charts':
          await handleCharts(req, res, requestUrl.searchParams, settings)
          return
        case '/chart':
          await handleChart(req, res, requestUrl.searchParams, settings)
          return
        case '/detail':
          await handleDetail(req, res, requestUrl.searchParams, settings)
          return
        case '/collection':
          await handleCollection(req, res, requestUrl.searchParams, settings)
          return
        case '/series':
          await handleSeries(req, res, requestUrl.searchParams, settings)
          return
        case '/torrents':
          await handleTorrents(req, res, requestUrl.searchParams, settings)
          return
        case '/image':
          await handleImage(req, res, requestUrl.searchParams, settings)
          return
        case '/pick':
          await handlePick(req, res, settings, services)
          return
        case '/models':
          await handleModels(req, res, services)
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
async function handleBrowse(req, res, searchParams, settings) {
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

/**
 * `GET /charts?source=douban` — the Douban channel's 片单 tab (contract v1.8):
 * every official chart with its live metadata (title, description, cover,
 * total). Always HTTP 200 with `ok: true` for a well-formed request; charts
 * whose metadata failed keep their static title and are reported in `errors`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} searchParams
 * @param {object} settings
 */
async function handleCharts(req, res, searchParams, settings) {
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
  const kind = (searchParams.get('kind') || 'movie').trim().toLowerCase()
  if (DOUBAN_CHART_KINDS.indexOf(kind) === -1) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_kind',
      message: `The "kind" query parameter must be one of: ${DOUBAN_CHART_KINDS.join(', ')}.`,
    })
    return
  }
  const startedAt = Date.now()
  const { charts: officialCharts, errors } = await listDoubanCharts({
    kind,
    timeoutMs: settings.requestTimeoutMs,
    userAgent: settings.userAgent,
  })
  const charts = officialCharts
    .map((chart) => ({ ...chart, family: 'official', kind }))
    .concat(generatedChartCatalog(kind))
  sendJson(req, res, 200, {
    ok: true,
    source: 'douban',
    kind,
    tookMs: Math.max(0, Date.now() - startedAt),
    charts,
    errors,
  })
}

/**
 * `GET /chart?source=douban&id=&start=&count=` — one range of a chart's ranked
 * titles (contract v1.8). Count is 1–30 (default 20) and start is a non-negative
 * integer; the response carries `total` so the page can page until the end.
 * Always HTTP 200 with `ok: true` for a well-formed request; an upstream failure
 * is reported in `errors` with an empty page.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} searchParams
 * @param {object} settings
 */
async function handleChart(req, res, searchParams, settings) {
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
  const id = (searchParams.get('id') || '').trim()
  if (!id) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'empty_id',
      message: 'The "id" query parameter is required.',
    })
    return
  }
  const chartRef = parseDoubanChartRef(id)
  const collectionChartId = parseDoubanCollectionChartId(id)
  if (DOUBAN_CHART_IDS.indexOf(id) === -1 && !chartRef && !collectionChartId) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_chart',
      message:
        `Unsupported chart "${id}". Use one of: ${DOUBAN_CHART_IDS.join(', ')}; ` +
        `or genre:<genre>:<S|U> with genre in: ${DOUBAN_GENRES.join(', ')}; ` +
        `or hidden:<genre> with genre in: ${DOUBAN_GENRES.join(', ')}; ` +
        `or year:<yyyy>:<S|U> with year in: ${DOUBAN_ANNUAL_YEARS.join(', ')}; ` +
        `or tv-genre:<genre>:<S|U> / tv-year:<yyyy>:<S|U>; ` +
        `or collection:<id> for a Douban subject collection a title belongs to.`,
    })
    return
  }
  const chartKind = chartRef ? chartRef.kind : (collectionChartId ? 'movie' : (doubanChartKind(id) || 'movie'))
  const start = parseChartStart(searchParams)
  if (start === null) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_start',
      message: `The "start" query parameter must be an integer between 0 and ${MAX_CHART_START}.`,
    })
    return
  }
  const count = parseChartCount(searchParams)
  if (count === 0) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_count',
      message: `The "count" query parameter must be an integer between 1 and ${MAX_CHART_PAGE_SIZE}.`,
    })
    return
  }
  const startedAt = Date.now()
  const envelope = {
    ok: true,
    source: 'douban',
    kind: chartKind,
    id,
    start,
    pageSize: count,
  }
  try {
    let chart = null
    if (collectionChartId) {
      chart = await fetchDoubanChartMeta(collectionChartId, {
        timeoutMs: settings.requestTimeoutMs,
        userAgent: settings.userAgent,
      })
      chart = { id: id, title: chart.title, subtitle: chart.subtitle, description: chart.description, total: chart.total, cover: chart.cover }
    }
    const { total, items } = chartRef
      ? await fetchDoubanTagChartItems({
        kind: chartRef.kind,
        tags: chartRef.tags,
        sort: chartRef.sort,
        start,
        count,
        timeoutMs: settings.requestTimeoutMs,
        userAgent: settings.userAgent,
      })
      : await fetchDoubanChartItems(collectionChartId || id, {
        start,
        count,
        timeoutMs: settings.requestTimeoutMs,
        userAgent: settings.userAgent,
      })
    sendJson(req, res, 200, {
      ...envelope,
      tookMs: Math.max(0, Date.now() - startedAt),
      chart,
      total,
      items,
      hasMore: Number.isInteger(total) ? start + items.length < total : items.length >= count,
      errors: [],
    })
  } catch (error) {
    sendJson(req, res, 200, {
      ...envelope,
      tookMs: Math.max(0, Date.now() - startedAt),
      chart: null,
      total: null,
      items: [],
      hasMore: false,
      errors: [providerFailure('douban', error)],
    })
  }
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
      message: 'The "source" query parameter is required. Use one of: douban, tmdb, imdb.',
    })
    return
  }
  if (requestedSource !== 'douban' && requestedSource !== 'tmdb' && requestedSource !== 'imdb') {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_source',
      message: `Unsupported source "${requestedSource}". Use one of: douban, tmdb, imdb.`,
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
  const idPattern = requestedSource === 'imdb' ? /^tt\d{1,12}$/ : /^\d{1,12}$/
  if (!idPattern.test(rawId)) {
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
  if (requestedSource === 'tmdb') {
    const lang = parseLangParam(searchParams)
    const credential = resolveRequestCredential(req, settings)
    if (!credential) {
      errors.push(providerFailure('tmdb', new ProviderError('tmdb_key_missing', 'No TMDB API key is configured.')))
    } else {
      try {
        detail = await fetchTmdbMovieDetail({
          id: rawId,
          lang,
          credential,
          timeoutMs: settings.requestTimeoutMs,
          userAgent: settings.userAgent,
        })
      } catch (error) {
        errors.push(providerFailure('tmdb', error))
      }
    }
    sendJson(req, res, 200, {
      ok: true,
      source: 'tmdb',
      id: rawId,
      lang,
      tookMs: Math.max(0, Date.now() - startedAt),
      detail,
      errors,
    })
    return
  }
  if (requestedSource === 'imdb') {
    try {
      detail = await fetchImdbDetail({
        id: rawId,
        timeoutMs: settings.requestTimeoutMs,
        userAgent: settings.userAgent,
      })
    } catch (error) {
      errors.push(providerFailure('imdb', error))
    }
    sendJson(req, res, 200, {
      ok: true,
      source: 'imdb',
      id: rawId,
      tookMs: Math.max(0, Date.now() - startedAt),
      detail,
      errors,
    })
    return
  }

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
 * `GET /collection?source=tmdb&id=<collection id>&lang=` — one TMDB collection
 * with all of its parts as movie results (contract v1.13). A missing TMDB
 * credential is reported through `errors` with an empty page, never a 5xx.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} searchParams
 * @param {object} settings
 */
async function handleCollection(req, res, searchParams, settings) {
  const requestedSource = (searchParams.get('source') || '').trim().toLowerCase()
  if (!requestedSource) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_source',
      message: 'The "source" query parameter is required. Use one of: tmdb.',
    })
    return
  }
  if (requestedSource !== 'tmdb') {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_source',
      message: `Unsupported source "${requestedSource}". Use one of: tmdb.`,
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
      message: `Unsupported collection id "${rawId.slice(0, 40)}".`,
    })
    return
  }
  const lang = parseLangParam(searchParams)
  const credential = resolveRequestCredential(req, settings)
  const startedAt = Date.now()
  let collection = null
  let items = []
  const errors = []
  if (!credential) {
    errors.push(providerFailure('tmdb', new ProviderError('tmdb_key_missing', 'No TMDB API key is configured.')))
  } else {
    try {
      const found = await fetchTmdbCollection({
        id: rawId,
        lang,
        credential,
        timeoutMs: settings.requestTimeoutMs,
        userAgent: settings.userAgent,
      })
      collection = {
        id: found.id,
        name: found.name,
        overview: found.overview,
        cover: found.cover,
      }
      items = found.items
    } catch (error) {
      errors.push(providerFailure('tmdb', error))
    }
  }
  sendJson(req, res, 200, {
    ok: true,
    source: 'tmdb',
    id: rawId,
    lang,
    tookMs: Math.max(0, Date.now() - startedAt),
    collection,
    items,
    errors,
  })
}

/**
 * `GET /series?source=imdb&id=` — one title's franchise chain (contract v1.14).
 * IMDb has no collection entity; sequel/preqel links from its title-connections
 * graph are followed instead. Always HTTP 200 for a well-formed request; an
 * upstream failure is reported in `errors` with `series: null`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} searchParams
 * @param {object} settings
 */
async function handleSeries(req, res, searchParams, settings) {
  const requestedSource = (searchParams.get('source') || '').trim().toLowerCase()
  if (!requestedSource) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_source',
      message: 'The "source" query parameter is required. Use one of: imdb.',
    })
    return
  }
  if (requestedSource !== 'imdb') {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_source',
      message: `Unsupported source "${requestedSource}". Use one of: imdb.`,
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
  if (!/^tt\d{1,12}$/.test(rawId)) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_id',
      message: `Unsupported title id "${rawId.slice(0, 40)}".`,
    })
    return
  }
  const startedAt = Date.now()
  try {
    const series = await fetchImdbSeries({
      id: rawId,
      timeoutMs: settings.requestTimeoutMs,
      userAgent: settings.userAgent,
    })
    sendJson(req, res, 200, {
      ok: true,
      source: 'imdb',
      id: rawId,
      tookMs: Math.max(0, Date.now() - startedAt),
      series,
      errors: [],
    })
  } catch (error) {
    sendJson(req, res, 200, {
      ok: true,
      source: 'imdb',
      id: rawId,
      tookMs: Math.max(0, Date.now() - startedAt),
      series: null,
      errors: [providerFailure('imdb', error)],
    })
  }
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
function parseTorrentLimit(searchParams) {
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
function parseTorrentPage(searchParams) {
  const raw = (searchParams.get('page') || '').trim()
  if (!raw) return 1
  const value = Number(raw)
  if (!Number.isFinite(value) || Math.floor(value) !== value || value < 1 || value > MAX_TORRENT_PAGE) {
    return null
  }
  return value
}

/**
 * Run one torrent provider across its queries and merge the rows.
 *
 * @param {'bt4g' | 'bitsearch'} name
 * @param {{ queries: string[], settings: object }} context
 * @returns {Promise<object[]>} deduped rows sorted by seeders (nulls last)
 */
async function torrentSource(name, { queries, settings, page = 1 }) {
  const rows = []
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
      ? await searchTorrentsBt4g(options)
      : await searchTorrentsBitsearch(options)
    if (name === 'bitsearch' && found.length >= BITSEARCH_PAGE_SIZE) hasMore = true
    rows.push(...found)
  }
  return { rows: mergeTorrentRows(rows, Number.POSITIVE_INFINITY), hasMore }
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
 * `POST /pick` — ask the profile's model to choose the best BT row for a
 * title. The browser sends the title metadata plus the rows it is showing;
 * the Host builds a compact prompt, streams one model call through the DSH
 * LLM service, and parses the model's JSON answer. The AI never touches
 * credentials: keys stay with the LLM adapters.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} settings
 * @param {{ getLlm?: () => any, getSelection?: () => any }} services
 */
async function handlePick(req, res, settings, services) {
  const startedAt = Date.now()
  const body = await readPickBody(req)
  if (body.tooLarge) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'body_too_large',
      message: 'The request body must be at most 512 KiB.',
    })
    return
  }
  if (body.missing) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'empty_body',
      message: 'The request body must be a JSON object.',
    })
    return
  }
  if (body.invalid) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_body',
      message: 'The request body must be valid JSON.',
    })
    return
  }
  const payload = body.value && typeof body.value === 'object' ? body.value : {}
  const item = payload.item && typeof payload.item === 'object' ? payload.item : {}
  const rawRows = Array.isArray(payload.rows) ? payload.rows : null
  if (!rawRows || rawRows.length === 0) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'empty_rows',
      message: 'The "rows" array must contain at least one candidate.',
    })
    return
  }
  if (rawRows.length > PICK_MAX_ROWS) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'too_many_rows',
      message: `The "rows" array must contain at most ${PICK_MAX_ROWS} candidates.`,
    })
    return
  }
  const rows = rawRows.map(normalizePickRow).filter(Boolean)
  if (rows.length === 0) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'invalid_rows',
      message: 'Every row needs a non-empty "id" and "title".',
    })
    return
  }
  const lang = typeof payload.lang === 'string' && payload.lang.toLowerCase().startsWith('en') ? 'en' : 'zh'
  const preferences = normalizePickPreferences(payload.preferences)
  if (preferences === null) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_preferences',
      message: `The "preferences" field must contain valid ${PICK_PREFERENCE_KEYS.join(', ')} values.`,
    })
    return
  }
  const customPrompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
  if (payload.prompt !== undefined && typeof payload.prompt !== 'string') {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_prompt',
      message: 'The "prompt" field must be a string.',
    })
    return
  }
  if (customPrompt.length > PICK_MAX_PROMPT_CHARS) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_prompt',
      message: `The "prompt" field must be at most ${PICK_MAX_PROMPT_CHARS} characters.`,
    })
    return
  }
  const previewOnly = payload.preview === true
  const built = buildPickPrompt({ item, rows, lang, preferences })
  const effectivePrompt = customPrompt || built.prompt
  if (previewOnly) {
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      preview: true,
      prompt: effectivePrompt,
      system: built.system,
      preferences,
      tookMs: Date.now() - startedAt,
      errors: [],
    })
    return
  }
  const requestedModel = normalizePickModel(payload.model)
  if (payload.model !== undefined && payload.model !== null && !requestedModel) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_model',
      message: 'The "model" field must be { provider, model } with non-empty strings.',
    })
    return
  }

  const llm = services && typeof services.getLlm === 'function' ? services.getLlm() : null
  if (!llm || typeof llm.stream !== 'function') {
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      provider: null,
      model: null,
      tookMs: Date.now() - startedAt,
      pick: null,
      picks: [],
      analysis: '',
      prompt: effectivePrompt,
      preferences,
      free: Boolean(customPrompt),
      errors: [pickFailure('llm_unavailable', 'The AI model service is not available in this DSH profile.')],
    })
    return
  }

  let route = resolvePickRoute(services)
  if (requestedModel) {
    const catalog = await collectLlmCatalog(llm, services)
    const known = catalog.models.some(
      (entry) => entry.provider === requestedModel.provider && entry.id === requestedModel.model,
    )
    if (!known) {
      sendJson(req, res, 400, {
        ok: false,
        code: 'bad_model',
        message: 'The requested model is not advertised by this DSH profile.',
      })
      return
    }
    route = { provider: requestedModel.provider, model: requestedModel.model }
  }
  if (!route.provider || !route.model) {
    const catalog = await collectLlmCatalog(llm, services)
    const first = catalog.models[0]
    if (first) route = { provider: first.provider, model: first.id }
  }
  if (!route.provider || !route.model) {
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      provider: null,
      model: null,
      tookMs: Date.now() - startedAt,
      pick: null,
      picks: [],
      analysis: '',
      prompt: effectivePrompt,
      preferences,
      free: Boolean(customPrompt),
      errors: [pickFailure('llm_no_model', 'No model is configured for this DSH profile.')],
    })
    return
  }

  const system = built.system
  const prompt = effectivePrompt
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, PICK_LLM_TIMEOUT_MS)
  let text = ''
  let failure = null
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: PICK_MAX_TOKENS,
      temperature: 0.2,
      signal: controller.signal,
      // Session-scoped providers (e.g. opencode-go) need a routing id on the
      // request; this auxiliary call is not part of a chat session, so use a
      // stable bucket shared by every pick request.
      sessionId: PICK_LLM_SESSION_ID,
    })
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        continue
      }
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        failure = chunk.reason.failure || { code: 'llm_error', message: 'The AI request failed.' }
      }
    }
  } catch (error) {
    failure = error || { code: 'llm_error', message: 'The AI request failed.' }
  } finally {
    clearTimeout(timer)
  }

  const tookMs = Date.now() - startedAt
  if (failure) {
    const code = timedOut ? 'llm_timeout' : (failure && typeof failure.code === 'string' ? failure.code : 'llm_error')
    const message = timedOut
      ? 'The AI request timed out.'
      : String((failure && failure.message) || 'The AI request failed.').slice(0, 300)
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      provider: route.provider,
      model: route.model,
      tookMs,
      pick: null,
      picks: [],
      analysis: '',
      prompt,
      preferences,
      free: Boolean(customPrompt),
      errors: [pickFailure(code, message)],
    })
    return
  }

  let parsed = parsePickResponse(text, rows)
  let pickErrors = []
  if (!parsed.pick) {
    const fallback = fallbackPick(rows, lang)
    if (fallback) {
      parsed = {
        pick: fallback,
        picks: parsed.picks,
        analysis: parsed.analysis,
        parseFailed: false,
      }
    } else {
      pickErrors = [pickFailure('llm_unparseable', 'The model response did not contain parseable JSON.')]
    }
  }
  sendJson(req, res, 200, {
    ok: true,
    source: 'llm',
    provider: route.provider,
    model: route.model,
    tookMs,
    pick: parsed.pick,
    picks: parsed.picks,
    analysis: parsed.analysis,
    prompt,
    preferences,
    free: Boolean(customPrompt),
    errors: pickErrors,
  })
}

/**
 * Read and JSON-parse the `POST /pick` body with a hard size cap.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ value?: any, missing?: true, invalid?: true, tooLarge?: true }>}
 */
async function readPickBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > PICK_MAX_BODY_BYTES) return { tooLarge: true }
    chunks.push(chunk)
  }
  if (total === 0) return { missing: true }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { invalid: true }
  }
}

/**
 * Shape one candidate row sent by the browser; unknown extras are dropped so
 * the prompt cannot be inflated with arbitrary client state.
 *
 * @param {unknown} value
 * @returns {{ id: string, title: string, size: string, source: string, seeders: number | null, leechers: number | null } | null}
 */
function normalizePickRow(value) {
  if (!value || typeof value !== 'object') return null
  const id = pickText(value.id)
  const title = pickText(value.title)
  if (!id || !title) return null
  return {
    id: id.slice(0, PICK_MAX_ID_CHARS),
    title: title.slice(0, PICK_MAX_TITLE_CHARS),
    size: pickText(value.size).slice(0, 40),
    source: pickText(value.source).slice(0, 20),
    seeders: pickCount(value.seeders),
    leechers: pickCount(value.leechers),
  }
}

/**
 * Trim a scalar into a string (numbers allowed, objects ignored).
 *
 * @param {unknown} value
 * @returns {string}
 */
function pickText(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * Coerce a swarm count to a non-negative integer or null.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function pickCount(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  return Math.trunc(number)
}

/**
 * Build one normalized error entry for the pick envelope.
 *
 * @param {string} code
 * @param {string} message
 * @returns {{ source: 'llm', code: string, message: string }}
 */
function pickFailure(code, message) {
  return { source: 'llm', code, message }
}

/** Cache of the advertised provider/model catalog (`/models`). */
let modelsCatalogCache = null

/**
 * Race one catalog promise against a timeout without leaving it unbounded.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('catalog timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Enumerate every registered provider and the models it advertises.
 *
 * @param {any} llm
 * @param {{ getSelection?: () => any }} services
 * @returns {Promise<{ selection: { provider: string, model: string } | null, providers: { id: string, name: string }[], models: { provider: string, id: string, name: string, description?: string }[], errors: object[] }>}
 */
async function collectLlmCatalog(llm, services) {
  const now = Date.now()
  if (modelsCatalogCache && now - modelsCatalogCache.at < MODELS_CACHE_TTL_MS) {
    return modelsCatalogCache.value
  }
  const errors = []
  const providers = []
  try {
    const list = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    if (Array.isArray(list)) {
      for (const entry of list.slice(0, MODEL_MAX_PROVIDERS)) {
        if (entry && typeof entry.id === 'string' && entry.id) {
          providers.push({ id: entry.id, name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id })
        }
      }
    }
  } catch {
    errors.push(pickFailure('catalog_error', 'Could not list the LLM providers.'))
  }
  const models = []
  await Promise.all(
    providers.map(async (provider) => {
      if (typeof llm.listModels !== 'function') return
      try {
        const list = await withTimeout(llm.listModels(provider.id), MODEL_LOOKUP_TIMEOUT_MS)
        if (!Array.isArray(list)) return
        for (const entry of list) {
          if (!entry || typeof entry.id !== 'string' || !entry.id) continue
          models.push({
            provider: provider.id,
            id: entry.id,
            name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
            ...(typeof entry.description === 'string' && entry.description ? { description: entry.description } : {}),
          })
        }
      } catch {
        errors.push(pickFailure('catalog_error', `Could not list models for "${provider.id}".`))
      }
    }),
  )
  const selection = resolvePickRoute(services)
  const value = {
    selection: selection.provider && selection.model ? { provider: selection.provider, model: selection.model } : null,
    providers,
    models,
    errors,
  }
  modelsCatalogCache = { at: now, value }
  return value
}

/**
 * `GET /models` — the advertised provider/model catalog plus the profile default.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ getLlm?: () => any, getSelection?: () => any }} services
 */
async function handleModels(req, res, services) {
  const llm = services && typeof services.getLlm === 'function' ? services.getLlm() : null
  if (!llm || typeof llm.listProviders !== 'function') {
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      selection: null,
      providers: [],
      models: [],
      errors: [pickFailure('llm_unavailable', 'The AI model service is not available in this DSH profile.')],
    })
    return
  }
  try {
    const catalog = await collectLlmCatalog(llm, services)
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      selection: catalog.selection,
      providers: catalog.providers,
      models: catalog.models,
      errors: catalog.errors,
    })
  } catch {
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      selection: null,
      providers: [],
      models: [],
      errors: [pickFailure('catalog_error', 'Could not read the model catalog.')],
    })
  }
}

/**
 * Normalize the optional `model` field of a pick request.
 *
 * @param {unknown} value
 * @returns {{ provider: string, model: string } | null}
 */
/**
 * Normalize the viewer preference object posted with a /pick request.
 * Missing keys fall back to the defaults; malformed values return null.
 *
 * @param {unknown} value
 * @returns {{ quality: string, language: string, subtitle: string } | null}
 */
function normalizePickPreferences(value) {
  if (value === undefined || value === null) return { ...PICK_PREFERENCE_DEFAULTS }
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const prefs = { ...PICK_PREFERENCE_DEFAULTS }
  for (const key of PICK_PREFERENCE_KEYS) {
    const candidate = value[key]
    if (candidate === undefined || candidate === null) continue
    if (typeof candidate !== 'string' || !PICK_PREFERENCE_OPTIONS[key].includes(candidate)) return null
    prefs[key] = candidate
  }
  return prefs
}

function normalizePickModel(value) {
  if (!value || typeof value !== 'object') return null
  const provider = pickText(value.provider).trim()
  const model = pickText(value.model).trim()
  if (!provider || !model || provider.length > 64 || model.length > 200) return null
  return { provider, model }
}

/**
 * Resolve the profile's default provider/model selection.
 *
 * @param {{ getSelection?: () => any }} services
 * @returns {{ provider: string, model: string }}
 */
function resolvePickRoute(services) {
  const route = { provider: '', model: '' }
  try {
    const selection = services && typeof services.getSelection === 'function' ? services.getSelection() : null
    if (selection && typeof selection.provider === 'string' && selection.provider && typeof selection.model === 'string' && selection.model) {
      route.provider = selection.provider
      route.model = selection.model
    }
  } catch {
    // Treat a broken selection source as "no selection".
  }
  return route
}

/**
 * Build the system + user prompt for one pick call.
 *
 * @param {{ item: object, rows: object[], lang: 'zh' | 'en' }} options
 * @returns {{ system: string, prompt: string }}
 */
function buildPickPrompt({ item, rows, lang, preferences }) {
  const zh = lang !== 'en'
  const title = pickText(item.title) || (zh ? '未命名作品' : 'Untitled')
  const year = pickText(item.year)
  const kind = item.kind === 'tv' ? (zh ? '剧集' : 'TV series') : (zh ? '电影' : 'movie')
  const lines = rows.map((row, index) => {
    const parts = [`${index + 1}. ${row.title}`]
    if (row.size) parts.push(zh ? `大小 ${row.size}` : `size ${row.size}`)
    if (row.seeders !== null) parts.push(zh ? `做种 ${row.seeders}` : `seeders ${row.seeders}`)
    if (row.leechers !== null) parts.push(zh ? `下载 ${row.leechers}` : `leechers ${row.leechers}`)
    if (row.source) parts.push(zh ? `来源 ${row.source}` : `source ${row.source}`)
    return parts.join(' · ')
  })
  const labels = PICK_PREFERENCE_LABELS[zh ? 'zh' : 'en']
  const prefs = preferences || PICK_PREFERENCE_DEFAULTS
  const priorityLines = [
    `${labels.quality.title}: ${labels.quality[prefs.quality] || prefs.quality}`,
    `${labels.language.title}: ${labels.language[prefs.language] || prefs.language}`,
    `${labels.subtitle.title}: ${labels.subtitle[prefs.subtitle] || prefs.subtitle}`,
  ].join('\n')
  const systemBase = zh
    ? '你是影视资源挑选助手。请比较候选 BT 资源，挑出最值得下载的一个：综合做种数、资源大小是否合理、画质/片源/编码/字幕线索与来源可靠性，做种过少或来源不明的要降权。只输出 JSON，不要 Markdown，不要额外解释。'
    : 'You pick the best torrent for a title. Compare seeder counts, size sanity, quality/source/codec/subtitle hints and index reliability; down-rank dead or sketchy entries. Output JSON only, no Markdown and no extra prose.'
  const instruction = zh
    ? '只输出一行 JSON（不要代码块、不要换行）：{"best": 编号, "reason": "不超过 40 字的中文理由", "picks": [{"rank": 1, "id": 编号, "reason": "理由"}]}'
    : 'Output exactly one line of JSON (no code fence, no newlines): {"best": index, "reason": "one-sentence reason", "picks": [{"rank": 1, "id": index, "reason": "reason"}]}'
  const system = `${systemBase}\n\n输出格式（不可修改）：${instruction}`
  const priority = `${labels.priority}\n${priorityLines}\n\n`
  const head = zh
    ? `作品：${title}${year ? `（${year}）` : ''}，${kind}。\n${priority}候选 BT 资源（编号从 1 开始）：\n${lines.join('\n')}\n\n`
    : `Title: ${title}${year ? ` (${year})` : ''}, ${kind}.\n${priority}Candidate torrents (1-based):\n${lines.join('\n')}\n\n`
  return { system, prompt: head }
}

/**
 * Parse a model answer into a pick. Accepts plain JSON, fenced JSON or JSON
 * embedded in an explanation. Returns `parseFailed` when no object parses.
 *
 * @param {string} text
 * @param {object[]} rows
 * @returns {{ pick: { id: string, rank: number, reason: string } | null, picks: { id: string, reason: string }[], analysis: string, parseFailed: boolean }}
 */
/**
 * Deterministic fallback used when the model returns nothing usable: rank by
 * seeders first, then by a plausible size and a higher-resolution hint.
 *
 * @param {object[]} rows
 * @param {string} lang
 * @returns {{ id: string, rank: number, reason: string } | null}
 */
export function fallbackPick(rows, lang) {
  const zh = lang !== 'en'
  let best = null
  let bestScore = -Infinity
  rows.forEach((row, index) => {
    const seeders = typeof row.seeders === 'number' ? row.seeders : 0
    const size = String(row.size || '')
    const gb = Number((size.match(/([\d.]+)\s*GB/i) || size.match(/([\d.]+)\s*GiB/i) || [])[1])
    const sizeScore = Number.isFinite(gb) && gb >= 0.3 && gb <= 40 ? 6 : 0
    const resolution = /2160p|4k/i.test(row.title) ? 24 : /1080p/i.test(row.title) ? 18 : /720p/i.test(row.title) ? 8 : 0
    const score = Math.min(seeders, 400) + sizeScore + resolution
    if (score > bestScore) {
      bestScore = score
      best = { id: String(row.id), rank: index + 1, reason: zh
        ? '模型未返回有效结果，已按做种数、分辨率与体积自动推荐。'
        : 'The model returned nothing usable; picked by seeders, resolution and size.' }
    }
  })
  return best
}

export function parsePickResponse(text, rows) {
  const limit = Array.isArray(rows) ? rows.length : 0
  const raw = typeof text === 'string' ? text : ''
  const cleaned = raw.replace(/```[a-zA-Z0-9_-]*\s*/g, '').trim()
  const candidates = []
  if (cleaned) candidates.push(cleaned)
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(cleaned.slice(start, end + 1))
  let parsed = null
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate)
      break
    } catch {
      // Try the next candidate.
    }
  }
  const result = { pick: null, picks: [], analysis: cleaned.slice(0, 2000), parseFailed: parsed === null }
  if (!parsed || typeof parsed !== 'object') {
    // Tolerate truncated or loosely formatted answers: recover the numbered
    // best index and reason with a small regex instead of failing outright.
    const bestMatch = cleaned.match(/["']?best["']?\s*[:=]\s*["']?(\d{1,3})/i)
    if (bestMatch) {
      const reasonMatch = cleaned.match(/["']?reason["']?\s*[:=]\s*["']([^"']{1,240})/i)
      parsed = { best: Number(bestMatch[1]), reason: reasonMatch ? reasonMatch[1] : '' }
    } else {
      return result
    }
  }
  const toIndex = (value) => {
    if (typeof value === 'number' && Number.isInteger(value)) return value
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
    return null
  }
  const reasonOf = (value) => (typeof value === 'string' ? value.trim().slice(0, 240) : '')
  const picks = []
  if (Array.isArray(parsed.picks)) {
    for (const entry of parsed.picks) {
      if (!entry || typeof entry !== 'object') continue
      const index = toIndex(entry.id !== undefined ? entry.id : entry.index)
      if (index === null || index < 1 || index > limit) continue
      const row = rows[index - 1]
      if (!row) continue
      picks.push({ id: String(row.id), rank: index, reason: reasonOf(entry.reason) })
    }
    picks.sort((left, right) => left.rank - right.rank)
  }
  let best = toIndex(parsed.best)
  if (best === null) best = toIndex(parsed.pick)
  if (best === null && picks.length > 0) best = picks[0].rank
  if (best !== null && best >= 1 && best <= limit && rows[best - 1]) {
    const directReason = reasonOf(parsed.reason)
    const ranked = picks.find((entry) => entry.rank === best)
    result.pick = {
      id: String(rows[best - 1].id),
      rank: best,
      reason: directReason || (ranked ? ranked.reason : ''),
    }
  }
  result.picks = picks.map((entry) => ({ id: entry.id, reason: entry.reason }))
  result.parseFailed = parsed === null
  return result
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
 * Read the optional `/browse` `page` parameter (contract v1.6): an integer
 * 1–`MAX_BROWSE_PAGE`; omitted means page 1, anything else is invalid.
 *
 * @param {URLSearchParams} searchParams
 * @returns {number} page number, or 0 when the value is invalid
 */
function parseBrowsePage(searchParams) {
  const raw = (searchParams.get('page') || '').trim()
  if (!raw) return 1
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_BROWSE_PAGE) return 0
  return value
}

/**
 * Read the optional `/chart` `start` parameter (contract v1.8): a non-negative
 * integer up to `MAX_CHART_START`; omitted means 0.
 *
 * @param {URLSearchParams} searchParams
 * @returns {number | null} start offset, or null when invalid
 */
/** `collection:<id>` chart ids open a title's Douban subject collection. */
function parseDoubanCollectionChartId(value) {
  const text = String(value || '')
  if (text.indexOf('collection:') !== 0) return ''
  const raw = text.slice('collection:'.length)
  return /^[A-Za-z0-9_]{1,64}$/.test(raw) ? raw : ''
}

function parseChartStart(searchParams) {
  const raw = (searchParams.get('start') || '').trim()
  if (!raw) return 0
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > MAX_CHART_START) return null
  return value
}

/**
 * Read the optional `/chart` `count` parameter (contract v1.8): an integer
 * 1–`MAX_CHART_PAGE_SIZE`, default `CHART_PAGE_SIZE`.
 *
 * @param {URLSearchParams} searchParams
 * @returns {number} page size, or 0 when invalid
 */

function parseChartCount(searchParams) {
  const raw = (searchParams.get('count') || '').trim()
  if (!raw) return CHART_PAGE_SIZE
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_CHART_PAGE_SIZE) return 0
  return value
}

/**
 * Generated chart entries per kind (contract v1.11). Movie lists: 54 genre
 * charts (27 genres x 高分经典/近期热门), 27 冷门佳作 charts (one per genre) and
 * two 年度榜单 charts (高分/热门) for each configured year. TV lists: the same
 * annual and genre charts with `tv-` ids; Douban has too few TV 冷门佳片 rows,
 * so TV gets no hidden-gems family.
 * Titles and descriptions are static so `/charts` stays a single cheap request;
 * rows come from `/chart?source=douban&id=<generated id>`.
 *
 * @param {'movie' | 'tv'} kind
 * @returns {object[]}
 */
function generatedChartCatalog(kind) {
  const charts = []
  const prefix = kind === 'tv' ? 'tv-' : ''
  const suffix = kind === 'tv' ? '剧' : '片'
  for (const genre of DOUBAN_GENRES) {
    for (const sort of DOUBAN_GENRE_SORTS) {
      charts.push({
        id: `${prefix}genre:${genre}:${sort.key}`,
        title: `${sort.label}${genre}${suffix}`,
        subtitle: '分类榜单',
        description: sort.description,
        total: null,
        cover: null,
        family: sort.key === 'S' ? 'rating' : 'heat',
        kind,
      })
    }
  }
  if (kind === 'movie') {
    for (const genre of DOUBAN_GENRES) {
      charts.push({
        id: `hidden:${genre}`,
        title: `冷门佳作 · ${genre}`,
        subtitle: '冷门佳片',
        description: '评分优先的冷门佳片',
        total: null,
        cover: null,
        family: 'hidden',
        kind,
      })
    }
  }
  for (const year of DOUBAN_ANNUAL_YEARS) {
    for (const sort of DOUBAN_GENRE_SORTS) {
      charts.push({
        id: `${prefix}year:${year}:${sort.key}`,
        title: sort.key === 'S' ? `${year} 年度高分` : `${year} 年度热门`,
        subtitle: '年度片单',
        description: sort.description,
        total: null,
        cover: null,
        family: 'annual',
        kind,
      })
    }
  }
  return charts
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
 * Run one channel browse provider (contract v1.6).
 *
 * @param {string} name provider id (`tmdb`, `imdb`, `douban`)
 * @param {object} context
 * @param {string} context.category
 * @param {number} context.page
 * @param {string} context.lang
 * @param {{ kind: 'bearer' | 'v3', value: string } | null} context.credential
 * @param {object} context.settings
 * @returns {Promise<{ items: object[], hasMore: boolean }>}
 */
async function browseSource(name, { category, page, cursor, lang, credential, settings }) {
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
      return browseDouban(common)
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
