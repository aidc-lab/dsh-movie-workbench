import { DEFAULT_USER_AGENT, ERROR_UPSTREAM, ProviderError, asString, createResult, discardBody, interleaveRows, readJson, subjectIdFromUrl, toPageUrl, toPoster, toRating, toVotes, toYear, trimString } from './core.js'

export const DOUBAN_SUGGEST_URL = 'https://movie.douban.com/j/subject_suggest'
export const DOUBAN_TRENDING_URL = 'https://movie.douban.com/j/search_subjects'
export const DOUBAN_SUBJECT_BASE_URL = 'https://movie.douban.com/subject'
export const DOUBAN_REFERER = 'https://movie.douban.com/'
/**
 * Douban's mobile subject-detail API. The suggestion/search endpoints carry no
 * synopsis, so the detail page loads it on demand from here. TV subjects answer
 * the `movie` path with a redirect to `tv`, which `fetch` follows.
 */
export const DOUBAN_DETAIL_URL = 'https://m.douban.com/rexxar/api/v2/movie'
export const DOUBAN_DETAIL_REFERER = 'https://m.douban.com/'
export const DOUBAN_DETAIL_CACHE_TTL_MS = 30 * 60 * 1000
export const DOUBAN_DETAIL_CACHE_LIMIT = 100
/** Douban subject detail, keyed by subject id; bounded by the limit above. */
export const doubanDetailCache = new Map()
export const DOUBAN_CHARTS = Object.freeze([
  Object.freeze({ id: 'movie_top250', title: '豆瓣电影 Top250', kind: 'movie' }),
  Object.freeze({ id: 'movie_weekly_best', title: '一周口碑电影榜', kind: 'movie' }),
  Object.freeze({ id: 'movie_real_time_hotest', title: '实时热门电影', kind: 'movie' }),
  Object.freeze({ id: 'tv_real_time_hotest', title: '实时热门电视', kind: 'tv' }),
  Object.freeze({ id: 'tv_chinese_best_weekly', title: '华语口碑剧集榜', kind: 'tv' }),
  Object.freeze({ id: 'tv_global_best_weekly', title: '全球口碑剧集榜', kind: 'tv' }),
])

/** Ids accepted by `/charts` and `/chart`, in display order. */
export const DOUBAN_CHART_IDS = Object.freeze(DOUBAN_CHARTS.map((chart) => chart.id))

/** Chart kinds: movie charts and TV charts are listed and paged separately. */
export const DOUBAN_CHART_KINDS = Object.freeze(['movie', 'tv'])

export const DOUBAN_GENRES = Object.freeze([
  '剧情', '喜剧', '动作', '爱情', '科幻', '动画', '悬疑', '惊悚', '恐怖',
  '纪录片', '短片', '音乐', '歌舞', '家庭', '儿童', '传记', '历史', '战争',
  '犯罪', '西部', '奇幻', '冒险', '灾难', '武侠', '古装', '运动', '黑色电影',
])

/** The two genre chart families: high scores and recent heat. */
export const DOUBAN_GENRE_SORTS = Object.freeze([
  Object.freeze({ key: 'S', label: '高分经典', description: '按豆瓣评分优先' }),
  Object.freeze({ key: 'U', label: '近期热门', description: '按近期热度优先' }),
])

/**
 * Douban's tag for hidden gems (`冷门佳片`), used by the 冷门佳作 charts.
 */
export const DOUBAN_HIDDEN_TAGS = '冷门佳片'

/**
 * Years offered as 年度榜单 entries (newest first). Each one filters the
 * movie recommendation list by its year tag and sorts by Douban rating.
 */
export const DOUBAN_ANNUAL_YEARS = Object.freeze([2025, 2024, 2023, 2022, 2021])

export const DOUBAN_RECOMMEND_URL = 'https://m.douban.com/rexxar/api/v2/movie/recommend'
export const DOUBAN_RECOMMEND_REFERER = 'https://m.douban.com/movie/'
export const DOUBAN_TV_RECOMMEND_URL = 'https://m.douban.com/rexxar/api/v2/tv/recommend'
export const DOUBAN_TV_RECOMMEND_REFERER = 'https://m.douban.com/tv/'
export const DOUBAN_COLLECTION_URL = 'https://m.douban.com/rexxar/api/v2/subject_collection'
export const DOUBAN_COLLECTION_REFERER = 'https://m.douban.com/'
export const DOUBAN_CHART_META_CACHE_TTL_MS = 6 * 60 * 60 * 1000
export const DOUBAN_CHART_META_CACHE_LIMIT = 20
/** Chart metadata (title/description/cover/total), keyed by chart id. */
export const doubanChartMetaCache = new Map()
/**
 * A keyless Douban category has no server-side year/rating/kind filter, so the
 * filtered views read one large recommendation pool and page it locally in the
 * Host. 200 rows per feed is the upstream cap we observed; `popular` combines
 * 200 movie rows with 200 TV rows.
 */
