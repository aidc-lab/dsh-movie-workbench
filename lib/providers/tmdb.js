import { DEFAULT_USER_AGENT, ERROR_TMDB_KEY_MISSING, ERROR_TMDB_UNAUTHORIZED, ERROR_UPSTREAM, ProviderError, asString, createResult, discardBody, readJson, toId, toPoster, toRating, toVotes, toYear, trimString } from './core.js'

export const TMDB_SEARCH_URL = 'https://api.themoviedb.org/3/search/multi'
export const TMDB_TRENDING_URL = 'https://api.themoviedb.org/3/trending/all/week'
export const TMDB_MOVIE_POPULAR_URL = 'https://api.themoviedb.org/3/movie/popular'
export const TMDB_TV_POPULAR_URL = 'https://api.themoviedb.org/3/tv/popular'
/** Contract v1.2: read at most three 20-row trending pages for larger limits. */
export const TMDB_TRENDING_MAX_PAGES = 3
export const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w342'
export const TMDB_MOVIE_DETAIL_URL = 'https://api.themoviedb.org/3/movie'
export const TMDB_COLLECTION_URL = 'https://api.themoviedb.org/3/collection'
export const TMDB_PAGE_BASE_URL = 'https://www.themoviedb.org'

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
 * Build TMDB request headers/params for a resolved credential.
 *
 * @param {{ kind: 'bearer' | 'v3', value: string } | null} credential
 * @param {Record<string, string>} headers
 * @param {URLSearchParams} params
 */
export function applyTmdbCredential(credential, headers, params) {
  if (!credential) {
    throw new ProviderError(ERROR_TMDB_KEY_MISSING, 'No TMDB API key is configured.')
  }
  if (credential.kind === 'bearer') headers.authorization = `Bearer ${credential.value}`
  else params.set('api_key', credential.value)
}
/**
 * Normalize TMDB `/movie/<id>` into the detail shape used by the detail page.
 * Exported for offline checks.
 *
 * @param {unknown} payload
 * @param {string} fallbackId
 * @returns {{ id: string, title: string, kind: 'movie', year: number | null, overview: string, collection: { id: string, name: string, poster: string | null } | null }}
 */
export function normalizeTmdbMovieDetail(payload, fallbackId) {
  if (!payload || typeof payload !== 'object') {
    throw new ProviderError(ERROR_UPSTREAM, 'TMDB returned an unexpected response payload.')
  }
  const id = toId(payload.id) || String(fallbackId)
  const title = trimString(payload.title) || trimString(payload.original_title) || id
  const rawCollection = payload.belongs_to_collection
  let collection = null
  if (rawCollection && typeof rawCollection === 'object') {
    const collectionId = toId(rawCollection.id)
    if (collectionId) {
      const posterPath = trimString(rawCollection.poster_path)
      collection = {
        id: collectionId,
        name: trimString(rawCollection.name) || collectionId,
        poster: posterPath
          ? toPoster(TMDB_IMAGE_BASE_URL + (posterPath.startsWith('/') ? posterPath : `/${posterPath}`))
          : null,
      }
    }
  }
  const genres = Array.isArray(payload.genres)
    ? payload.genres.map((genre) => trimString(genre && genre.name)).filter(Boolean)
    : []
  const regions = Array.isArray(payload.production_countries)
    ? payload.production_countries.map((country) => trimString(country && country.name)).filter(Boolean)
    : []
  const runtime = Number.isFinite(payload.runtime) && payload.runtime > 0 ? Math.round(payload.runtime) : null
  return {
    id,
    title,
    originalTitle: trimString(payload.original_title) || title,
    kind: 'movie',
    year: toYear(payload.release_date),
    overview: asString(payload.overview),
    rating: toRating(payload.vote_average),
    votes: toVotes(payload.vote_count),
    genres,
    region: regions.join(' / '),
    runtime,
    collection,
  }
}
/**
 * Normalize TMDB `/collection/<id>` into a collection view with its parts as
 * ordinary movie results. Exported for offline checks.
 *
 * @param {unknown} payload
 * @param {string} fallbackId
 * @returns {{ id: string, name: string, overview: string, cover: string | null, items: object[] }}
 */
export function normalizeTmdbCollection(payload, fallbackId) {
  if (!payload || typeof payload !== 'object') {
    throw new ProviderError(ERROR_UPSTREAM, 'TMDB returned an unexpected response payload.')
  }
  const id = toId(payload.id) || String(fallbackId)
  const posterPath = trimString(payload.poster_path)
  const parts = Array.isArray(payload.parts) ? payload.parts : []
  const items = parts
    .map((part) => normalizeTmdbBrowseItem(part, 'movie'))
    .filter(Boolean)
    .sort((left, right) => {
      const a = left.year === null || left.year === undefined ? Number.POSITIVE_INFINITY : left.year
      const b = right.year === null || right.year === undefined ? Number.POSITIVE_INFINITY : right.year
      if (a !== b) return a - b
      return String(left.title).localeCompare(String(right.title))
    })
  return {
    id,
    name: trimString(payload.name) || id,
    overview: asString(payload.overview),
    cover: posterPath
      ? toPoster(TMDB_IMAGE_BASE_URL + (posterPath.startsWith('/') ? posterPath : `/${posterPath}`))
      : null,
    items,
  }
}
/**
 * Load a TMDB movie's own detail (used for its `belongs_to_collection`).
 *
 * @param {{ id: string, lang: string, credential: object | null, timeoutMs: number, userAgent?: string }} options
 * @returns {Promise<object>} normalized detail
 */
export async function fetchTmdbMovieDetail({ id, lang, credential, timeoutMs, userAgent }) {
  const headers = { 'user-agent': userAgent || DEFAULT_USER_AGENT, accept: 'application/json' }
  const params = new URLSearchParams({ language: lang })
  applyTmdbCredential(credential, headers, params)
  const payload = await requestTmdbJson(
    `${TMDB_MOVIE_DETAIL_URL}/${encodeURIComponent(id)}?${params.toString()}`,
    headers,
    timeoutMs,
  )
  return normalizeTmdbMovieDetail(payload, id)
}
/**
 * Load a TMDB collection and all of its parts.
 *
 * @param {{ id: string, lang: string, credential: object | null, timeoutMs: number, userAgent?: string }} options
 * @returns {Promise<object>} normalized collection
 */
export async function fetchTmdbCollection({ id, lang, credential, timeoutMs, userAgent }) {
  const headers = { 'user-agent': userAgent || DEFAULT_USER_AGENT, accept: 'application/json' }
  const params = new URLSearchParams({ language: lang })
  applyTmdbCredential(credential, headers, params)
  const payload = await requestTmdbJson(
    `${TMDB_COLLECTION_URL}/${encodeURIComponent(id)}?${params.toString()}`,
    headers,
    timeoutMs,
  )
  return normalizeTmdbCollection(payload, id)
}
/**
 * Fetch a TMDB JSON payload, mapping 401 and other non-2xx statuses to the
 * contract's stable codes. Credential handling is applied by the caller.
 *
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
export async function requestTmdbJson(url, headers, timeoutMs) {
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
