import { DOUBAN_ANNUAL_YEARS, DOUBAN_CHART_IDS, DOUBAN_CHART_KINDS, DOUBAN_GENRES, ProviderError, doubanChartKind, fetchDoubanChartItems, fetchDoubanChartMeta, fetchDoubanDetail, fetchDoubanTagChartItems, fetchImdbDetail, fetchImdbSeries, fetchTmdbCollection, fetchTmdbMovieDetail, listDoubanCharts, parseDoubanChartRef } from '../../providers.js'
import { MAX_CHART_PAGE_SIZE, MAX_CHART_START } from '../config.js'
import { sendJson } from '../http.js'
import { generatedChartCatalog, parseChartCount, parseChartStart, parseDoubanCollectionChartId, parseLangParam, resolveRequestCredential } from '../params.js'
import { providerFailure } from '../sources.js'

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
export async function handleCharts(req, res, searchParams, settings) {
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
export async function handleChart(req, res, searchParams, settings) {
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
export async function handleDetail(req, res, searchParams, settings) {
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
export async function handleCollection(req, res, searchParams, settings) {
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
export async function handleSeries(req, res, searchParams, settings) {
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