export const DOUBAN_BROWSE_POOL_SIZE = 200
export const DOUBAN_BROWSE_POOL_TTL_MS = 5 * 60 * 1000
export const DOUBAN_BROWSE_POOL_LIMIT = 6
/** Unfiltered recommendation pool per browse category. */
export const doubanBrowsePoolCache = new Map()

/**
 * Which kind an official chart id belongs to; null for generated ids.
 *
 * @param {string} id
 * @returns {'movie' | 'tv' | null}
 */
export function doubanChartKind(id) {
  const entry = DOUBAN_CHARTS.find((chart) => chart.id === id)
  return entry ? entry.kind : null
}
/**
 * Normalize one Douban `subject_suggest` row.
 *
 * @param {unknown} item
 * @returns {object | null} contract result row, or `null` for malformed rows
 */
export function normalizeDoubanItem(item) {
  if (!item || typeof item !== 'object') return null
  const id = trimString(item.id) || subjectIdFromUrl(asString(item.url))
  if (!id) return null
  const title = trimString(item.title) || trimString(item.sub_title)
  const isTv = trimString(item.type) === 'tv' || trimString(item.episode) !== ''
  const fallbackUrl = `${DOUBAN_SUBJECT_BASE_URL}/${encodeURIComponent(id)}/`
  return createResult('douban', {
    id,
    title,
    originalTitle: trimString(item.sub_title),
    year: toYear(item.year),
    kind: isTv ? 'tv' : 'movie',
    rating: null,
    votes: null,
    overview: '',
    poster: toPoster(asString(item.img)),
    url: toPageUrl(asString(item.url), fallbackUrl),
  })
}
/**
 * Normalize one Douban `j/search_subjects` (trending) row.
 *
 * @param {unknown} item
 * @param {'movie' | 'tv'} type request type, which decides the contract `kind`
 * @returns {object | null} contract result row, or `null` for malformed rows
 */
export function normalizeDoubanTrendingItem(item, type) {
  if (!item || typeof item !== 'object') return null
  const id = trimString(item.id) || subjectIdFromUrl(asString(item.url))
  if (!id) return null
  const title = trimString(item.title) || trimString(item.sub_title)
  const fallbackUrl = `${DOUBAN_SUBJECT_BASE_URL}/${encodeURIComponent(id)}/`
  return createResult('douban', {
    id,
    title,
    originalTitle: title,
    year: null,
    kind: type === 'tv' ? 'tv' : 'movie',
    rating: toRating(item.rate),
    votes: null,
    overview: '',
    poster: toPoster(asString(item.cover)),
    url: toPageUrl(asString(item.url), fallbackUrl),
  })
}
/**
 * Normalize one row from Douban's mobile recommendation feed. Unlike the
 * desktop `j/search_subjects` rows these carry the release year, vote count
 * and full card subtitle, so list cards can show the year.
 *
 * @param {unknown} item
 * @param {'movie' | 'tv'} type
 * @returns {object | null}
 */
export function normalizeDoubanRecommendItem(item, type) {
  if (!item || typeof item !== 'object') return null
  const id = trimString(item.id) || subjectIdFromUrl(asString(item.url))
  if (!id) return null
  const title = trimString(item.title) || trimString(item.sub_title)
  if (!title) return null
  const rating = item.rating && typeof item.rating === 'object' ? item.rating : {}
  const pic = item.pic && typeof item.pic === 'object' ? item.pic : {}
  const posterUrl = trimString(pic.large) || trimString(pic.normal) || trimString(item.cover_url) || trimString(item.cover)
  const fallbackUrl = `${DOUBAN_SUBJECT_BASE_URL}/${encodeURIComponent(id)}/`
  return createResult('douban', {
    id,
    title,
    originalTitle: title,
    year: toYear(item.year),
    kind: type === 'tv' ? 'tv' : 'movie',
    rating: toRating(rating.value),
    votes: toVotes(rating.count),
    overview: trimString(item.description) || '',
    poster: toPoster(posterUrl),
    url: toPageUrl(asString(item.url), fallbackUrl),
  })
}
/**
 * Search Douban's keyless subject suggestion API (needs the browser-like UA).
 *
 * @param {object} options
 * @param {string} options.query
 * @param {number} options.maxResults
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<object[]>} normalized rows in upstream order, capped at `maxResults`
 */
