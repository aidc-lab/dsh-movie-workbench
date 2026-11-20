/**
 * Upstream providers for the movies-workbench Host data layer.
 *
 * Each provider turns one upstream search into fully normalized result rows in
 * the shape documented in `README.md`. A provider throws a
 * {@link ProviderError} with a stable contract code for a meaningful failure;
 * the dispatcher in `host.js` maps every other rejection to `timeout` or
 * `upstream_error`, so one failing provider can never fail the whole response.
 *
 * Plain ESM, Node 24 globals only (`fetch`, `AbortSignal.timeout`, `URL`,
 * `URLSearchParams`), no dependencies, no console output.
 */

import { isIP } from 'node:net'

/** Browser-like User-Agent sent to every upstream (contract: normal browser-like UA). */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const TMDB_SEARCH_URL = 'https://api.themoviedb.org/3/search/multi'
const TMDB_TRENDING_URL = 'https://api.themoviedb.org/3/trending/all/week'
const TMDB_MOVIE_POPULAR_URL = 'https://api.themoviedb.org/3/movie/popular'
const TMDB_TV_POPULAR_URL = 'https://api.themoviedb.org/3/tv/popular'
/** Contract v1.2: read at most three 20-row trending pages for larger limits. */
const TMDB_TRENDING_MAX_PAGES = 3
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w342'
const TMDB_PAGE_BASE_URL = 'https://www.themoviedb.org'
const IMDB_SUGGEST_BASE_URL = 'https://v2.sg.media-imdb.com/suggestion/x'
const IMDB_TITLE_BASE_URL = 'https://www.imdb.com/title'
const DOUBAN_SUGGEST_URL = 'https://movie.douban.com/j/subject_suggest'
const DOUBAN_TRENDING_URL = 'https://movie.douban.com/j/search_subjects'
const DOUBAN_SUBJECT_BASE_URL = 'https://movie.douban.com/subject'
const DOUBAN_REFERER = 'https://movie.douban.com/'
/**
 * Douban's mobile subject-detail API. The suggestion/search endpoints carry no
 * synopsis, so the detail page loads it on demand from here. TV subjects answer
 * the `movie` path with a redirect to `tv`, which `fetch` follows.
 */
const DOUBAN_DETAIL_URL = 'https://m.douban.com/rexxar/api/v2/movie'
const DOUBAN_DETAIL_REFERER = 'https://m.douban.com/'
const DOUBAN_DETAIL_CACHE_TTL_MS = 30 * 60 * 1000
const DOUBAN_DETAIL_CACHE_LIMIT = 100
/** Douban subject detail, keyed by subject id; bounded by the limit above. */
const doubanDetailCache = new Map()

/** Image hosts allowed verbatim by the contract's poster proxy allowlist. */
const EXACT_IMAGE_HOSTS = new Set(['image.tmdb.org', 'm.media-amazon.com'])

/** Domain suffixes allowed for image hosts (any subdomain matches). */
const IMAGE_HOST_SUFFIXES = ['.doubanio.com', '.douban.com']

/** IMDb `qid` values kept as results; person/name-like entries are dropped. */
const IMDB_KEPT_QIDS = new Set(['movie', 'short', 'video', 'tvMovie', 'tvSeries', 'tvMiniSeries'])

/** TTL for the resolved IMDb recommendation list, cached in Host memory. */
const IMDB_TRENDING_CACHE_TTL_MS = 3 * 60 * 60 * 1000

/** Concurrent IMDb seed lookups; small enough to be polite, fast enough for a page load. */
const IMDB_TRENDING_CONCURRENCY = 4

/**
 * IMDb's browser GraphQL endpoint. It is keyless and answers advanced title
 * searches with an opaque page cursor, so channel browse pages can keep
 * scrolling past the curated seed lists (contract v1.7).
 */
