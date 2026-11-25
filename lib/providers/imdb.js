import { DEFAULT_USER_AGENT, ERROR_UPSTREAM, ProviderError, asString, createResult, discardBody, imdbKind, imdbThumbnail, isTimeoutError, readJson, toPoster, toYear, trimString } from './core.js'

export const IMDB_SUGGEST_BASE_URL = 'https://v2.sg.media-imdb.com/suggestion/x'
export const IMDB_TITLE_BASE_URL = 'https://www.imdb.com/title'
export const IMDB_KEPT_QIDS = new Set(['movie', 'short', 'video', 'tvMovie', 'tvSeries', 'tvMiniSeries'])

/** TTL for the resolved IMDb recommendation list, cached in Host memory. */
export const IMDB_TRENDING_CACHE_TTL_MS = 3 * 60 * 60 * 1000

/** Concurrent IMDb seed lookups; small enough to be polite, fast enough for a page load. */
export const IMDB_TRENDING_CONCURRENCY = 4

/**
 * IMDb's browser GraphQL endpoint. It is keyless and answers advanced title
 * searches with an opaque page cursor, so channel browse pages can keep
 * scrolling past the curated seed lists (contract v1.7).
 */
export const IMDB_GRAPHQL_URL = 'https://api.graphql.imdb.com/'
export const IMDB_GRAPHQL_ORIGIN = 'https://www.imdb.com'
export const IMDB_GRAPHQL_REFERER = 'https://www.imdb.com/'
export const IMDB_GRAPHQL_CLIENT_NAME = 'imdb-web-next-localized'
/** IMDb title kinds per browse category; `featured` mixes movies and TV series. */
export const IMDB_BROWSE_TITLE_TYPES = {
  featured: ['movie', 'tvSeries', 'tvMiniSeries'],
  movie: ['movie'],
  tv: ['tvSeries', 'tvMiniSeries'],
}
/** One advanced-title-search page ordered by popularity; `after` is a cursor. */

/** IMDb connection categories that describe one franchise/series chain. */
export const IMDB_SERIES_RELATION_CATEGORIES = Object.freeze([
  'follows',
  'followed_by',
  'spin_off',
  'spin_off_from',
])

export const IMDB_SERIES_PAGE_SIZE = 250
export const IMDB_SERIES_MAX_PAGES = 5
export const IMDB_SERIES_QUERY = `query MovieWorkbenchSeries($id: ID!, $first: Int!, $after: ID) {
  title(id: $id) {
    id
    titleText { text }
    originalTitleText { text }
    releaseYear { year }
    titleType { id }
    ratingsSummary { aggregateRating voteCount }
    primaryImage { url }
    plot { plotText { plainText } }
    connections(first: $first, after: $after, filter: { categories: ${JSON.stringify(IMDB_SERIES_RELATION_CATEGORIES)} }) {
      total
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          category { id text }
          associatedTitle {
            id
            titleText { text }
            originalTitleText { text }
            releaseYear { year }
            titleType { id }
            ratingsSummary { aggregateRating voteCount }
            primaryImage { url }
            plot { plotText { plainText } }
          }
        }
      }
    }
  }
}`