export async function searchDouban({ query, maxResults, timeoutMs, userAgent }) {
  const url = `${DOUBAN_SUGGEST_URL}?q=${encodeURIComponent(query)}`
  const response = await fetch(url, {
    headers: {
      'user-agent': userAgent || DEFAULT_USER_AGENT,
      accept: 'application/json, text/plain, */*',
      referer: DOUBAN_REFERER,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    discardBody(response)
    throw new ProviderError(ERROR_UPSTREAM, `Douban responded with HTTP ${response.status}.`)
  }
  const payload = await readJson(response, 'Douban')
  if (!Array.isArray(payload)) {
    throw new ProviderError(ERROR_UPSTREAM, 'Douban returned an unexpected response payload.')
  }
  return payload.map(normalizeDoubanItem).filter(Boolean).slice(0, maxResults)
}
/**
 * Fetch one Douban subject's detail data (keyless mobile API). Douban's
 * suggestion and search endpoints return no synopsis, so the detail page asks
 * for it lazily; the response also carries genres, runtime, region and the
 * published rating. Resolved details are cached in Host memory for 30 minutes.
 *
 * @param {object} options
 * @param {string} options.id numeric Douban subject id
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<object>} normalized detail; `overview` is always a string
 */
export async function fetchDoubanDetail({ id, timeoutMs, userAgent }) {
  const key = String(id)
  const cached = readDoubanDetailCache(key)
  if (cached) return cached
  const url = `${DOUBAN_DETAIL_URL}/${encodeURIComponent(key)}?for_mobile=1`
  const response = await fetch(url, {
    headers: {
      'user-agent': userAgent || DEFAULT_USER_AGENT,
      accept: 'application/json, text/plain, */*',
      referer: DOUBAN_DETAIL_REFERER,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    discardBody(response)
    throw new ProviderError(ERROR_UPSTREAM, `Douban responded with HTTP ${response.status}.`)
  }
  const payload = await readJson(response, 'Douban')
  const detail = normalizeDoubanDetail(payload, key)
  detail.collections = await enrichDoubanCollections(detail.collections, { timeoutMs, userAgent })
  writeDoubanDetailCache(key, detail)
  return detail
}
/**
 * Normalize one Douban subject-detail payload.
 *
 * @param {unknown} payload
 * @param {string} fallbackId
 * @returns {object} normalized detail
 */
export function normalizeDoubanDetail(payload, fallbackId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProviderError(ERROR_UPSTREAM, 'Douban returned an unexpected response payload.')
  }
  const title = trimString(payload.title)
  if (!title) {
    throw new ProviderError(ERROR_UPSTREAM, 'Douban returned no subject for that id.')
  }
  const durations = toStringList(payload.durations)
  const countries = toStringList(payload.countries)
  const rating = payload.rating && typeof payload.rating === 'object' ? payload.rating : {}
  return {
    id: trimString(payload.id) || fallbackId,
    title,
    originalTitle: trimString(payload.original_title),
    year: toYear(payload.year),
    kind: payload.is_tv === true ? 'tv' : 'movie',
    rating: toRating(rating.value),
    votes: toVotes(rating.count),
    overview: trimString(payload.intro),
    genres: toStringList(payload.genres),
    runtime: durations[0] || '',
    region: countries.join(' / '),
    collections: normalizeDoubanCollections(payload.subject_collections),
  }
}
/**
 * The official subject-collection ids a Douban title belongs to (contract
 * v1.14). Douban calls these "榜单"; the detail payload lists them per title,
 * each one opens through `/chart?id=collection:<id>`.
 *
 * @param {unknown} value
 * @returns {{ id: string, title: string }[]}
 */
export async function enrichDoubanCollections(collections, options) {
  if (!Array.isArray(collections) || collections.length === 0) return collections
  return Promise.all(collections.map(async (entry) => {
    try {
      const meta = await fetchDoubanChartMeta(entry.id, options)
      if (!meta) return entry
      return {
        id: entry.id,
        title: entry.title || meta.title,
        subtitle: meta.subtitle || entry.subtitle || '',
        description: meta.description || entry.description || '',
        cover: meta.cover || entry.cover || null,
        total: Number.isInteger(meta.total) ? meta.total : (entry.total || null),
      }
    } catch (error) {
      return entry
    }
  }))
}
export function normalizeDoubanCollections(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const collections = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const id = trimString(entry.id)
    const title = trimString(entry.title)
    if (!/^[A-Za-z0-9_]{1,64}$/.test(id) || !title || seen.has(id)) continue
    seen.add(id)
    collections.push({
      id: id,
      title: title,
      subtitle: trimString(entry.subtitle),
      description: trimString(entry.description),
      cover: toPoster(asString(entry.cover_url)),
      total: toVotes(entry.total),
    })
    if (collections.length >= 8) break
  }
  return collections
}
/**
 * @param {unknown} value
 * @returns {string[]} trimmed, non-empty string list
 */
export function toStringList(value) {
  if (!Array.isArray(value)) return []
  return value.map(trimString).filter(Boolean)
}
/**
 * @param {unknown} payload
 * @param {{ id: string, title?: string }} fallback
 * @returns {{ id: string, title: string, subtitle: string, description: string, total: number | null, cover: string | null }}
 */
export function normalizeDoubanChartMeta(payload, fallback) {
  if (!payload || typeof payload !== 'object') {
    throw new ProviderError(ERROR_UPSTREAM, 'Douban returned an unexpected chart payload.')
  }
  return {
    id: trimString(payload.id) || fallback.id,
    title: trimString(payload.title) || fallback.title || fallback.id,
    subtitle: trimString(payload.subtitle) || '豆瓣榜单',
    description: trimString(payload.description),
    total: toVotes(payload.total),
    cover: toPoster(asString(payload.cover_url)),
  }
}
/**
 * One chart's metadata, cached for six hours. A failure throws; callers that
 * list every chart fall back to the static entry instead.
 *
 * @param {string} id
 * @param {{ timeoutMs: number, userAgent?: string }} options
 * @returns {Promise<object>}
 */
export async function fetchDoubanChartMeta(id, { timeoutMs, userAgent }) {
  const cached = readDoubanChartMetaCache(id)
  if (cached) return cached
  const response = await fetch(
    `${DOUBAN_COLLECTION_URL}/${encodeURIComponent(id)}?for_mobile=1`,
    {
      headers: {
        'user-agent': userAgent || DEFAULT_USER_AGENT,
        accept: 'application/json, text/plain, */*',
        referer: DOUBAN_COLLECTION_REFERER,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    },
  )
  if (!response.ok) {
    discardBody(response)
    throw new ProviderError(ERROR_UPSTREAM, `Douban responded with HTTP ${response.status}.`)
  }
  const payload = await readJson(response, 'Douban')
  const meta = normalizeDoubanChartMeta(payload, { id })
  writeDoubanChartMetaCache(id, meta)
  return meta
}
/**
 * Every chart, in display order. A chart whose metadata failed keeps its static
 * title and is reported in `errors` so the client can still render the tab.
 *
 * @param {{ timeoutMs: number, userAgent?: string }} options
 * @returns {Promise<{ charts: object[], errors: object[] }>}
 */
export async function listDoubanCharts({ kind = 'movie', timeoutMs, userAgent }) {
  const entries = DOUBAN_CHARTS.filter((chart) => chart.kind === kind)
  const settled = await Promise.all(entries.map(async (entry) => {
    try {
      const meta = await fetchDoubanChartMeta(entry.id, { timeoutMs, userAgent })
      return { ok: true, chart: { ...meta, title: meta.title || entry.title } }
    } catch (error) {
      const failure = error instanceof ProviderError ? error : null
      return {
        ok: false,
        entry,
        error: {
          source: 'douban',
          code: failure && failure.code ? failure.code : ERROR_UPSTREAM,
          message: failure && failure.message ? failure.message : 'Douban chart metadata failed.',
        },
      }
    }
  }))
  const charts = []
  const errors = []
  for (const result of settled) {
    if (result.ok) {
      charts.push(result.chart)
      continue
    }
    errors.push(result.error)
    charts.push({
      id: result.entry.id,
      title: result.entry.title,
      subtitle: '豆瓣榜单',
      description: '',
      total: null,
      cover: null,
      kind: result.entry.kind,
    })
  }
  return { charts, errors }
}
/**
 * @param {unknown} item chart item row
 * @param {'movie' | 'tv'} fallbackKind used when the row omits a usable type
 * @returns {object | null} contract result row (plus `rank` and `subtitle`), or null
 */
export function normalizeDoubanChartItem(item, fallbackKind) {
  if (!item || typeof item !== 'object') return null
  const id = trimString(item.id) || subjectIdFromUrl(asString(item.url))
  if (!id) return null
  const title = trimString(item.title)
  if (!title) return null
  const rating = item.rating && typeof item.rating === 'object' ? item.rating : {}
  const type = trimString(item.type)
  const kind = type === 'tv' ? 'tv' : type === 'movie' ? 'movie' : fallbackKind
  const subtitle = trimString(item.card_subtitle)
  const yearMatch = subtitle.match(/^(\d{4})/)
  const fallbackUrl = `${DOUBAN_SUBJECT_BASE_URL}/${encodeURIComponent(id)}/`
  /* Chart rows come from two different Douban payloads: subject_collection
     items expose `cover_url`, while the recommend feed only exposes
     `pic.large` / `pic.normal`. Prefer whichever exists. */
  const pic = item.pic && typeof item.pic === 'object' ? item.pic : {}
  const row = createResult('douban', {
    id,
    title,
    originalTitle: '',
    year: toYear(yearMatch ? yearMatch[1] : ''),
    kind,
    rating: toRating(rating.value),
    votes: toVotes(rating.count),
    overview: trimString(item.comment) || trimString(item.description),
    poster: toPoster(asString(item.cover_url) || asString(pic.large) || asString(pic.normal)),
    url: toPageUrl(asString(item.url), fallbackUrl),
  })
  row.rank = Number.isInteger(item.rank) && item.rank > 0 ? item.rank : null
  row.subtitle = subtitle
  return row
}
/**
 * One range of a chart's ranked titles. The chart page keeps its own paging
 * state (`start`/`count`) and the Host returns `total` so it can tell when the
 * list ends.
 *
 * @param {string} id chart id (already allowlisted by the Host)
 * @param {{ start: number, count: number, timeoutMs: number, userAgent?: string }} options
 * @returns {Promise<{ total: number | null, start: number, items: object[] }>}
 */
export async function fetchDoubanChartItems(id, { start, count, timeoutMs, userAgent }) {
  const entry = DOUBAN_CHARTS.find((chart) => chart.id === id)
  const fallbackKind = entry ? entry.kind : 'movie'
  const params = new URLSearchParams({
    start: String(start),
    count: String(count),
    for_mobile: '1',
  })
  const response = await fetch(
    `${DOUBAN_COLLECTION_URL}/${encodeURIComponent(id)}/items?${params.toString()}`,
    {
      headers: {
        'user-agent': userAgent || DEFAULT_USER_AGENT,
        accept: 'application/json, text/plain, */*',
        referer: DOUBAN_COLLECTION_REFERER,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    },
  )
  if (!response.ok) {
    discardBody(response)
    throw new ProviderError(ERROR_UPSTREAM, `Douban responded with HTTP ${response.status}.`)
  }
  const payload = await readJson(response, 'Douban')
  const rawItems = Array.isArray(payload && payload.subject_collection_items)
    ? payload.subject_collection_items
    : []
  const items = rawItems
    .map((item) => normalizeDoubanChartItem(item, fallbackKind))
    .filter(Boolean)
  return {
    total: toVotes(payload && payload.total),
    start,
    items,
  }
}
/**
 * Parse a generated chart id into its kind/tag/sort triple. Accepted shapes:
 * `genre:<genre>:<S|U>`, `hidden:<genre>`, `year:<yyyy>:<S|U>`, `tv-genre:<genre>:<S|U>`
 * and `tv-year:<yyyy>:<S|U>`. Returns null for anything malformed or outside
 * the allowlists.
 *
 * @param {string} id
 * @returns {{ kind: 'movie' | 'tv', tags: string, sort: string } | null}
 */
export function parseDoubanChartRef(id) {
  const parts = String(id || '').split(':')
  const sortKeys = DOUBAN_GENRE_SORTS.map((entry) => entry.key)
  if (parts.length === 3 && parts[0] === 'genre') {
    if (DOUBAN_GENRES.indexOf(parts[1]) === -1) return null
    if (sortKeys.indexOf(parts[2]) === -1) return null
    return { kind: 'movie', tags: parts[1], sort: parts[2] }
  }
  if (parts.length === 2 && parts[0] === 'hidden') {
    if (DOUBAN_GENRES.indexOf(parts[1]) === -1) return null
    return { kind: 'movie', tags: `${DOUBAN_HIDDEN_TAGS},${parts[1]}`, sort: 'S' }
  }
  if (parts.length === 3 && parts[0] === 'year') {
    if (!/^\d{4}$/.test(parts[1])) return null
    if (DOUBAN_ANNUAL_YEARS.indexOf(Number(parts[1])) === -1) return null
    if (sortKeys.indexOf(parts[2]) === -1) return null
    return { kind: 'movie', tags: parts[1], sort: parts[2] }
  }
  if (parts.length === 3 && parts[0] === 'tv-genre') {
    if (DOUBAN_GENRES.indexOf(parts[1]) === -1) return null
    if (sortKeys.indexOf(parts[2]) === -1) return null
    return { kind: 'tv', tags: parts[1], sort: parts[2] }
  }
  if (parts.length === 3 && parts[0] === 'tv-year') {
    if (!/^\d{4}$/.test(parts[1])) return null
    if (DOUBAN_ANNUAL_YEARS.indexOf(Number(parts[1])) === -1) return null
    if (sortKeys.indexOf(parts[2]) === -1) return null
    return { kind: 'tv', tags: parts[1], sort: parts[2] }
  }
  return null
}
/**
 * One range of a generated chart. Backed by the mobile recommendation list of
 * one kind (movie or TV) filtered by a tag (a genre, `冷门佳片`, or a year) and
 * sorted by either rating (`S`) or recent heat (`U`). Supports exact
 * `start`/`count` paging and reports a `total` (Douban caps the list at 500).
 * Announcement cards (`type: 'chart'`) are dropped from the rows.
 *
 * @param {{ kind?: 'movie' | 'tv', tags: string, sort: string, start: number, count: number, timeoutMs: number, userAgent?: string }} options
 * @returns {Promise<{ total: number | null, start: number, items: object[] }>}
 */
export async function fetchDoubanTagChartItems({ kind = 'movie', tags, sort, start, count, timeoutMs, userAgent }) {
  const upstream = kind === 'tv'
    ? { url: DOUBAN_TV_RECOMMEND_URL, referer: DOUBAN_TV_RECOMMEND_REFERER }
    : { url: DOUBAN_RECOMMEND_URL, referer: DOUBAN_RECOMMEND_REFERER }
  const params = new URLSearchParams({
    refresh: '0',
    start: String(start),
    count: String(count),
    selected_categories: '{}',
    uncollect: 'false',
    tags,
    sort,
  })
  const response = await fetch(`${upstream.url}?${params.toString()}`, {
    headers: {
      'user-agent': userAgent || DEFAULT_USER_AGENT,
      accept: 'application/json, text/plain, */*',
      referer: upstream.referer,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    discardBody(response)
    throw new ProviderError(ERROR_UPSTREAM, `Douban responded with HTTP ${response.status}.`)
  }
  const payload = await readJson(response, 'Douban')
  const rawItems = Array.isArray(payload && payload.items) ? payload.items : []
  const items = rawItems
    .filter((item) => item && item.type === kind)
    .map((item) => normalizeDoubanChartItem(item, kind))
    .filter(Boolean)
    .map((row) => ({ ...row, rank: null }))
  const rawTotal = toVotes(payload && payload.total)
  return {
    total: rawTotal === null ? null : Math.min(rawTotal, 500),
    start,
    items,
  }
}
export const DEFAULT_DOUBAN_BROWSE_FILTERS = Object.freeze({
  sort: 'default',
  decade: 'all',
  minRating: 0,
  kind: 'all',
})

const DOUBAN_DECADE_RANGES = Object.freeze({
  '2020s': [2020, 2029],
  '2010s': [2010, 2019],
  '2000s': [2000, 2009],
  '1990s': [1990, 1999],
  older: [0, 1989],
})

/**
 * Whether the browse request needs the large local pool: a non-default sort or
 * any filter. The ordinary paged path stays in place when this is false.
 *
 * @param {object} [filters]
 * @returns {boolean}
 */
export function hasDoubanBrowseFilters(filters) {
  if (!filters) return false
  return filters.sort !== 'default'
    || filters.decade !== 'all'
    || Number(filters.minRating) > 0
    || filters.kind !== 'all'
}

/**
 * Apply the decade, minimum-rating and kind filters to normalized Douban rows.
 *
 * @param {object[]} rows
 * @param {object} [filters]
 * @returns {object[]}
 */
export function filterDoubanRows(rows, filters = DEFAULT_DOUBAN_BROWSE_FILTERS) {
  const decade = filters.decade || 'all'
  const minRating = Number(filters.minRating) || 0
  const kind = filters.kind || 'all'
  const range = DOUBAN_DECADE_RANGES[decade] || null
  return (rows || []).filter((row) => {
    if (!row) return false
    if (kind !== 'all' && row.kind !== kind) return false
    if (range) {
      const year = Number(row.year)
      if (!Number.isInteger(year) || year < range[0] || year > range[1]) return false
    }
    if (minRating > 0 && !(Number.isFinite(row.rating) && row.rating >= minRating)) return false
    return true
  })
}

/**
 * Sort filtered Douban rows by rating, vote count or release year. Every
 * comparator puts unknown values last.
 *
 * @param {object[]} rows
 * @param {'default' | 'rating' | 'votes' | 'year'} [sort]
 * @returns {object[]}
 */
export function sortDoubanRows(rows, sort = 'default') {
  if (sort === 'default') return rows || []
  const metric = (row, field) => {
    const value = Number(row && row[field])
    return Number.isFinite(value) ? value : -1
  }
  return (rows || []).slice().sort((left, right) => {
    const a = metric(left, sort === 'votes' ? 'votes' : sort)
    const b = metric(right, sort === 'votes' ? 'votes' : sort)
    if (a !== b) return b - a
    const ar = metric(left, 'rating')
    const br = metric(right, 'rating')
    if (ar !== br) return br - ar
    return metric(right, 'votes') - metric(left, 'votes')
  })
}

/**
 * Read (or reuse) the unfiltered 200-row recommendation pool for a Douban
 * browse category. Filtered pages slice this pool instead of asking upstream
 * for a page number that would skip matching rows.
 *
 * @param {'popular' | 'movie' | 'tv'} category
 * @param {{ timeoutMs: number, userAgent?: string }} options
 * @returns {Promise<object[]>}
 */
async function readDoubanBrowsePool(category, { timeoutMs, userAgent }) {
  const hit = doubanBrowsePoolCache.get(category)
  if (hit && Date.now() - hit.at <= DOUBAN_BROWSE_POOL_TTL_MS) return hit.rows
  let rows
  if (category === 'popular') {
    const [movieRows, tvRows] = await Promise.all([
      fetchDoubanTrending('movie', { timeoutMs, userAgent, limit: DOUBAN_BROWSE_POOL_SIZE }),
      fetchDoubanTrending('tv', { timeoutMs, userAgent, limit: DOUBAN_BROWSE_POOL_SIZE }),
    ])
    rows = interleaveRows(movieRows, tvRows)
  } else {
    rows = await fetchDoubanTrending(category === 'tv' ? 'tv' : 'movie', {
      timeoutMs,
      userAgent,
      limit: DOUBAN_BROWSE_POOL_SIZE,
    })
  }
  // Do not cache an empty pool: a transient upstream failure would otherwise
  // pin the category to "no results" for the whole TTL.
  if (rows.length > 0) {
    if (doubanBrowsePoolCache.size >= DOUBAN_BROWSE_POOL_LIMIT) {
      const oldest = doubanBrowsePoolCache.keys().next().value
      if (oldest !== undefined) doubanBrowsePoolCache.delete(oldest)
    }
    doubanBrowsePoolCache.set(category, { at: Date.now(), rows })
  }
  return rows
}

/**
 * One page of Douban's channel browse categories. The default view keeps the
 * efficient upstream page size; a filtered or sorted view reads one 200-row
 * pool and pages it locally, so filters apply across pages rather than only to
 * the rows that happened to be on the current page.
 *
 * @param {object} options
 * @param {'popular' | 'movie' | 'tv'} options.category
 * @param {number} options.page 1-based page number
 * @param {number} options.pageSize rows per page
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @param {object} [options.filters]
 * @returns {Promise<{ items: object[], hasMore: boolean }>}
 */
export async function browseDouban({ category, page, pageSize, timeoutMs, userAgent, filters }) {
  const view = filters || DEFAULT_DOUBAN_BROWSE_FILTERS
  if (!hasDoubanBrowseFilters(view)) {
    if (category === 'popular') {
      const perType = Math.ceil(pageSize / 2)
      const pageStart = (page - 1) * perType
      const [movieRows, tvRows] = await Promise.all([
        fetchDoubanTrending('movie', { timeoutMs, userAgent, limit: perType, pageStart }),
        fetchDoubanTrending('tv', { timeoutMs, userAgent, limit: perType, pageStart }),
      ])
      return {
        items: interleaveRows(movieRows, tvRows),
        hasMore: movieRows.length >= perType || tvRows.length >= perType,
      }
    }
    const type = category === 'tv' ? 'tv' : 'movie'
    const pageStart = (page - 1) * pageSize
    const rows = await fetchDoubanTrending(type, { timeoutMs, userAgent, limit: pageSize, pageStart })
    return { items: rows, hasMore: rows.length >= pageSize }
  }
  const pool = await readDoubanBrowsePool(category, { timeoutMs, userAgent })
  return paginateRows(sortDoubanRows(filterDoubanRows(pool, view), view.sort), page, pageSize)
}
/**
 * Slice a full row list into one page.
 *
 * @param {object[]} rows
 * @param {number} page 1-based page number
 * @param {number} pageSize
 * @returns {{ items: object[], hasMore: boolean }}
 */
export function paginateRows(rows, page, pageSize) {
  const start = (page - 1) * pageSize
  const items = rows.slice(start, start + pageSize)
  return { items, hasMore: start + items.length < rows.length }
}
/**
 * Trending picks for Douban: two keyless `j/search_subjects` calls (movie and
 * TV, `tag=热门`, `page_limit=<maxResults>`), each row normalized with the
 * trending Douban normalizer, then interleaved movie[0], tv[0], movie[1],
 * tv[1], … and truncated to `maxResults`. One failing half still yields the
 * other half's rows.
 *
 * @param {object} options
 * @param {number} options.maxResults per-type page size and final row cap
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<object[]>} normalized interleaved rows, capped at `maxResults`
 */
export async function recommendDouban({ maxResults, timeoutMs, userAgent }) {
  const outcomes = await Promise.allSettled([
    fetchDoubanTrending('movie', { timeoutMs, userAgent, limit: maxResults }),
    fetchDoubanTrending('tv', { timeoutMs, userAgent, limit: maxResults }),
  ])
  const movieOutcome = outcomes[0]
  const tvOutcome = outcomes[1]
  if (movieOutcome.status === 'rejected' && tvOutcome.status === 'rejected') {
    const reason = movieOutcome.reason
    throw reason instanceof Error
      ? reason
      : new ProviderError(ERROR_UPSTREAM, 'Douban recommendation requests failed.')
  }
  const movies = movieOutcome.status === 'fulfilled' ? movieOutcome.value : []
  const tvs = tvOutcome.status === 'fulfilled' ? tvOutcome.value : []
  return interleaveTrendingRows(movies, tvs).slice(0, maxResults)
}
/**
 * @param {'movie' | 'tv'} type
 * @param {{ timeoutMs: number, userAgent?: string, limit: number, pageStart?: number }} options
 * @returns {Promise<object[]>} normalized rows in upstream order
 */
export async function fetchDoubanTrending(type, { timeoutMs, userAgent, limit, pageStart = 0 }) {
  // The mobile recommendation feed replaces the desktop `j/search_subjects`
  // feed here: it carries release years and vote counts, and its `start` /
  // `count` paging is exact.
  const isTv = type === 'tv'
  const baseUrl = isTv ? DOUBAN_TV_RECOMMEND_URL : DOUBAN_RECOMMEND_URL
  const referer = isTv ? DOUBAN_TV_RECOMMEND_REFERER : DOUBAN_RECOMMEND_REFERER
  const params = new URLSearchParams({
    refresh: '0',
    start: String(pageStart),
    count: String(limit),
    selected_categories: '{}',
    uncollect: 'false',
    sort: 'U',
  })
  const response = await fetch(`${baseUrl}?${params.toString()}`, {
    headers: {
      'user-agent': userAgent || DEFAULT_USER_AGENT,
      accept: 'application/json, text/plain, */*',
      referer,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    discardBody(response)
    throw new ProviderError(ERROR_UPSTREAM, `Douban responded with HTTP ${response.status}.`)
  }
  const payload = await readJson(response, 'Douban')
  const items = Array.isArray(payload && payload.items) ? payload.items : []
  return items
    .filter((item) => item && trimString(item.type) === type)
    .map((item) => normalizeDoubanRecommendItem(item, type))
    .filter(Boolean)
}
/**
 * Interleave movie[0], tv[0], movie[1], tv[1], … as the contract requires.
 *
 * @param {object[]} movies
 * @param {object[]} tvs
 * @returns {object[]}
 */
export function interleaveTrendingRows(movies, tvs) {
  const rows = []
  const length = Math.max(movies.length, tvs.length)
  for (let index = 0; index < length; index += 1) {
    if (index < movies.length) rows.push(movies[index])
    if (index < tvs.length) rows.push(tvs[index])
  }
  return rows
}
/**
 * @param {string} id
 * @returns {object | null}
 */
export function readDoubanDetailCache(id) {
  const hit = doubanDetailCache.get(id)
  if (!hit) return null
  if (Date.now() - hit.at > DOUBAN_DETAIL_CACHE_TTL_MS) {
    doubanDetailCache.delete(id)
    return null
  }
  return hit.detail
}
/**
 * @param {string} id
 * @param {object} detail
 */
export function writeDoubanDetailCache(id, detail) {
  if (doubanDetailCache.size >= DOUBAN_DETAIL_CACHE_LIMIT) doubanDetailCache.clear()
  doubanDetailCache.set(id, { at: Date.now(), detail })
}
/**
 * @param {string} id chart id
 * @returns {object | null}
 */
export function readDoubanChartMetaCache(id) {
  const hit = doubanChartMetaCache.get(id)
  if (!hit) return null
  if (Date.now() - hit.at > DOUBAN_CHART_META_CACHE_TTL_MS) {
    doubanChartMetaCache.delete(id)
    return null
  }
  return hit.meta
}
/**
 * @param {string} id chart id
 * @param {object} meta
 */
export function writeDoubanChartMetaCache(id, meta) {
  if (doubanChartMetaCache.size >= DOUBAN_CHART_META_CACHE_LIMIT) doubanChartMetaCache.clear()
  doubanChartMetaCache.set(id, { at: Date.now(), meta })
}