const IMDB_GRAPHQL_URL = 'https://api.graphql.imdb.com/'
const IMDB_GRAPHQL_ORIGIN = 'https://www.imdb.com'
const IMDB_GRAPHQL_REFERER = 'https://www.imdb.com/'
const IMDB_GRAPHQL_CLIENT_NAME = 'imdb-web-next-localized'
/** IMDb title kinds per browse category; `featured` mixes movies and TV series. */
const IMDB_BROWSE_TITLE_TYPES = {
  featured: ['movie', 'tvSeries', 'tvMiniSeries'],
  movie: ['movie'],
  tv: ['tvSeries', 'tvMiniSeries'],
}
/** One advanced-title-search page ordered by popularity; `after` is a cursor. */
const IMDB_BROWSE_QUERY = `query MovieWorkbenchBrowse($first: Int!, $after: String, $titleTypes: [String!]) {
  advancedTitleSearch(first: $first, after: $after, sort: {sortBy: POPULARITY, sortOrder: ASC}, constraints: {titleTypeConstraint: {anyTitleTypeIds: $titleTypes}}) {
    edges {
      node {
        title {
          id
          titleText { text }
          originalTitleText { text }
          releaseYear { year }
          titleType { id }
          ratingsSummary { aggregateRating voteCount }
          primaryImage { url }
          runtime { seconds }
          plot { plotText { plainText } }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

/**
 * Curated, ordered IMDb recommendation seeds from the contract (v1.2: 30
 * entries, the original ten first). IMDb has no keyless popularity endpoint, so
 * each seed is resolved live through the suggestion API and normalized with the
 * regular IMDb normalizer.
 *
 * @type {ReadonlyArray<{ id: string, query: string }>}
 */
export const IMDB_TRENDING_SEEDS = Object.freeze([
  { id: 'tt1375666', query: 'Inception 2010' },
  { id: 'tt0816692', query: 'Interstellar 2014' },
  { id: 'tt0468569', query: 'The Dark Knight 2008' },
  { id: 'tt1160419', query: 'Dune 2021' },
  { id: 'tt15398776', query: 'Oppenheimer 2023' },
  { id: 'tt6751668', query: 'Parasite 2019' },
  { id: 'tt0245429', query: 'Spirited Away 2001' },
  { id: 'tt0111161', query: 'The Shawshank Redemption 1994' },
  { id: 'tt0068646', query: 'The Godfather 1972' },
  { id: 'tt0133093', query: 'The Matrix 1999' },
  { id: 'tt0110912', query: 'Pulp Fiction 1994' },
  { id: 'tt0109830', query: 'Forrest Gump 1994' },
  { id: 'tt0137523', query: 'Fight Club 1999' },
  { id: 'tt0120737', query: 'The Lord of the Rings: The Fellowship of the Ring 2001' },
  { id: 'tt0167260', query: 'The Lord of the Rings: The Return of the King 2003' },
  { id: 'tt4154796', query: 'Avengers: Endgame 2019' },
  { id: 'tt7286456', query: 'Joker 2019' },
  { id: 'tt1745960', query: 'Top Gun: Maverick 2022' },
  { id: 'tt2582802', query: 'Whiplash 2014' },
  { id: 'tt5013056', query: 'Dunkirk 2017' },
  { id: 'tt2267998', query: 'Gone Girl 2014' },
  { id: 'tt2015381', query: 'Guardians of the Galaxy 2014' },
  { id: 'tt1630029', query: 'Avatar: The Way of Water 2022' },
  { id: 'tt0325980', query: 'Pirates of the Caribbean: The Curse of the Black Pearl 2003' },
  { id: 'tt0114369', query: 'Se7en 1995' },
  { id: 'tt0172495', query: 'Gladiator 2000' },
  { id: 'tt0407887', query: 'The Departed 2006' },
  { id: 'tt0482571', query: 'The Prestige 2006' },
  { id: 'tt0361748', query: 'Inglourious Basterds 2009' },
  { id: 'tt0993846', query: 'The Wolf of Wall Street 2013' },
])

/**
 * Resolved IMDb seed rows keyed by category ('movie', 'tv'), cached in Host
 * memory (contract: 3 hours).
 *
 * @type {Map<string, { expiresAt: number, rows: object[] }>}
 */
const imdbSeedCaches = new Map()

/** Stable provider error codes from the contract. */
const ERROR_TMDB_KEY_MISSING = 'tmdb_key_missing'
const ERROR_TMDB_UNAUTHORIZED = 'tmdb_unauthorized'
const ERROR_UPSTREAM = 'upstream_error'

/**
 * Failure raised by a provider, carrying a stable contract error code.
 */
export class ProviderError extends Error {
  /**
   * @param {string} code stable contract code (`tmdb_key_missing`, `tmdb_unauthorized`, `upstream_error`, ...)
   * @param {string} message human-readable message
   */
  constructor(code, message) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
  }
}

/**
 * True when an upstream failure was caused by an abort / per-request timeout
 * (`AbortSignal.timeout` rejects fetch with a `TimeoutError` DOMException).
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTimeoutError(error) {
  const names = [error && error.name, error && error.cause && error.cause.name]
  return names.some((name) => name === 'TimeoutError' || name === 'AbortError')
}

/**
 * Classify a TMDB credential: a v4 bearer token starts with `eyJ`, anything
 * else is treated as a v3 API key.
 *
 * @param {unknown} raw
 * @returns {{ kind: 'bearer' | 'v3', value: string } | null}
 */
export function parseTmdbCredential(raw) {
  if (typeof raw !== 'string') return null
  // A pasted credential often carries quotes or the `Bearer` scheme; both
  // would otherwise travel upstream and produce a misleading 401.
  const unquoted = raw.trim().replace(/^['"]+|['"]+$/g, '').trim()
  const value = unquoted.replace(/^bearer\s+/i, '').trim()
  if (!value) return null
  return value.startsWith('eyJ') ? { kind: 'bearer', value } : { kind: 'v3', value }
}

/**
 * Resolve the Host-side TMDB credential: plugin config first, then
 * `process.env.TMDB_API_KEY`.
 *
 * @param {unknown} configured plugin config value (`tmdbApiKey`)
 * @returns {{ kind: 'bearer' | 'v3', value: string } | null}
 */
export function resolveTmdbCredential(configured) {
  const fromConfig = parseTmdbCredential(configured)
  if (fromConfig) return fromConfig
  const env = typeof process !== 'undefined' && process.env ? process.env.TMDB_API_KEY : ''
  return parseTmdbCredential(env)
}

/**
 * Check a candidate poster URL against the contract's image allowlist: `https:`
 * only, exact hosts `image.tmdb.org` / `m.media-amazon.com`, or a subdomain of
 * `doubanio.com` / `douban.com`; IP literals are rejected.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isAllowedImageUrl(raw) {
  if (typeof raw !== 'string') return false
  const value = raw.trim()
  if (!value || value.length > 4096) return false
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const hostname = parsed.hostname.toLowerCase()
  if (!hostname || isIpLiteral(hostname)) return false
  if (EXACT_IMAGE_HOSTS.has(hostname)) return true
  return IMAGE_HOST_SUFFIXES.some(
    (suffix) => hostname.length > suffix.length && hostname.endsWith(suffix),
  )
}

/**
 * True when the URL host belongs to Douban, which needs a Douban `Referer` for
 * images (a bare browser request gets HTTP 418).
 *
 * @param {unknown} hostname
 * @returns {boolean}
 */
export function isDoubanHost(hostname) {
  const host = typeof hostname === 'string' ? hostname.toLowerCase() : ''
  return (
    host === 'douban.com' ||
    host === 'doubanio.com' ||
    host.endsWith('.douban.com') ||
    host.endsWith('.doubanio.com')
  )
}

/**
 * Normalize one TMDB `/search/multi` row.
 *
 * @param {unknown} item
 * @returns {object | null} contract result row, or `null` for `person` / malformed rows
 */
export function normalizeTmdbItem(item) {
  if (!item || typeof item !== 'object') return null
  const mediaType = item.media_type
  if (mediaType !== 'movie' && mediaType !== 'tv') return null
  const id = toId(item.id)
  if (!id) return null
  const isTv = mediaType === 'tv'
  const title =
    trimString(item.title) ||
    trimString(item.name) ||
    trimString(isTv ? item.original_name : item.original_title)
  const originalTitle =
    trimString(isTv ? item.original_name : item.original_title) ||
    trimString(item.name) ||
    title
  const posterPath = trimString(item.poster_path)
  const poster = posterPath
    ? toPoster(
        TMDB_IMAGE_BASE_URL + (posterPath.startsWith('/') ? posterPath : `/${posterPath}`),
      )
    : null
  return createResult('tmdb', {
    id,
    title,
    originalTitle: originalTitle || title,
    year: toYear(isTv ? item.first_air_date : item.release_date),
    kind: isTv ? 'tv' : 'movie',
    rating: toRating(item.vote_average),
    votes: toVotes(item.vote_count),
    overview: asString(item.overview),
    poster,
    url: `${TMDB_PAGE_BASE_URL}/${isTv ? 'tv' : 'movie'}/${encodeURIComponent(id)}`,
  })
}

/**
 * Normalize one TMDB browse row for the /browse route. The popular endpoints
 * (`/movie/popular`, `/tv/popular`) omit `media_type`, so the category fills it
 * in; trending rows already carry it.
 *
 * @param {unknown} item
 * @param {'trending' | 'movie' | 'tv'} category
 * @returns {object | null} contract result row, or `null` for dropped rows
 */
export function normalizeTmdbBrowseItem(item, category) {
  if (category !== 'movie' && category !== 'tv') return normalizeTmdbItem(item)
  if (!item || typeof item !== 'object' || item.media_type) return normalizeTmdbItem(item)
  return normalizeTmdbItem({ ...item, media_type: category })
}

/**
 * Normalize one IMDb suggestion row.
 *
 * @param {unknown} item
 * @returns {object | null} contract result row, or `null` for dropped rows
 */
export function normalizeImdbItem(item) {
  if (!item || typeof item !== 'object') return null
  const qid = trimString(item.qid)
  if (!IMDB_KEPT_QIDS.has(qid)) return null
  const id = trimString(item.id)
  if (!id) return null
  const title = trimString(item.l)
  const image = item.i && typeof item.i === 'object' ? trimString(item.i.imageUrl) : ''
  return createResult('imdb', {
    id,
    title,
    originalTitle: title,
    year: toYear(item.y) ?? toYear(item.tl),
    kind: imdbKind(qid),
    rating: null,
    votes: null,
    overview: asString(item.s),
    poster: image ? toPoster(imdbThumbnail(image)) : null,
    url: `${IMDB_TITLE_BASE_URL}/${encodeURIComponent(id)}/`,
  })
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
 * Search TMDB multi (movies and TV). Missing credential never calls upstream.
 *
 * @param {object} options
 * @param {string} options.query
 * @param {string} options.lang TMDB `language` value
 * @param {{ kind: 'bearer' | 'v3', value: string } | null} options.credential
 * @param {number} options.maxResults
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<object[]>} normalized rows in upstream order, capped at `maxResults`
 */
export async function searchTmdb({ query, lang, credential, maxResults, timeoutMs, userAgent }) {
  if (!credential) {
    throw new ProviderError(ERROR_TMDB_KEY_MISSING, 'No TMDB API key is configured.')
  }
  const params = new URLSearchParams({
    query,
    language: lang,
    include_adult: 'false',
    page: '1',
  })
  const headers = {
    'user-agent': userAgent || DEFAULT_USER_AGENT,
    accept: 'application/json',
  }
  if (credential.kind === 'bearer') headers.authorization = `Bearer ${credential.value}`
  else params.set('api_key', credential.value)
  const payload = await requestTmdbJson(
    `${TMDB_SEARCH_URL}?${params.toString()}`,
    headers,
    timeoutMs,
  )
  const rows = Array.isArray(payload && payload.results) ? payload.results : []
  return rows.map(normalizeTmdbItem).filter(Boolean).slice(0, maxResults)
}

/**
 * Search IMDb's keyless suggestion API.
 *
 * @param {object} options
 * @param {string} options.query
 * @param {number} options.maxResults
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<object[]>} normalized rows in upstream order, capped at `maxResults`
 */
export async function searchImdb({ query, maxResults, timeoutMs, userAgent }) {
  const url = `${IMDB_SUGGEST_BASE_URL}/${encodeURIComponent(query)}.json`
  const response = await fetch(url, {
    headers: {
      'user-agent': userAgent || DEFAULT_USER_AGENT,
      accept: 'application/json',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    discardBody(response)
    throw new ProviderError(ERROR_UPSTREAM, `IMDb responded with HTTP ${response.status}.`)
  }
  const payload = await readJson(response, 'IMDb')
  const rows = Array.isArray(payload && payload.d) ? payload.d : []
  return rows.map(normalizeImdbItem).filter(Boolean).slice(0, maxResults)
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

/* ------------------------------------------------------------------ */
/* Subject detail (synopsis enrichment)                                */
/* ------------------------------------------------------------------ */

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
function normalizeDoubanDetail(payload, fallbackId) {
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
  }
}

/**
 * @param {unknown} value
 * @returns {string[]} trimmed, non-empty string list
 */
function toStringList(value) {
  if (!Array.isArray(value)) return []
  return value.map(trimString).filter(Boolean)
}

/* ------------------------------------------------------------------ */
/* Recommendations (idle page, contract v1.1)                          */
/* ------------------------------------------------------------------ */

/**
 * Trending movies/TV from TMDB's all/week chart. A missing credential never
 * calls upstream. For larger `maxResults` the chart is paged through (page 1…
 * N, 20 rows each, filtered to movie/tv) until `maxResults` rows are collected
 * or the contract's three-page cap is reached; a later page that fails keeps the
 * rows already collected without reporting an error.
 *
 * @param {object} options
 * @param {string} options.lang TMDB `language` value
 * @param {{ kind: 'bearer' | 'v3', value: string } | null} options.credential
 * @param {number} options.maxResults rows to collect and cap
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<object[]>} normalized rows in upstream order, capped at `maxResults`
 */
export async function recommendTmdb({ lang, credential, maxResults, timeoutMs, userAgent }) {
  if (!credential) {
    throw new ProviderError(ERROR_TMDB_KEY_MISSING, 'No TMDB API key is configured.')
  }
  const headers = {
    'user-agent': userAgent || DEFAULT_USER_AGENT,
    accept: 'application/json',
  }
  const rows = []
  for (let page = 1; page <= TMDB_TRENDING_MAX_PAGES && rows.length < maxResults; page += 1) {
    const params = new URLSearchParams({ language: lang, page: String(page) })
    if (credential.kind === 'bearer') headers.authorization = `Bearer ${credential.value}`
    else params.set('api_key', credential.value)
    let results
    try {
      const payload = await requestTmdbJson(
        `${TMDB_TRENDING_URL}?${params.toString()}`,
        headers,
        timeoutMs,
      )
      results = Array.isArray(payload && payload.results) ? payload.results : []
    } catch (error) {
      // Page 1 (or a set with nothing collected yet) is the provider failure;
      // a later page only means the provider cannot fill the requested limit.
      if (page === 1 || rows.length === 0) throw error
      break
    }
    if (results.length === 0) break
    for (const item of results) {
      const row = normalizeTmdbItem(item)
      if (row) rows.push(row)
      if (rows.length >= maxResults) break
    }
  }
  return rows.slice(0, maxResults)
}

/**
 * Trending picks for IMDb: the contract's full curated seed list (30 entries in
 * v1.2) is resolved live through the suggestion API (IMDb has no keyless
 * popularity endpoint), with a small concurrency limit and the seeds' order
 * preserved. The resolved full list is cached in Host memory for three hours so
 * a page load does not hit IMDb again, and `maxResults` (the request `limit`)
 * only slices that cached list. Only a total failure is reported as
 * `upstream_error`; a list shorter than `maxResults` is not an error.
 *
 * @param {object} options
 * @param {number} options.maxResults rows to return (full cache is still resolved)
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<object[]>} normalized rows in seed order, capped at `maxResults`
 */
export async function recommendImdb({ maxResults, timeoutMs, userAgent }) {
  const rows = await resolveImdbSeeds(IMDB_TRENDING_SEEDS, 'movie', { timeoutMs, userAgent })
  return rows.slice(0, maxResults)
}

/** Interleave two row lists (A[0], B[0], A[1], B[1], …), skipping exhausted sides. */
function interleaveRows(first, second) {
  const merged = []
  const max = Math.max(first.length, second.length)
  for (let index = 0; index < max; index += 1) {
    if (index < first.length) merged.push(first[index])
    if (index < second.length) merged.push(second[index])
  }
  return merged
}

/**
 * One page of an IMDb browse category (contract v1.7). IMDb has no keyless
 * listing endpoint, but its browser GraphQL `advancedTitleSearch` returns
 * popularity-ordered pages with a cursor, so `movie` and `tv` keep paging for
 * as long as the endpoint allows instead of stopping at the curated seeds.
 * `featured` interleaves a movie page and a TV page from one paired cursor.
 *
 * @param {object} options
 * @param {'movie' | 'tv' | 'featured'} options.category
 * @param {number} options.pageSize rows per page
 * @param {string} [options.cursor] opaque cursor returned by the previous page
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<{ items: object[], hasMore: boolean, next: string | null }>}
 */
export async function browseImdb({ category, pageSize, cursor, timeoutMs, userAgent }) {
  const state = decodeImdbCursor(cursor) || {}
  const result = await requestImdbBrowsePage({ category, first: pageSize, after: state.c, timeoutMs, userAgent })
  const next = result.hasMore ? encodeImdbCursor({ c: result.endCursor }) : null
  return { items: result.items, hasMore: Boolean(next), next }
}

/**
 * Fetch and normalize one IMDb GraphQL title-search page.
 *
 * @param {object} options
 * @param {'movie' | 'tv'} options.category
 * @param {number} options.first rows to request
 * @param {string} [options.after] cursor from the previous page
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<{ items: object[], hasMore: boolean, endCursor: string }>}
 */
async function requestImdbBrowsePage({ category, first, after, timeoutMs, userAgent }) {
  const titleTypes = IMDB_BROWSE_TITLE_TYPES[category]
  if (!titleTypes) throw new ProviderError(ERROR_UPSTREAM, 'Unsupported IMDb browse category.')

  let response
  try {
    response = await fetch(IMDB_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'user-agent': userAgent || DEFAULT_USER_AGENT,
        accept: 'application/json',
        'content-type': 'application/json',
        origin: IMDB_GRAPHQL_ORIGIN,
        referer: IMDB_GRAPHQL_REFERER,
        'x-imdb-client-name': IMDB_GRAPHQL_CLIENT_NAME,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        query: IMDB_BROWSE_QUERY,
        variables: { first, after: after || null, titleTypes },
      }),
    })
  } catch (error) {
    if (isTimeoutError(error)) throw error
    throw new ProviderError(ERROR_UPSTREAM, 'IMDb browse request failed.')
  }
  if (!response.ok) {
    await discardBody(response)
    throw new ProviderError(ERROR_UPSTREAM, `IMDb responded with HTTP ${response.status}.`)
  }

  const payload = await readJson(response, 'IMDb')
  if (!payload || typeof payload !== 'object' || (Array.isArray(payload.errors) && payload.errors.length > 0)) {
    throw new ProviderError(ERROR_UPSTREAM, 'IMDb returned an unexpected response payload.')
  }
  const search = payload.data && typeof payload.data === 'object' ? payload.data.advancedTitleSearch : null
  const edges = search && Array.isArray(search.edges) ? search.edges : []
  const items = []
  for (const edge of edges) {
    const normalized = normalizeImdbGraphqlTitle(edge && edge.node ? edge.node.title : null)
    if (normalized) items.push(normalized)
  }
  const info = search && search.pageInfo && typeof search.pageInfo === 'object' ? search.pageInfo : {}
  return {
    items,
    hasMore: Boolean(info.hasNextPage),
    endCursor: trimString(info.endCursor),
  }
}

/**
 * Normalize one IMDb GraphQL `title` node into a contract result row.
 *
 * @param {unknown} value
 * @returns {object | null}
 */
function normalizeImdbGraphqlTitle(value) {
  if (!value || typeof value !== 'object') return null
  const id = trimString(value.id)
  if (!/^tt\d{1,12}$/.test(id)) return null
  const typeId = trimString(value.titleType && value.titleType.id)
  if (!IMDB_KEPT_QIDS.has(typeId)) return null
  const title = trimString(value.titleText && value.titleText.text)
  if (!title) return null
  const ratings = value.ratingsSummary && typeof value.ratingsSummary === 'object' ? value.ratingsSummary : {}
  const image = value.primaryImage && typeof value.primaryImage === 'object' ? trimString(value.primaryImage.url) : ''
  const plot =
    value.plot && value.plot.plotText && typeof value.plot.plotText === 'object'
      ? trimString(value.plot.plotText.plainText)
      : ''
  return createResult('imdb', {
    id,
    title,
    originalTitle: trimString(value.originalTitleText && value.originalTitleText.text) || title,
    year: toYear(value.releaseYear && value.releaseYear.year),
    kind: typeId.indexOf('tv') === 0 ? 'tv' : 'movie',
    rating: typeof ratings.aggregateRating === 'number' ? ratings.aggregateRating : null,
    votes: Number.isInteger(ratings.voteCount) ? ratings.voteCount : null,
    overview: plot,
    poster: image ? toPoster(imdbThumbnail(image)) : null,
    url: `${IMDB_TITLE_BASE_URL}/${encodeURIComponent(id)}/`,
  })
}

/**
 * Pack an IMDb GraphQL page cursor into an opaque URL-safe token.
 *
 * @param {{ c?: string | undefined }} value
 * @returns {string | null}
 */
function encodeImdbCursor(value) {
  const cursor = trimString(value && value.c)
  if (!cursor) return null
  return Buffer.from(JSON.stringify({ c: cursor }), 'utf8').toString('base64url')
}

/**
 * Unpack an opaque IMDb browse cursor; malformed input means "first page".
 *
 * @param {unknown} value
 * @returns {{ c?: string } | null}
 */
function decodeImdbCursor(value) {
  const raw = trimString(value)
  if (!raw || raw.length > 4096) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const cursor = trimString(parsed.c)
    return cursor ? { c: cursor } : null
  } catch (error) {
    return null
  }
}

/**
 * One page of TMDB's channel browse categories (contract v1.6): `trending`
 * (`/trending/all/week`), `movie` (`/movie/popular`) and `tv` (`/tv/popular`).
 * TMDB pages carry 20 rows; `total_pages` drives `hasMore`.
 *
 * @param {object} options
 * @param {'trending' | 'movie' | 'tv'} options.category
 * @param {number} options.page 1-based page number
 * @param {string} options.lang TMDB `language` value
 * @param {{ kind: 'bearer' | 'v3', value: string } | null} options.credential
 * @param {number} options.pageSize rows per page
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<{ items: object[], hasMore: boolean }>}
 */
export async function browseTmdb({
  category,
  page,
  lang,
  credential,
  pageSize,
  timeoutMs,
  userAgent,
}) {
  if (!credential) {
    throw new ProviderError(ERROR_TMDB_KEY_MISSING, 'No TMDB API key is configured.')
  }
  const base =
    category === 'movie'
      ? TMDB_MOVIE_POPULAR_URL
      : category === 'tv'
        ? TMDB_TV_POPULAR_URL
        : TMDB_TRENDING_URL
  const headers = {
    'user-agent': userAgent || DEFAULT_USER_AGENT,
    accept: 'application/json',
  }
  const params = new URLSearchParams({ language: lang, page: String(page) })
  if (credential.kind === 'bearer') headers.authorization = `Bearer ${credential.value}`
  else params.set('api_key', credential.value)
  const payload = await requestTmdbJson(`${base}?${params.toString()}`, headers, timeoutMs)
  const results = Array.isArray(payload && payload.results) ? payload.results : []
  const items = results
    .map((item) => normalizeTmdbBrowseItem(item, category))
    .filter(Boolean)
    .slice(0, pageSize)
  const totalPages = Number.isFinite(payload && payload.total_pages)
    ? Math.floor(payload.total_pages)
    : page
  return { items, hasMore: results.length > 0 && page < totalPages }
}

/**
 * One page of Douban's channel browse categories (contract v1.6): `movie` or
 * `tv` hot titles from `j/search_subjects` with `tag=热门`. Douban does not
 * report a total, so a full page means there may be more.
 *
 * @param {object} options
 * @param {'movie' | 'tv'} options.category
 * @param {number} options.page 1-based page number
 * @param {number} options.pageSize rows per page
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<{ items: object[], hasMore: boolean }>}
 */
export async function browseDouban({ category, page, pageSize, timeoutMs, userAgent }) {
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

/**
 * Resolve a curated IMDb seed list through the suggestion API once and cache
 * the full row list in Host memory for three hours.
 *
 * @param {ReadonlyArray<{ id: string, query: string }>} seeds
 * @param {string} cacheKey
 * @param {{ timeoutMs: number, userAgent?: string }} options
 * @returns {Promise<object[]>}
 */
async function resolveImdbSeeds(seeds, cacheKey, { timeoutMs, userAgent }) {
  const cached = readImdbSeedCache(cacheKey)
  if (cached) return cached

  const resolved = new Array(seeds.length).fill(null)
  let cursor = 0
  const workerCount = Math.min(IMDB_TRENDING_CONCURRENCY, seeds.length)
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= seeds.length) return
      try {
        resolved[index] = await resolveImdbSeed(seeds[index], { timeoutMs, userAgent })
      } catch {
        // One seed that times out or returns a bad payload must not sink the
        // whole list.
        resolved[index] = null
      }
    }
  })
  await Promise.all(workers)

  const rows = resolved.filter(Boolean)
  if (rows.length === 0) {
    throw new ProviderError(ERROR_UPSTREAM, 'IMDb recommendation lookups all failed.')
  }
  imdbSeedCaches.set(cacheKey, { expiresAt: Date.now() + IMDB_TRENDING_CACHE_TTL_MS, rows })
  return rows
}

/**
 * Slice a full row list into one page.
 *
 * @param {object[]} rows
 * @param {number} page 1-based page number
 * @param {number} pageSize
 * @returns {{ items: object[], hasMore: boolean }}
 */
function paginateRows(rows, page, pageSize) {
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

/* ------------------------------------------------------------------ */
/* Internal helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Fetch a TMDB JSON payload, mapping 401 and other non-2xx statuses to the
 * contract's stable codes. Credential handling is applied by the caller.
 *
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
async function requestTmdbJson(url, headers, timeoutMs) {
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (response.status === 401) {
    discardBody(response)
    throw new ProviderError(ERROR_TMDB_UNAUTHORIZED, 'TMDB rejected the API credential (HTTP 401).')
  }
  if (!response.ok) {
    discardBody(response)
    throw new ProviderError(ERROR_UPSTREAM, `TMDB responded with HTTP ${response.status}.`)
  }
  return readJson(response, 'TMDB')
}

/**
 * Resolve one curated IMDb seed to a normalized row: prefer the suggestion whose
 * `id` matches the seed, otherwise the first row with a kept `qid`.
 *
 * @param {{ id: string, query: string }} seed
 * @param {{ timeoutMs: number, userAgent?: string }} options
 * @returns {Promise<object | null>} normalized row, or `null` when the seed does not resolve
 */
async function resolveImdbSeed(seed, { timeoutMs, userAgent }) {
  const url = `${IMDB_SUGGEST_BASE_URL}/${encodeURIComponent(seed.query)}.json`
  const response = await fetch(url, {
    headers: {
      'user-agent': userAgent || DEFAULT_USER_AGENT,
      accept: 'application/json',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    discardBody(response)
    return null
  }
  const payload = await readJson(response, 'IMDb')
  const rows = Array.isArray(payload && payload.d) ? payload.d : []
  const exact = rows.find((row) => row && row.id === seed.id)
  const candidate =
    exact || rows.find((row) => row && IMDB_KEPT_QIDS.has(trimString(row.qid)))
  return candidate ? normalizeImdbItem(candidate) : null
}

/**
 * @param {string} cacheKey
 * @returns {object[] | null} cached normalized IMDb rows, or null when absent/expired
 */
function readImdbSeedCache(cacheKey) {
  const cached = imdbSeedCaches.get(cacheKey)
  if (!cached) return null
  if (Date.now() >= cached.expiresAt) {
    imdbSeedCaches.delete(cacheKey)
    return null
  }
  return cached.rows
}

/**
 * @param {'movie' | 'tv'} type
 * @param {{ timeoutMs: number, userAgent?: string, limit: number, pageStart?: number }} options
 * @returns {Promise<object[]>} normalized rows in upstream order
 */
async function fetchDoubanTrending(type, { timeoutMs, userAgent, limit, pageStart = 0 }) {
  const params = new URLSearchParams({
    type,
    tag: '热门',
    page_limit: String(limit),
    page_start: String(pageStart),
  })
  const response = await fetch(`${DOUBAN_TRENDING_URL}?${params.toString()}`, {
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
  const subjects = Array.isArray(payload && payload.subjects) ? payload.subjects : []
  return subjects
    .map((item) => normalizeDoubanTrendingItem(item, type))
    .filter(Boolean)
}

/**
 * Interleave movie[0], tv[0], movie[1], tv[1], … as the contract requires.
 *
 * @param {object[]} movies
 * @param {object[]} tvs
 * @returns {object[]}
 */
function interleaveTrendingRows(movies, tvs) {
  const rows = []
  const length = Math.max(movies.length, tvs.length)
  for (let index = 0; index < length; index += 1) {
    if (index < movies.length) rows.push(movies[index])
    if (index < tvs.length) rows.push(tvs[index])
  }
  return rows
}

/**
 * Ask IMDb's image host for a small poster variant instead of the full still:
 * `i.imageUrl` is commonly 2-4 MiB while the `QL75_UX164` variant is ~12 KiB.
 * A URL shape this does not recognize is returned unchanged.
 *
 * @param {string} url
 * @returns {string}
 */
function imdbThumbnail(url) {
  return url.replace(/_V1_\.(jpg|jpeg|png)$/i, '_V1_QL75_UX164_.$1')
}

/**
 * Build a contract result row with every field present.
 *
 * @param {string} source
 * @param {object} values
 * @returns {object}
 */
function createResult(source, values) {
  return {
    source,
    id: values.id,
    title: values.title,
    originalTitle: values.originalTitle,
    year: Number.isInteger(values.year) ? values.year : null,
    kind: values.kind,
    rating: typeof values.rating === 'number' ? values.rating : null,
    votes: Number.isInteger(values.votes) ? values.votes : null,
    overview: typeof values.overview === 'string' ? values.overview : '',
    poster: typeof values.poster === 'string' ? values.poster : null,
    url: values.url,
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimString(value) {
  return asString(value).trim()
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value))
  if (typeof value === 'string') return value.trim()
  return ''
}

/**
 * @param {unknown} value
 * @returns {number | null} four-digit year or null
 */
function toYear(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1000 && value <= 9999 ? value : null
  }
  if (typeof value === 'string') {
    const match = value.match(/\d{4}/)
    if (!match) return null
    const year = Number(match[0])
    return year >= 1000 && year <= 9999 ? year : null
  }
  return null
}

/**
 * @param {unknown} value
 * @returns {number | null} rating rounded to one decimal, 0–10, or null
 */
function toRating(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.min(10, Math.round(number * 10) / 10)
}

/**
 * @param {unknown} value
 * @returns {number | null} non-negative integer vote count or null
 */
function toVotes(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  return Math.trunc(number)
}

/**
 * @param {unknown} value
 * @returns {string | null} allowed absolute https poster URL or null
 */
function toPoster(value) {
  const raw = trimString(value)
  return isAllowedImageUrl(raw) ? raw : null
}

/**
 * Strip query string / fragment from a provider page URL.
 *
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function toPageUrl(value, fallback) {
  const raw = trimString(value)
  if (!raw) return fallback
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return fallback
  }
}

/**
 * @param {string} raw
 * @returns {string}
 */
function subjectIdFromUrl(raw) {
  const match = raw.match(/\/subject\/(\d+)/)
  return match ? match[1] : ''
}

/**
 * Map an IMDb `qid` to a contract `kind`.
 *
 * @param {string} qid
 * @returns {'movie' | 'tv' | 'other'}
 */
function imdbKind(qid) {
  if (qid === 'tvMovie' || qid === 'tvSeries' || qid === 'tvMiniSeries') return 'tv'
  if (qid === 'movie' || qid === 'short' || qid === 'video') return 'movie'
  return 'other'
}

/**
 * @param {unknown} hostname
 * @returns {boolean}
 */
function isIpLiteral(hostname) {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return isIP(bare) !== 0
}

/**
 * Read a JSON body; an abort/timeout during the read stays a timeout so the
 * dispatcher can classify it, while a malformed body becomes `upstream_error`.
 *
 * @param {Response} response
 * @param {string} label provider label for messages
 * @returns {Promise<unknown>}
 */
/* ------------------------------------------------------------------ */
/* BT torrent indexes                                                   */
/* ------------------------------------------------------------------ */

const BT4G_RSS_URL = 'https://bt4gprx.com/search'
const BITSEARCH_SEARCH_URL = 'https://bitsearch.to/search'
const BITSEARCH_TORRENT_BASE_URL = 'https://bitsearch.to/torrent'

const TORRENT_CACHE_TTL_MS = 10 * 60 * 1000
const TORRENT_CACHE_LIMIT = 80
const torrentCache = new Map()

const BT4G_KEPT_CATEGORY = /movie|tv|video|anime|archive/i
const BITSEARCH_KEPT_CATEGORY = /movie|tv|anime|video/i

/**
 * Search BT4G through its RSS endpoint (the HTML page is Cloudflare-challenged).
 * Rows carry no swarm counts; `seeders`/`leechers` are null.
 *
 * @param {object} options
 * @param {string} options.query
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<object[]>} normalized torrent rows
 */
export async function searchTorrentsBt4g({ query, timeoutMs, userAgent }) {
  const cached = readTorrentCache('bt4g', query)
  if (cached) return cached
  const url = `${BT4G_RSS_URL}?q=${encodeURIComponent(query)}&page=rss`
  const response = await fetch(url, {
    headers: {
      'user-agent': userAgent || DEFAULT_USER_AGENT,
      accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    discardBody(response)
    throw new ProviderError(ERROR_UPSTREAM, `BT4G responded with HTTP ${response.status}.`)
  }
  const rows = parseBt4gRss(await readText(response, 'BT4G'))
  writeTorrentCache('bt4g', query, rows)
  return rows
}

/**
 * Search BitSearch's result page. The site 301s to `bitsearch.eu`; redirects
 * are followed and the accessible result cards are parsed.
 *
 * @param {object} options
 * @param {string} options.query
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<object[]>} normalized torrent rows with swarm counts
 */
export async function searchTorrentsBitsearch({ query, timeoutMs, userAgent }) {
  const cached = readTorrentCache('bitsearch', query)
  if (cached) return cached
  const url = `${BITSEARCH_SEARCH_URL}?q=${encodeURIComponent(query)}`
  let lastError = null
  // BitSearch occasionally answers with a challenge shell (zero parsable cards)
  // or a transient 429/5xx; one short retry keeps the merged list complete.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const rows = await requestBitsearchPage(url, timeoutMs, userAgent)
      if (rows.length > 0) {
        writeTorrentCache('bitsearch', query, rows)
        return rows
      }
      lastError = new ProviderError(ERROR_UPSTREAM, 'BitSearch returned no parsable rows.')
    } catch (error) {
      lastError = error
      if (isTimeoutError(error)) throw error
    }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw lastError || new ProviderError(ERROR_UPSTREAM, 'BitSearch returned no rows.')
}

/**
 * Fetch one BitSearch result page and parse its cards.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @param {string} [userAgent]
 * @returns {Promise<object[]>}
 */
async function requestBitsearchPage(url, timeoutMs, userAgent) {
  const response = await fetch(url, {
    headers: {
      'user-agent': userAgent || DEFAULT_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    discardBody(response)
    throw new ProviderError(ERROR_UPSTREAM, `BitSearch responded with HTTP ${response.status}.`)
  }
  return parseBitsearchHtml(await readText(response, 'BitSearch'))
}

/**
 * Parse BT4G's search RSS into contract torrent rows.
 *
 * @param {string} xml
 * @returns {object[]}
 */
export function parseBt4gRss(xml) {
  const rows = []
  const items = String(xml || '').match(/<item>[\s\S]*?<\/item>/g) || []
  for (const item of items) {
    const magnet = decodeEntities(readXmlTag(item, 'link')).trim()
    const id = hashFromMagnet(magnet)
    if (!id) continue
    const description = readXmlCdata(item)
    const parts = description.split('<br>')
    const title = stripTags(parts[0] || readXmlTag(item, 'title'))
    if (!title) continue
    const category = stripTags(parts[2] || '') || null
    if (category && !BT4G_KEPT_CATEGORY.test(category)) continue
    const guid = decodeEntities(readXmlTag(item, 'guid')).trim()
    rows.push({
      source: 'bt4g',
      id,
      title,
      size: stripTags(parts[1] || '') || null,
      seeders: null,
      leechers: null,
      category,
      magnet,
      page: /^https?:\/\//i.test(guid) ? guid : null,
      publishedAt: isoDate(readXmlTag(item, 'pubDate')),
    })
  }
  return rows
}

/**
 * Parse BitSearch's result cards into contract torrent rows.
 *
 * @param {string} html
 * @returns {object[]}
 */
export function parseBitsearchHtml(html) {
  const text = String(html || '')
  const starts = Array.from(text.matchAll(/<div class="torrent-result-card/g), (match) => match.index)
  const rows = []
  starts.forEach((start, index) => {
    const block = text.slice(start, index + 1 < starts.length ? starts[index + 1] : text.length)
    const pageMatch = /href="\/torrent\/([0-9a-f]{24})"/i.exec(block)
    if (!pageMatch) return
    const siteId = pageMatch[1].toLowerCase()
    const titleMatch = /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    const title = titleMatch ? stripTags(titleMatch[1]) : ''
    if (!title) return
    const magnetMatch = /href="(magnet:[^"]+)"/i.exec(block)
    const magnet = magnetMatch ? decodeEntities(magnetMatch[1]).trim() : ''
    const id = hashFromMagnet(magnet)
    if (!id) return
    const categoryMatch = /<i class="[^"]*fa-(?:file|video|film|tv|music|game|book|software|archive)[^"]*"[^>]*><\/i>\s*<span[^>]*>([^<]+)<\/span>/i.exec(block)
    const category = categoryMatch ? stripTags(categoryMatch[1]) : null
    if (category && !BITSEARCH_KEPT_CATEGORY.test(category)) return
    const sizeMatch = /fa-download[^>]*><\/i>\s*<span[^>]*>([^<]+)<\/span>/i.exec(block)
    const dateMatch = /fa-calendar[^>]*><\/i>\s*<span[^>]*>([^<]+)<\/span>/i.exec(block)
    const seedersMatch = /font-medium[^>]*>\s*([\d,]+)\s*<\/span>\s*<span[^>]*>\s*seeders/i.exec(block)
    const leechersMatch = /font-medium[^>]*>\s*([\d,]+)\s*<\/span>\s*<span[^>]*>\s*leechers/i.exec(block)
    rows.push({
      source: 'bitsearch',
      id,
      title,
      size: sizeMatch ? stripTags(sizeMatch[1]) : null,
      seeders: seedersMatch ? toCount(seedersMatch[1]) : null,
      leechers: leechersMatch ? toCount(leechersMatch[1]) : null,
      category,
      magnet,
      page: `${BITSEARCH_TORRENT_BASE_URL}/${siteId}`,
      publishedAt: dateMatch ? isoDate(stripTags(dateMatch[1])) : null,
    })
  })
  return rows
}

/**
 * Read one XML tag's inner text from an RSS item.
 * @param {string} item
 * @param {string} tag
 * @returns {string}
 */
function readXmlTag(item, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(item)
  return match ? match[1].trim() : ''
}

/**
 * Read the CDATA payload of a feed item's `description`.
 * @param {string} item
 * @returns {string}
 */
function readXmlCdata(item) {
  const match = /<description>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/description>/.exec(item)
  return match ? match[1] : ''
}

/**
 * Decode the HTML entities the two index pages use.
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
  return String(value == null ? '' : value)
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => codePoint(hex, 16))
    .replace(/&#(\d+);/g, (match, dec) => codePoint(dec, 10))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (match, name) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    }[name] || match))
}

/**
 * @param {string} digits
 * @param {number} radix
 * @returns {string}
 */
function codePoint(digits, radix) {
  try {
    return String.fromCodePoint(parseInt(digits, radix))
  } catch {
    return ''
  }
}

/**
 * Strip tags and decode entities from one upstream fragment.
 * @param {string} value
 * @returns {string}
 */
function stripTags(value) {
  return decodeEntities(String(value == null ? '' : value).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Lowercased info hash from a magnet link, or ''.
 * @param {string} magnet
 * @returns {string}
 */
function hashFromMagnet(magnet) {
  const match = /^magnet:\?xt=urn:btih:([a-z0-9]+)/i.exec(String(magnet || '').trim())
  return match ? match[1].toLowerCase() : ''
}

/**
 * @param {string} raw
 * @returns {string | null} `YYYY-MM-DD` or null
 */
function isoDate(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  const time = Date.parse(text)
  if (!Number.isFinite(time)) return null
  return new Date(time).toISOString().slice(0, 10)
}

/**
 * @param {string} raw
 * @returns {number | null}
 */
function toCount(raw) {
  const value = Number(String(raw || '').replace(/,/g, ''))
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * @param {'bt4g' | 'bitsearch'} provider
 * @param {string} query
 * @returns {object[] | null}
 */
function readTorrentCache(provider, query) {
  const key = `${provider}|${String(query).toLowerCase()}`
  const hit = torrentCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > TORRENT_CACHE_TTL_MS) {
    torrentCache.delete(key)
    return null
  }
  return hit.rows
}

/**
 * @param {'bt4g' | 'bitsearch'} provider
 * @param {string} query
 * @param {object[]} rows
 */
function writeTorrentCache(provider, query, rows) {
  if (torrentCache.size >= TORRENT_CACHE_LIMIT) torrentCache.clear()
  torrentCache.set(`${provider}|${String(query).toLowerCase()}`, { at: Date.now(), rows })
}

/**
 * @param {string} id
 * @returns {object | null}
 */
function readDoubanDetailCache(id) {
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
function writeDoubanDetailCache(id, detail) {
  if (doubanDetailCache.size >= DOUBAN_DETAIL_CACHE_LIMIT) doubanDetailCache.clear()
  doubanDetailCache.set(id, { at: Date.now(), detail })
}

/**
 * Read a text body; an unreadable body is an upstream failure.
 * @param {Response} response
 * @param {string} label
 * @returns {Promise<string>}
 */
async function readText(response, label) {
  try {
    return await response.text()
  } catch (error) {
    if (isTimeoutError(error)) throw error
    throw new ProviderError(ERROR_UPSTREAM, `${label} returned an unreadable response.`)
  }
}

async function readJson(response, label) {
  try {
    return await response.json()
  } catch (error) {
    if (isTimeoutError(error)) throw error
    throw new ProviderError(ERROR_UPSTREAM, `${label} returned an invalid JSON response.`)
  }
}

/**
 * Drop an unread upstream body without letting its rejection escape.
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
    /* a broken body stream is already irrelevant */
  }
}