export const IMDB_BROWSE_QUERY = `query MovieWorkbenchBrowse($first: Int!, $after: String, $titleTypes: [String!]) {
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
export const imdbSeedCaches = new Map()

/** Stable provider error codes from the contract. */

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
export async function requestImdbBrowsePage({ category, first, after, timeoutMs, userAgent }) {
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
export function normalizeImdbGraphqlTitle(value) {
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
export function encodeImdbCursor(value) {
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
export function decodeImdbCursor(value) {
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
 * One title's franchise chain from IMDb's title-connections graph (contract
 * v1.14): fetch every `follows` / `followed_by` / `spin_off` edge (the GraphQL
 * filter narrows the connection set server-side, so a popular title's hundreds
 * of "featured in" rows never travel), following the cursor up to a bounded
 * number of pages. The current title is included so the series page shows the
 * whole chain in release order.
 *
 * @param {object} options
 * @param {string} options.id IMDb title id (`tt…`)
 * @param {{ timeoutMs: number, userAgent?: string }} options
 * @returns {Promise<{ id: string, title: string, cover: string | null, items: object[], truncated: boolean }>}
 */
export async function fetchImdbSeries({ id, timeoutMs, userAgent }) {
  const titleId = trimString(id)
  if (!/^tt\d{1,12}$/.test(titleId)) {
    throw new ProviderError(ERROR_UPSTREAM, 'IMDb returned an unexpected response payload.')
  }
  const related = new Map()
  let self = null
  let after = null
  let truncated = false
  for (let page = 0; page < IMDB_SERIES_MAX_PAGES; page += 1) {
    const payload = await requestImdbSeriesPage({ id: titleId, first: IMDB_SERIES_PAGE_SIZE, after, timeoutMs, userAgent })
    const title = payload.title
    if (!self) {
      self = normalizeImdbGraphqlTitle(title)
      if (!self) {
        throw new ProviderError(ERROR_UPSTREAM, 'IMDb returned no title for that id.')
      }
    }
    const connection = title.connections
    const edges = connection && Array.isArray(connection.edges) ? connection.edges : []
    edges.forEach((edge) => {
      const node = edge && edge.node ? edge.node : null
      const associated = node && node.associatedTitle ? node.associatedTitle : null
      const item = normalizeImdbGraphqlTitle(associated)
      if (!item || related.has(item.id)) return
      related.set(item.id, item)
    })
    const pageInfo = connection && connection.pageInfo ? connection.pageInfo : null
    if (!pageInfo || pageInfo.hasNextPage !== true) break
    const nextCursor = trimString(pageInfo.endCursor)
    if (!nextCursor) break
    after = nextCursor
    if (page === IMDB_SERIES_MAX_PAGES - 1) truncated = true
  }
  const items = [self].concat(Array.from(related.values()))
  items.sort((left, right) => {
    const leftYear = Number.isInteger(left.year) ? left.year : 9999
    const rightYear = Number.isInteger(right.year) ? right.year : 9999
    if (leftYear !== rightYear) return leftYear - rightYear
    return String(left.title).localeCompare(String(right.title))
  })
  return {
    id: self.id,
    title: self.title,
    cover: self.poster || null,
    items,
    truncated,
  }
}
/**
 * POST one IMDb series page to the browser GraphQL endpoint.
 *
 * @param {object} options
 * @returns {Promise<any>}
 */
export async function requestImdbSeriesPage({ id, first, after, timeoutMs, userAgent }) {
  const response = await fetch(IMDB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': trimString(userAgent) || DEFAULT_USER_AGENT,
      origin: IMDB_GRAPHQL_ORIGIN,
      referer: IMDB_GRAPHQL_REFERER,
      'x-imdb-client-name': IMDB_GRAPHQL_CLIENT_NAME,
    },
    body: JSON.stringify({
      query: IMDB_SERIES_QUERY,
      variables: { id, first, after: after || null },
    }),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    await discardBody(response)
    throw new ProviderError(ERROR_UPSTREAM, `IMDb responded with HTTP ${response.status}.`)
  }
  const payload = await readJson(response, 'IMDb')
  if (payload && Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new ProviderError(ERROR_UPSTREAM, 'IMDb returned an unexpected response payload.')
  }
  if (!payload || typeof payload !== 'object' || !payload.data || typeof payload.data !== 'object') {
    throw new ProviderError(ERROR_UPSTREAM, 'IMDb returned an unexpected response payload.')
  }
  return payload.data
}
/**
 * Normalize one IMDb GraphQL `title` node into the shared detail shape used by
 * `GET /detail?source=imdb` (overview, rating, genres, origin countries and
 * runtime in minutes).
 *
 * @param {unknown} value
 * @returns {object}
 */
export function normalizeImdbDetail(value) {
  if (!value || typeof value !== 'object') {
    throw new ProviderError(ERROR_UPSTREAM, 'IMDb returned an unexpected response payload.')
  }
  const id = trimString(value.id)
  if (!/^tt\d{1,12}$/.test(id)) {
    throw new ProviderError(ERROR_UPSTREAM, 'IMDb returned an unexpected response payload.')
  }
  const title = trimString(value.titleText && value.titleText.text)
  if (!title) {
    throw new ProviderError(ERROR_UPSTREAM, 'IMDb returned no title for that id.')
  }
  const typeId = trimString(value.titleType && value.titleType.id)
  const ratings = value.ratingsSummary && typeof value.ratingsSummary === 'object' ? value.ratingsSummary : {}
  const genres = Array.isArray(value.genres && value.genres.genres)
    ? value.genres.genres.map((genre) => trimString(genre && genre.text)).filter(Boolean)
    : []
  const countries = Array.isArray(value.countriesOfOrigin && value.countriesOfOrigin.countries)
    ? value.countriesOfOrigin.countries.map((country) => trimString(country && country.text)).filter(Boolean)
    : []
  const seconds = value.runtime && Number.isFinite(value.runtime.seconds) ? value.runtime.seconds : null
  const plot =
    value.plot && value.plot.plotText && typeof value.plot.plotText === 'object'
      ? trimString(value.plot.plotText.plainText)
      : ''
  return {
    id,
    title,
    originalTitle: trimString(value.originalTitleText && value.originalTitleText.text) || title,
    kind: typeId.indexOf('tv') === 0 ? 'tv' : 'movie',
    year: toYear(value.releaseYear && value.releaseYear.year),
    overview: plot,
    rating: typeof ratings.aggregateRating === 'number' ? ratings.aggregateRating : null,
    votes: Number.isInteger(ratings.voteCount) ? ratings.voteCount : null,
    genres,
    region: countries.join(' / '),
    runtime: seconds ? Math.round(seconds / 60) : null,
  }
}
/**
 * Fetch one IMDb title's detail metadata (no API key: IMDb's browser GraphQL).
 *
 * @param {object} options
 * @param {string} options.id IMDb title id (`tt…`)
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<object>}
 */
export async function fetchImdbDetail({ id, timeoutMs, userAgent }) {
  const titleId = trimString(id)
  if (!/^tt\d{1,12}$/.test(titleId)) {
    throw new ProviderError(ERROR_UPSTREAM, 'IMDb returned an unexpected response payload.')
  }
  const response = await fetch(IMDB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': trimString(userAgent) || DEFAULT_USER_AGENT,
      origin: IMDB_GRAPHQL_ORIGIN,
      referer: IMDB_GRAPHQL_REFERER,
      'x-imdb-client-name': IMDB_GRAPHQL_CLIENT_NAME,
    },
    body: JSON.stringify({ query: IMDB_DETAIL_QUERY, variables: { id: titleId } }),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    await discardBody(response)
    throw new ProviderError(ERROR_UPSTREAM, `IMDb responded with HTTP ${response.status}.`)
  }
  const payload = await readJson(response, 'IMDb')
  if (payload && Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new ProviderError(ERROR_UPSTREAM, 'IMDb returned an unexpected response payload.')
  }
  if (!payload || typeof payload !== 'object' || !payload.data || typeof payload.data !== 'object') {
    throw new ProviderError(ERROR_UPSTREAM, 'IMDb returned an unexpected response payload.')
  }
  return normalizeImdbDetail(payload.data.title)
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
export async function resolveImdbSeeds(seeds, cacheKey, { timeoutMs, userAgent }) {
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
 * Resolve one curated IMDb seed to a normalized row: prefer the suggestion whose
 * `id` matches the seed, otherwise the first row with a kept `qid`.
 *
 * @param {{ id: string, query: string }} seed
 * @param {{ timeoutMs: number, userAgent?: string }} options
 * @returns {Promise<object | null>} normalized row, or `null` when the seed does not resolve
 */
export async function resolveImdbSeed(seed, { timeoutMs, userAgent }) {
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
export function readImdbSeedCache(cacheKey) {
  const cached = imdbSeedCaches.get(cacheKey)
  if (!cached) return null
  if (Date.now() >= cached.expiresAt) {
    imdbSeedCaches.delete(cacheKey)
    return null
  }
  return cached.rows
}

export const IMDB_DETAIL_QUERY = `query MovieWorkbenchDetail($id: ID!) {
  title(id: $id) {
    id
    titleText { text }
    originalTitleText { text }
    releaseYear { year }
    titleType { id }
    ratingsSummary { aggregateRating voteCount }
    plot { plotText { plainText } }
    genres { genres { id text } }
    countriesOfOrigin { countries { id text } }
    runtime { seconds }
  }
}`
