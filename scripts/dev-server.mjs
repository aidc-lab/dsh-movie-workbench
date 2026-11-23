#!/usr/bin/env node
/**
 * Dev-only harness for the dsh-movie-workbench Host half. NOT shipped.
 *
 * Boots a plain `node:http` server on an ephemeral port, mounts the real
 * `createHandler()` from `lib/host.js`, and exercises every route against the
 * live upstreams:
 *
 *   /status
 *   /search?q=Inception&source=imdb
 *   /search?q=<星际穿越>&source=douban
 *   /search?q=Inception&source=all            (expects tmdb_key_missing)
 *   /trending?source=douban|imdb|all          (v1.1 idle recommendations)
 *   /trending?...&limit=24|abc|0|99           (v1.2 "see all" limit)
 *   /browse?source=douban|imdb|tmdb&category=&page=&cursor=   (v1.7 channel tabs + paging)
 *   /charts?source=douban&kind=movie|tv          (v1.11 movie / TV chart lists)
 *   /chart?source=douban&id=&start=&count=     (v1.9 ranked chart titles)
 *   /detail?source=douban&id=<id>             (v1.4 synopsis enrichment)
 *   /detail?source=tmdb&id=<id>               (v1.13 TMDB collection lookup)
 *   /collection?source=tmdb&id=<id>           (v1.13 collection parts)
 *   /image?url=<Douban poster from the Douban search>   (expects 200 image/*)
 *   /image?url=<disallowed host>              (expects 400)
 *
 * plus the deterministic contract error envelopes and CORS behaviour. The
 * summary prints PASS/FAIL for every required check and exits non-zero when
 * one fails. Extra live probes (`INFO`) exercise the timeout / unauthorized /
 * upstream-error code paths without making the acceptance run network-flaky.
 *
 * Run with Node 24:  node scripts/dev-server.mjs
 */

import http from 'node:http'

import { createHandler } from '../lib/host.js'
import {
  DEFAULT_USER_AGENT,
  IMDB_TRENDING_SEEDS,
  normalizeTmdbBrowseItem,
  normalizeTmdbCollection,
  normalizeTmdbMovieDetail,
} from '../lib/providers.js'

// Make the missing-credential case deterministic in this dev harness only.
delete process.env.TMDB_API_KEY

const API = '/movie-workbench/api'
const RESULT_FIELDS = [
  'source',
  'id',
  'title',
  'originalTitle',
  'year',
  'kind',
  'rating',
  'votes',
  'overview',
  'poster',
  'url',
]
const RESULT_KINDS = ['movie', 'tv', 'short', 'other']

const checks = []
let failedChecks = 0

/**
 * Record one required check.
 * @param {string} name
 * @param {boolean} passed
 * @param {string} [detail]
 * @returns {boolean}
 */
function check(name, passed, detail = '') {
  const ok = Boolean(passed)
  if (!ok) failedChecks += 1
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

/**
 * Print one informational (network-dependent) probe; never affects the exit code.
 * @param {string} name
 * @param {string} detail
 */
function info(name, detail) {
  console.log(`INFO  ${name} — ${detail}`)
}

/**
 * @param {string} label
 * @param {unknown} value
 */
function printSample(label, value) {
  console.log(`\n${label}:\n${JSON.stringify(value, null, 2)}`)
}

/**
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler
 */
async function startServer(handler) {
  const server = http.createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

/**
 * @param {import('node:http').Server} server
 */
async function stopServer(server) {
  if (!server) return
  try {
    server.closeAllConnections()
  } catch {
    /* no active connections */
  }
  await new Promise((resolve) => server.close(() => resolve()))
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function getJson(url, init) {
  const response = await fetch(url, init)
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { response, body }
}

/**
 * Validate one normalized result row against the contract shape.
 * @param {unknown} item
 * @returns {boolean}
 */
function isNormalizedResult(item) {
  if (!item || typeof item !== 'object') return false
  if (!RESULT_FIELDS.every((field) => field in item)) return false
  return (
    typeof item.source === 'string' &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.title === 'string' &&
    typeof item.originalTitle === 'string' &&
    (item.year === null || Number.isInteger(item.year)) &&
    RESULT_KINDS.includes(item.kind) &&
    (item.rating === null ||
      (typeof item.rating === 'number' && item.rating >= 0 && item.rating <= 10)) &&
    (item.votes === null || Number.isInteger(item.votes)) &&
    typeof item.overview === 'string' &&
    (item.poster === null ||
      (typeof item.poster === 'string' && item.poster.startsWith('https://'))) &&
    typeof item.url === 'string' &&
    item.url.length > 0
  )
}

/**
 * Minimal `ServerResponse` stand-in for direct handler invocation tests.
 */
function createFakeResponse() {
  const state = { statusCode: 0, headers: {}, body: '' }
  return {
    state,
    response: {
      destroyed: false,
      writableEnded: false,
      headersSent: false,
      /**
       * @param {number} statusCode
       * @param {Record<string, string>} headers
       */
      writeHead(statusCode, headers) {
        state.statusCode = statusCode
        state.headers = { ...headers }
      },
      /** @param {string | Buffer} [chunk] */
      end(chunk) {
        state.body = chunk === undefined || chunk === null ? '' : chunk.toString()
      },
      destroy() {},
    },
  }
}

/**
 * Invoke the handler directly (no HTTP) to prove defensive paths.
 * @param {Function} handler
 * @param {object} request
 */
async function callHandlerDirect(handler, request) {
  const { state, response } = createFakeResponse()
  await handler(request, response)
  let parsed = null
  try {
    parsed = JSON.parse(state.body)
  } catch {
    parsed = null
  }
  return { statusCode: state.statusCode, headers: state.headers, body: parsed }
}

async function main() {
  const primaryHandler = createHandler({ maxResults: 10, requestTimeoutMs: 8000 })
  const { server: primaryServer, origin } = await startServer(primaryHandler)
  const api = `${origin}${API}`
  let timeoutInstance = null

  console.log(`dsh-movie-workbench dev harness — listening on ${origin}`)
  console.log(`API base: ${api}\n`)

  try {
    /* ---------------- /status ---------------- */
    const status = await getJson(`${api}/status`)
    check(
      'GET /status -> 200 ok:true',
      status.response.status === 200 && status.body?.ok === true,
      `HTTP ${status.response.status}`,
    )
    const statusSources = status.body?.sources || {}
    const statusLimits = status.body?.limits || {}
    check(
      'status advertises tmdb unconfigured, imdb/douban configured',
      statusSources.tmdb?.configured === false &&
        statusSources.imdb?.configured === true &&
        statusSources.douban?.configured === true,
      JSON.stringify(statusSources),
    )
    check(
      'status limits = { maxResults: 10, requestTimeoutMs: 8000 }',
      statusLimits.maxResults === 10 && statusLimits.requestTimeoutMs === 8000,
      JSON.stringify(statusLimits),
    )
    check('status version present', typeof status.body?.version === 'string', status.body?.version)

    /* ---------------- /search IMDb ---------------- */
    const imdb = await getJson(`${api}/search?q=Inception&source=imdb`)
    const imdbResults = Array.isArray(imdb.body?.results) ? imdb.body.results : []
    check(
      'GET /search?q=Inception&source=imdb -> 200 ok:true',
      imdb.response.status === 200 && imdb.body?.ok === true,
      `HTTP ${imdb.response.status}`,
    )
    check(
      'IMDb envelope echoes query/source/lang',
      imdb.body?.query === 'Inception' &&
        imdb.body?.source === 'imdb' &&
        imdb.body?.lang === 'zh-CN',
      `query=${imdb.body?.query} source=${imdb.body?.source} lang=${imdb.body?.lang}`,
    )
    check(
      'IMDb returns normalized movie rows',
      imdbResults.length > 0 &&
        imdbResults.every(isNormalizedResult) &&
        imdbResults.every((row) => row.source === 'imdb') &&
        imdbResults.some((row) => row.kind === 'movie' && /^tt\d+$/.test(row.id)),
      `${imdbResults.length} row(s)`,
    )
    check(
      'IMDb rows carry an imdb.com title URL',
      imdbResults.length > 0 &&
        imdbResults.every((row) => String(row.url).startsWith('https://www.imdb.com/title/')),
      imdbResults[0]?.url || 'none',
    )
    printSample('IMDb normalized result[0]', imdbResults[0])

    /* ---------------- /search Douban ---------------- */
    const doubanQuery = '星际穿越'
    const douban = await getJson(
      `${api}/search?q=${encodeURIComponent(doubanQuery)}&source=douban`,
    )
    const doubanResults = Array.isArray(douban.body?.results) ? douban.body.results : []
    check(
      'GET /search (星际穿越, source=douban) -> 200 ok:true',
      douban.response.status === 200 && douban.body?.ok === true,
      `HTTP ${douban.response.status}`,
    )
    check(
      'Douban returns normalized subject rows',
      doubanResults.length > 0 &&
        doubanResults.every(isNormalizedResult) &&
        doubanResults.every((row) => row.source === 'douban') &&
        doubanResults.some((row) => row.title.includes(doubanQuery)),
      `${doubanResults.length} row(s)`,
    )
    check(
      'Douban page URLs have their query string stripped',
      doubanResults.length > 0 && doubanResults.every((row) => !String(row.url).includes('?')),
      doubanResults[0]?.url || 'none',
    )
    printSample('Douban normalized result[0]', doubanResults[0])

    const posterUrl = doubanResults
      .map((row) => row.poster)
      .find((poster) => typeof poster === 'string' && poster.startsWith('https://'))
    check(
      'Douban exposed an https poster URL for the proxy check',
      Boolean(posterUrl),
      posterUrl || 'none found',
    )

    /* ---------------- /search all (TMDB missing key) ---------------- */
    const all = await getJson(`${api}/search?q=Inception&source=all`)
    const allResults = Array.isArray(all.body?.results) ? all.body.results : []
    const allErrors = Array.isArray(all.body?.errors) ? all.body.errors : []
    check(
      'GET /search?q=Inception&source=all -> 200 ok:true with merged rows',
      all.response.status === 200 && all.body?.ok === true && allResults.length > 0,
      `HTTP ${all.response.status}, ${allResults.length} row(s)`,
    )
    check(
      'source=all records tmdb_key_missing and still returns imdb + douban',
      allErrors.some((entry) => entry.source === 'tmdb' && entry.code === 'tmdb_key_missing') &&
        allResults.some((row) => row.source === 'imdb') &&
        allResults.some((row) => row.source === 'douban'),
      `errors=${JSON.stringify(allErrors.map((entry) => `${entry.source}:${entry.code}`))}`,
    )
    const firstImdbIndex = allResults.findIndex((row) => row.source === 'imdb')
    const firstDoubanIndex = allResults.findIndex((row) => row.source === 'douban')
    check(
      'source=all merges in tmdb, imdb, douban provider order',
      firstImdbIndex >= 0 && firstDoubanIndex > firstImdbIndex,
      `imdb@${firstImdbIndex}, douban@${firstDoubanIndex}`,
    )

    const tmdbOnly = await getJson(`${api}/search?q=Inception&source=tmdb`)
    check(
      'source=tmdb without a credential -> 200 ok:true, [] results, tmdb_key_missing error',
      tmdbOnly.response.status === 200 &&
        tmdbOnly.body?.ok === true &&
        Array.isArray(tmdbOnly.body?.results) &&
        tmdbOnly.body.results.length === 0 &&
        tmdbOnly.body?.errors?.some((entry) => entry.code === 'tmdb_key_missing'),
      `errors=${JSON.stringify(tmdbOnly.body?.errors?.map((entry) => entry.code))}`,
    )

    /* ---------------- /trending (contract v1.1 + v1.2) ---------------- */
    const trendingDouban = await getJson(`${api}/trending?source=douban`)
    const trendingDoubanRows = Array.isArray(trendingDouban.body?.results)
      ? trendingDouban.body.results
      : []
    check(
      'GET /trending?source=douban -> 200 ok:true with normalized rows',
      trendingDouban.response.status === 200 &&
        trendingDouban.body?.ok === true &&
        trendingDoubanRows.length > 0 &&
        trendingDoubanRows.every(isNormalizedResult) &&
        trendingDoubanRows.every((row) => row.source === 'douban'),
      `HTTP ${trendingDouban.response.status}, ${trendingDoubanRows.length} row(s)`,
    )
    check(
      'Douban trending maps rate to a numeric 0–10 rating where present',
      trendingDoubanRows.some((row) => typeof row.rating === 'number') &&
        trendingDoubanRows.every(
          (row) =>
            row.rating === null ||
            (typeof row.rating === 'number' && row.rating >= 0 && row.rating <= 10),
        ),
      `ratings=${JSON.stringify(trendingDoubanRows.map((row) => row.rating))}`,
    )
    check(
      'Douban trending interleaves movie[0], tv[0], movie[1], tv[1], …',
      trendingDoubanRows.length >= 2 &&
        trendingDoubanRows.every(
          (row, index) => row.kind === (index % 2 === 0 ? 'movie' : 'tv'),
        ),
      trendingDoubanRows.map((row) => row.kind).join(','),
    )
    printSample('Douban trending result[0]', trendingDoubanRows[0])

    const trendingImdb = await getJson(`${api}/trending?source=imdb`)
    const trendingImdbRows = Array.isArray(trendingImdb.body?.results)
      ? trendingImdb.body.results
      : []
    const allSeedIds = IMDB_TRENDING_SEEDS.map((seed) => seed.id)
    const defaultSeedIds = allSeedIds.slice(0, 10)
    check(
      'GET /trending?source=imdb -> 200 ok:true with the default ten seeded ids in order',
      trendingImdb.response.status === 200 &&
        trendingImdb.body?.ok === true &&
        trendingImdbRows.length === defaultSeedIds.length &&
        trendingImdbRows.every((row, index) => row.id === defaultSeedIds[index]),
      `ids=${trendingImdbRows.map((row) => row.id).join(',')}`,
    )
    check(
      'IMDb trending rows are normalized with null rating/votes',
      trendingImdbRows.every(isNormalizedResult) &&
        trendingImdbRows.every(
          (row) =>
            row.source === 'imdb' &&
            row.rating === null &&
            row.votes === null &&
            String(row.url).startsWith('https://www.imdb.com/title/'),
        ),
      `${trendingImdbRows.length} row(s)`,
    )
    printSample('IMDb trending result[0]', trendingImdbRows[0])

    const trendingImdbCached = await getJson(`${api}/trending?source=imdb`)
    check(
      'IMDb trending list is cached in Host memory (repeat call returns the same rows)',
      JSON.stringify(trendingImdbCached.body?.results?.map((row) => row.id)) ===
        JSON.stringify(defaultSeedIds),
      `first tookMs=${trendingImdb.body?.tookMs}, cached tookMs=${trendingImdbCached.body?.tookMs}`,
    )
    info(
      'IMDb trending three-hour cache timing',
      `first=${trendingImdb.body?.tookMs}ms, cached=${trendingImdbCached.body?.tookMs}ms`,
    )

    const trendingTmdb = await getJson(`${api}/trending?source=tmdb`)
    check(
      'trending source=tmdb without a credential -> 200 ok:true, [] results, tmdb_key_missing',
      trendingTmdb.response.status === 200 &&
        trendingTmdb.body?.ok === true &&
        Array.isArray(trendingTmdb.body?.results) &&
        trendingTmdb.body.results.length === 0 &&
        trendingTmdb.body?.errors?.some((entry) => entry.code === 'tmdb_key_missing'),
      `errors=${JSON.stringify(trendingTmdb.body?.errors?.map((entry) => entry.code))}`,
    )

    const trendingAll = await getJson(`${api}/trending?source=all`)
    const trendingAllRows = Array.isArray(trendingAll.body?.results)
      ? trendingAll.body.results
      : []
    const trendingAllErrors = Array.isArray(trendingAll.body?.errors)
      ? trendingAll.body.errors
      : []
    const lastImdbTrendingIndex = trendingAllRows.reduce(
      (last, row, index) => (row.source === 'imdb' ? index : last),
      -1,
    )
    const firstDoubanTrendingIndex = trendingAllRows.findIndex(
      (row) => row.source === 'douban',
    )
    check(
      'trending source=all -> 200 ok:true, tmdb_key_missing, imdb then douban merged in order',
      trendingAll.response.status === 200 &&
        trendingAll.body?.ok === true &&
        trendingAll.body?.query === undefined &&
        trendingAllErrors.some(
          (entry) => entry.source === 'tmdb' && entry.code === 'tmdb_key_missing',
        ) &&
        lastImdbTrendingIndex >= 0 &&
        firstDoubanTrendingIndex > lastImdbTrendingIndex &&
        trendingAllRows.some((row) => row.source === 'douban'),
      `${trendingAllRows.length} row(s), errors=${JSON.stringify(
        trendingAllErrors.map((entry) => `${entry.source}:${entry.code}`),
      )}`,
    )

    const trendingBadSource = await getJson(`${api}/trending?source=nope`)
    check(
      'trending bad source -> 400 bad_source',
      trendingBadSource.response.status === 400 &&
        trendingBadSource.body?.code === 'bad_source',
      `HTTP ${trendingBadSource.response.status}, code=${trendingBadSource.body?.code}`,
    )

    /* ---------------- /trending?limit= (contract v1.2) ---------------- */
    const trendingDouban24 = await getJson(`${api}/trending?source=douban&limit=24`)
    const trendingDouban24Rows = Array.isArray(trendingDouban24.body?.results)
      ? trendingDouban24.body.results
      : []
    const douban24Movies = trendingDouban24Rows.filter((row) => row.kind === 'movie').length
    const douban24Tv = trendingDouban24Rows.filter((row) => row.kind === 'tv').length
    check(
      'trending source=douban&limit=24 -> 24 interleaved rows with numeric ratings where present',
      trendingDouban24.response.status === 200 &&
        trendingDouban24.body?.ok === true &&
        trendingDouban24.body?.limit === undefined &&
        trendingDouban24Rows.length === 24 &&
        trendingDouban24Rows.every(isNormalizedResult) &&
        trendingDouban24Rows.every((row) => row.source === 'douban') &&
        trendingDouban24Rows.every(
          (row, index) => row.kind === (index % 2 === 0 ? 'movie' : 'tv'),
        ) &&
        trendingDouban24Rows.some((row) => typeof row.rating === 'number') &&
        trendingDouban24Rows.every(
          (row) =>
            row.rating === null ||
            (typeof row.rating === 'number' && row.rating >= 0 && row.rating <= 10),
        ),
      `HTTP ${trendingDouban24.response.status}, ${trendingDouban24Rows.length} row(s) = ${douban24Movies} movie + ${douban24Tv} tv`,
    )
    printSample('Douban trending limit=24 result[0]', trendingDouban24Rows[0])

    const trendingImdb24 = await getJson(`${api}/trending?source=imdb&limit=24`)
    const trendingImdb24Rows = Array.isArray(trendingImdb24.body?.results)
      ? trendingImdb24.body.results
      : []
    const first24SeedIds = allSeedIds.slice(0, 24)
    check(
      'trending source=imdb&limit=24 -> 24 seeded ids in contract order (first ten unchanged)',
      trendingImdb24.response.status === 200 &&
        trendingImdb24.body?.ok === true &&
        trendingImdb24Rows.length === first24SeedIds.length &&
        trendingImdb24Rows.every((row, index) => row.id === first24SeedIds[index]) &&
        trendingImdb24Rows.every(isNormalizedResult),
      `ids=${trendingImdb24Rows.map((row) => row.id).join(',')}`,
    )
    printSample('IMDb trending limit=24 ids (contract order)', first24SeedIds)

    const trendingTmdb24 = await getJson(`${api}/trending?source=tmdb&limit=24`)
    check(
      'trending source=tmdb&limit=24 without a credential -> 200 ok:true, [] results, tmdb_key_missing',
      trendingTmdb24.response.status === 200 &&
        trendingTmdb24.body?.ok === true &&
        Array.isArray(trendingTmdb24.body?.results) &&
        trendingTmdb24.body.results.length === 0 &&
        trendingTmdb24.body?.errors?.some((entry) => entry.code === 'tmdb_key_missing'),
      `errors=${JSON.stringify(trendingTmdb24.body?.errors?.map((entry) => entry.code))}`,
    )

    const trendingAll24 = await getJson(`${api}/trending?source=all&limit=24`)
    const trendingAll24Rows = Array.isArray(trendingAll24.body?.results)
      ? trendingAll24.body.results
      : []
    const trendingAll24Errors = Array.isArray(trendingAll24.body?.errors)
      ? trendingAll24.body.errors
      : []
    const imdb24Count = trendingAll24Rows.filter((row) => row.source === 'imdb').length
    const douban24Count = trendingAll24Rows.filter((row) => row.source === 'douban').length
    const lastImdb24Index = trendingAll24Rows.reduce(
      (last, row, index) => (row.source === 'imdb' ? index : last),
      -1,
    )
    const firstDouban24Index = trendingAll24Rows.findIndex(
      (row) => row.source === 'douban',
    )
    check(
      'trending source=all&limit=24 -> 24 rows per available provider, imdb then douban',
      trendingAll24.response.status === 200 &&
        trendingAll24.body?.ok === true &&
        trendingAll24.body?.limit === undefined &&
        imdb24Count === 24 &&
        douban24Count === 24 &&
        lastImdb24Index >= 0 &&
        firstDouban24Index > lastImdb24Index &&
        trendingAll24Errors.some(
          (entry) => entry.source === 'tmdb' && entry.code === 'tmdb_key_missing',
        ),
      `${trendingAll24Rows.length} row(s) = ${imdb24Count} imdb + ${douban24Count} douban`,
    )

    const trendingLimitAbc = await getJson(`${api}/trending?source=imdb&limit=abc`)
    check(
      'trending limit=abc is ignored and falls back to maxResults (10)',
      trendingLimitAbc.response.status === 200 &&
        trendingLimitAbc.body?.results?.length === 10 &&
        trendingLimitAbc.body.results.every((row, index) => row.id === defaultSeedIds[index]),
      `${trendingLimitAbc.body?.results?.length} row(s)`,
    )

    const trendingLimitZero = await getJson(`${api}/trending?source=imdb&limit=0`)
    check(
      'trending limit=0 is ignored and falls back to maxResults (10)',
      trendingLimitZero.response.status === 200 &&
        trendingLimitZero.body?.results?.length === 10 &&
        trendingLimitZero.body.results.every(
          (row, index) => row.id === defaultSeedIds[index],
        ),
      `${trendingLimitZero.body?.results?.length} row(s)`,
    )

    const trendingLimitClamped = await getJson(`${api}/trending?source=douban&limit=99`)
    const trendingLimitClampedRows = Array.isArray(trendingLimitClamped.body?.results)
      ? trendingLimitClamped.body.results
      : []
    check(
      'trending limit=99 clamps to 30 -> douban returns 30 interleaved rows',
      trendingLimitClamped.response.status === 200 &&
        trendingLimitClamped.body?.ok === true &&
        trendingLimitClampedRows.length === 30 &&
        trendingLimitClampedRows.every(
          (row, index) => row.kind === (index % 2 === 0 ? 'movie' : 'tv'),
        ),
      `${trendingLimitClampedRows.length} row(s)`,
    )

    const trendingImdbCapped = await getJson(`${api}/trending?source=imdb&limit=99`)
    check(
      'trending limit=99 on IMDb clamps to 30, returns its 24 seeds and no error',
      trendingImdbCapped.response.status === 200 &&
        trendingImdbCapped.body?.ok === true &&
        trendingImdbCapped.body?.results?.length === allSeedIds.length &&
        trendingImdbCapped.body?.results?.every(
          (row, index) => row.id === allSeedIds[index],
        ) &&
        Array.isArray(trendingImdbCapped.body?.errors) &&
        trendingImdbCapped.body.errors.length === 0,
      `${trendingImdbCapped.body?.results?.length} row(s), errors=${JSON.stringify(
        trendingImdbCapped.body?.errors,
      )}`,
    )

    /* ---------------- /browse (contract v1.6) ---------------- */
    const browseDouban = await getJson(`${api}/browse?source=douban&category=movie&page=1`)
    const browseDoubanItems = Array.isArray(browseDouban.body?.items)
      ? browseDouban.body.items
      : []
    check(
      'GET /browse?source=douban&category=movie&page=1 -> 200 ok:true with one normalized page',
      browseDouban.response.status === 200 &&
        browseDouban.body?.ok === true &&
        browseDouban.body?.source === 'douban' &&
        browseDouban.body?.category === 'movie' &&
        browseDouban.body?.page === 1 &&
        browseDouban.body?.pageSize === 20 &&
        Array.isArray(browseDouban.body?.categories) &&
        browseDouban.body.categories.join(',') === 'popular,movie,tv' &&
        browseDoubanItems.length === 20 &&
        browseDoubanItems.every(isNormalizedResult) &&
        browseDoubanItems.every((row) => row.source === 'douban' && row.kind === 'movie') &&
        browseDouban.body?.hasMore === true &&
        Array.isArray(browseDouban.body?.errors) &&
        browseDouban.body.errors.length === 0,
      `HTTP ${browseDouban.response.status}, ${browseDoubanItems.length} row(s), hasMore=${browseDouban.body?.hasMore}`,
    )

    const browseDoubanPage2 = await getJson(`${api}/browse?source=douban&category=movie&page=2`)
    const browseDoubanPage2Items = Array.isArray(browseDoubanPage2.body?.items)
      ? browseDoubanPage2.body.items
      : []
    const browseDoubanPage1Ids = new Set(browseDoubanItems.map((row) => row.id))
    check(
      'Douban browse page=2 returns the next page (no overlap with page 1)',
      browseDoubanPage2.response.status === 200 &&
        browseDoubanPage2.body?.page === 2 &&
        browseDoubanPage2Items.length === 20 &&
        browseDoubanPage2Items.every((row) => !browseDoubanPage1Ids.has(row.id)),
      `${browseDoubanPage2Items.length} row(s)`,
    )

    const browseDefaultCategory = await getJson(`${api}/browse?source=douban`)
    check(
      'browse omits category -> falls back to the first category (douban: popular)',
      browseDefaultCategory.response.status === 200 &&
        browseDefaultCategory.body?.category === 'popular',
      `category=${browseDefaultCategory.body?.category}`,
    )

    const browseDoubanPopular = await getJson(`${api}/browse?source=douban&category=popular&page=1`)
    const browseDoubanPopularItems = Array.isArray(browseDoubanPopular.body?.items)
      ? browseDoubanPopular.body.items
      : []
    check(
      'Douban popular browse page=1 interleaves movie and TV hot rows',
      browseDoubanPopular.response.status === 200 &&
        browseDoubanPopularItems.length === 20 &&
        browseDoubanPopularItems[0]?.kind === 'movie' &&
        browseDoubanPopularItems[1]?.kind === 'tv' &&
        browseDoubanPopularItems.some((row) => row.kind === 'tv') &&
        browseDoubanPopular.body?.hasMore === true,
      `${browseDoubanPopularItems.length} row(s), hasMore=${browseDoubanPopular.body?.hasMore}`,
    )

    const browseImdbFeatured = await getJson(`${api}/browse?source=imdb&category=featured&page=1`)
    const browseImdbFeaturedItems = Array.isArray(browseImdbFeatured.body?.items)
      ? browseImdbFeatured.body.items
      : []
    const featuredCursor = browseImdbFeatured.body?.next
    check(
      'IMDb featured browse page=1 mixes movie and TV rows and returns a cursor',
      browseImdbFeatured.response.status === 200 &&
        browseImdbFeatured.body?.category === 'featured' &&
        browseImdbFeaturedItems.length === 20 &&
        browseImdbFeaturedItems.every((row) => row.source === 'imdb') &&
        browseImdbFeaturedItems.some((row) => row.kind === 'movie') &&
        browseImdbFeaturedItems.some((row) => row.kind === 'tv') &&
        browseImdbFeatured.body?.hasMore === true &&
        typeof featuredCursor === 'string' &&
        featuredCursor.length > 0,
      `${browseImdbFeaturedItems.length} row(s), hasMore=${browseImdbFeatured.body?.hasMore}`,
    )

    const browseImdbTv = await getJson(`${api}/browse?source=imdb&category=tv&page=1`)
    const browseImdbTvItems = Array.isArray(browseImdbTv.body?.items)
      ? browseImdbTv.body.items
      : []
    const imdbTvCursor = browseImdbTv.body?.next
    check(
      'IMDb TV browse page=1 returns 20 popularity rows and a cursor',
      browseImdbTv.response.status === 200 &&
        browseImdbTv.body?.ok === true &&
        browseImdbTv.body?.category === 'tv' &&
        browseImdbTvItems.length === 20 &&
        browseImdbTvItems.every((row) => row.source === 'imdb' && row.kind === 'tv') &&
        browseImdbTv.body?.hasMore === true &&
        typeof imdbTvCursor === 'string' &&
        imdbTvCursor.length > 0,
      `${browseImdbTvItems.length} row(s), hasMore=${browseImdbTv.body?.hasMore}`,
    )

    const browseImdbTvPage2 = await getJson(
      `${api}/browse?source=imdb&category=tv&page=2&cursor=${encodeURIComponent(imdbTvCursor || '')}`,
    )
    const browseImdbTvPage2Items = Array.isArray(browseImdbTvPage2.body?.items)
      ? browseImdbTvPage2.body.items
      : []
    const browseImdbTvPage1Ids = new Set(browseImdbTvItems.map((row) => row.id))
    check(
      'IMDb TV browse cursor page=2 returns the next rows with no overlap',
      browseImdbTvPage2.response.status === 200 &&
        browseImdbTvPage2Items.length === 20 &&
        browseImdbTvPage2Items.every((row) => !browseImdbTvPage1Ids.has(row.id)) &&
        browseImdbTvPage2.body?.hasMore === true,
      `${browseImdbTvPage2Items.length} row(s), hasMore=${browseImdbTvPage2.body?.hasMore}`,
    )

    const browseImdbMovie = await getJson(`${api}/browse?source=imdb&category=movie&page=1`)
    const browseImdbMovieItems = Array.isArray(browseImdbMovie.body?.items)
      ? browseImdbMovie.body.items
      : []
    const imdbMovieCursor = browseImdbMovie.body?.next
    check(
      'IMDb movie browse page=1 returns 20 popularity rows and a cursor',
      browseImdbMovie.response.status === 200 &&
        browseImdbMovieItems.length === 20 &&
        browseImdbMovieItems.every((row) => row.source === 'imdb' && row.kind === 'movie') &&
        browseImdbMovie.body?.hasMore === true &&
        typeof imdbMovieCursor === 'string' &&
        imdbMovieCursor.length > 0,
      `${browseImdbMovieItems.length} row(s), hasMore=${browseImdbMovie.body?.hasMore}`,
    )

    const browseImdbMoviePage2 = await getJson(
      `${api}/browse?source=imdb&category=movie&page=2&cursor=${encodeURIComponent(imdbMovieCursor || '')}`,
    )
    const browseImdbMoviePage2Items = Array.isArray(browseImdbMoviePage2.body?.items)
      ? browseImdbMoviePage2.body.items
      : []
    const browseImdbMoviePage1Ids = new Set(browseImdbMovieItems.map((row) => row.id))
    check(
      'IMDb movie browse cursor page=2 returns the next rows with no overlap',
      browseImdbMoviePage2.response.status === 200 &&
        browseImdbMoviePage2Items.length === 20 &&
        browseImdbMoviePage2Items.every((row) => !browseImdbMoviePage1Ids.has(row.id)) &&
        browseImdbMoviePage2.body?.hasMore === true,
      `${browseImdbMoviePage2Items.length} row(s), hasMore=${browseImdbMoviePage2.body?.hasMore}`,
    )

    const browseImdbBadCursor = await getJson(
      `${api}/browse?source=imdb&category=movie&page=1&cursor=${'x'.repeat(5000)}`,
    )
    check(
      'browse with an oversized cursor -> 400 bad_cursor',
      browseImdbBadCursor.response.status === 400 &&
        browseImdbBadCursor.body?.ok === false &&
        browseImdbBadCursor.body?.code === 'bad_cursor',
      `HTTP ${browseImdbBadCursor.response.status}`,
    )

    const tmdbMovieRow = normalizeTmdbBrowseItem(
      { id: 27205, title: 'Inception', release_date: '2010-07-15', vote_average: 8.4, poster_path: '/x.jpg' },
      'movie',
    )
    check(
      '/movie/popular rows (no media_type) are inferred as movie',
      tmdbMovieRow?.kind === 'movie' && tmdbMovieRow?.id === '27205',
      `kind=${tmdbMovieRow?.kind}`,
    )
    const tmdbTvRow = normalizeTmdbBrowseItem(
      { id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' },
      'tv',
    )
    check(
      '/tv/popular rows (no media_type) are inferred as tv',
      tmdbTvRow?.kind === 'tv' && tmdbTvRow?.id === '1396',
      `kind=${tmdbTvRow?.kind}`,
    )
    const tmdbTrendingRow = normalizeTmdbBrowseItem(
      { id: 550, media_type: 'movie', title: 'Fight Club' },
      'trending',
    )
    check(
      'trending rows keep their own media_type',
      tmdbTrendingRow?.kind === 'movie' && tmdbTrendingRow?.id === '550',
      `kind=${tmdbTrendingRow?.kind}`,
    )

    const browseTmdbNoKey = await getJson(`${api}/browse?source=tmdb&category=trending&page=1`)
    check(
      'browse tmdb without a key -> 200 with tmdb_key_missing and an empty page',
      browseTmdbNoKey.response.status === 200 &&
        browseTmdbNoKey.body?.ok === true &&
        browseTmdbNoKey.body?.items?.length === 0 &&
        browseTmdbNoKey.body?.hasMore === false &&
        browseTmdbNoKey.body?.errors?.some(
          (entry) => entry.source === 'tmdb' && entry.code === 'tmdb_key_missing',
        ),
      `HTTP ${browseTmdbNoKey.response.status}`,
    )

    const browseMissingSource = await getJson(`${api}/browse?category=movie`)
    check(
      'browse without source -> 400 bad_source',
      browseMissingSource.response.status === 400 &&
        browseMissingSource.body?.code === 'bad_source',
      `HTTP ${browseMissingSource.response.status}`,
    )

    const browseAllSource = await getJson(`${api}/browse?source=all`)
    check(
      'browse source=all -> 400 bad_source (single channel only)',
      browseAllSource.response.status === 400 &&
        browseAllSource.body?.code === 'bad_source',
      `HTTP ${browseAllSource.response.status}`,
    )

    const browseBadCategory = await getJson(`${api}/browse?source=imdb&category=trending`)
    check(
      'browse unsupported category -> 400 bad_category',
      browseBadCategory.response.status === 400 &&
        browseBadCategory.body?.code === 'bad_category',
      `HTTP ${browseBadCategory.response.status}`,
    )

    const browseBadPage = await getJson(`${api}/browse?source=douban&page=101`)
    check(
      'browse page=101 -> 400 bad_page',
      browseBadPage.response.status === 400 && browseBadPage.body?.code === 'bad_page',
      `HTTP ${browseBadPage.response.status}`,
    )

    const browseNonNumericPage = await getJson(`${api}/browse?source=douban&page=abc`)
    check(
      'browse page=abc -> 400 bad_page',
      browseNonNumericPage.response.status === 400 &&
        browseNonNumericPage.body?.code === 'bad_page',
      `HTTP ${browseNonNumericPage.response.status}`,
    )

    /* ---------------- /charts + /chart (contract v1.8) ---------------- */
    const charts = await getJson(`${api}/charts?source=douban`)
    const chartList = Array.isArray(charts.body?.charts) ? charts.body.charts : []
    const officialCharts = chartList.filter((chart) => chart.family === 'official')
    const genreCharts = chartList.filter((chart) => chart.family === 'rating' || chart.family === 'heat')
    const hiddenCharts = chartList.filter((chart) => chart.family === 'hidden')
    const annualCharts = chartList.filter((chart) => chart.family === 'annual')
    check(
      'GET /charts?source=douban -> the movie chart catalog',
      charts.response.status === 200 &&
        charts.body?.ok === true &&
        charts.body?.source === 'douban' &&
        charts.body?.kind === 'movie' &&
        chartList.length === 94 &&
        officialCharts.length === 3 &&
        officialCharts.map((chart) => chart.id).join(',') ===
          'movie_top250,movie_weekly_best,movie_real_time_hotest' &&
        genreCharts.length === 54 &&
        hiddenCharts.length === 27 &&
        annualCharts.length === 10 &&
        chartList.every((chart) => chart.kind === 'movie') &&
        chartList.every((chart) => typeof chart.title === 'string' && chart.title.length > 0 && typeof chart.family === 'string') &&
        Array.isArray(charts.body?.errors),
      `HTTP ${charts.response.status}, charts=${chartList.length}, official=${officialCharts.length}, genre=${genreCharts.length}, hidden=${hiddenCharts.length}, annual=${annualCharts.length}`,
    )
    const comedyChart = chartList.find((chart) => chart.id === 'genre:喜剧:S')
    const actionChart = chartList.find((chart) => chart.id === 'genre:动作:U')
    check(
      'genre charts are titled 高分经典X片 / 近期热门X片 and grouped by family',
      comedyChart?.title === '高分经典喜剧片' &&
        comedyChart?.family === 'rating' &&
        actionChart?.title === '近期热门动作片' &&
        actionChart?.family === 'heat' &&
        genreCharts.filter((chart) => chart.family === 'rating').length === 27 &&
        genreCharts.filter((chart) => chart.family === 'heat').length === 27,
      JSON.stringify({
        comedy: comedyChart?.title,
        action: actionChart?.title,
        rating: genreCharts.filter((chart) => chart.family === 'rating').length,
        heat: genreCharts.filter((chart) => chart.family === 'heat').length,
      }),
    )
    const tvCharts = await getJson(`${api}/charts?source=douban&kind=tv`)
    const tvChartList = Array.isArray(tvCharts.body?.charts) ? tvCharts.body.charts : []
    const tvOfficial = tvChartList.filter((chart) => chart.family === 'official')
    const tvGenre = tvChartList.filter((chart) => chart.family === 'rating' || chart.family === 'heat')
    check(
      'GET /charts?source=douban&kind=tv -> the TV chart catalog',
      tvCharts.response.status === 200 &&
        tvCharts.body?.ok === true &&
        tvCharts.body?.kind === 'tv' &&
        tvChartList.length === 67 &&
        tvOfficial.length === 3 &&
        tvOfficial.map((chart) => chart.id).join(',') ===
          'tv_real_time_hotest,tv_chinese_best_weekly,tv_global_best_weekly' &&
        tvGenre.length === 54 &&
        tvChartList.filter((chart) => chart.family === 'hidden').length === 0 &&
        tvChartList.filter((chart) => chart.family === 'annual').length === 10 &&
        tvChartList.every((chart) => chart.kind === 'tv') &&
        tvChartList.find((chart) => chart.id === 'tv-genre:悬疑:S')?.title === '高分经典悬疑剧' &&
        tvChartList.find((chart) => chart.id === 'tv-genre:悬疑:U')?.title === '近期热门悬疑剧' &&
        tvChartList.find((chart) => chart.id === 'tv-year:2025:U')?.title === '2025 年度热门',
      `HTTP ${tvCharts.response.status}, charts=${tvChartList.length}, official=${tvOfficial.length}, genre=${tvGenre.length}`,
    )
    const hiddenHigh = chartList.find((chart) => chart.id === 'hidden:动作')
    const annualYear = chartList.find((chart) => chart.id === 'year:2025:S')
    check(
      'hidden gems and annual charts are listed with their own titles',
      hiddenHigh?.title === '冷门佳作 · 动作' &&
        hiddenHigh?.subtitle === '冷门佳片' &&
        hiddenHigh?.family === 'hidden' &&
        annualYear?.title === '2025 年度高分' &&
        annualYear?.subtitle === '年度片单' &&
        annualYear?.family === 'annual' &&
        annualCharts.map((chart) => chart.id).join(',') ===
          'year:2025:S,year:2025:U,year:2024:S,year:2024:U,year:2023:S,year:2023:U,year:2022:S,year:2022:U,year:2021:S,year:2021:U',
      JSON.stringify({ hidden: hiddenHigh?.title, annual: annualYear?.title }),
    )
    check(
      'chart metadata carries a cover, a description and a total',
      chartList[0]?.total === 250 &&
        typeof chartList[0]?.cover === 'string' &&
        chartList[0].cover.startsWith('https://') &&
        typeof chartList[0]?.description === 'string' &&
        chartList[0].description.length > 0,
      JSON.stringify({
        total: chartList[0]?.total,
        cover: Boolean(chartList[0]?.cover),
        desc: String(chartList[0]?.description || '').slice(0, 24),
      }),
    )

    const chartPageOne = await getJson(
      `${api}/chart?source=douban&id=movie_top250&start=0&count=5`,
    )
    const chartRows = Array.isArray(chartPageOne.body?.items) ? chartPageOne.body.items : []
    check(
      'GET /chart?source=douban&id=movie_top250&start=0&count=5 -> five ranked titles',
      chartPageOne.response.status === 200 &&
        chartPageOne.body?.ok === true &&
        chartPageOne.body?.id === 'movie_top250' &&
        chartPageOne.body?.total === 250 &&
        chartPageOne.body?.hasMore === true &&
        chartRows.length === 5 &&
        chartRows.every(isNormalizedResult) &&
        chartRows.every((row) => row.source === 'douban') &&
        chartRows.map((row) => row.rank).join(',') === '1,2,3,4,5',
      `HTTP ${chartPageOne.response.status}, rows=${chartRows.length}, ranks=${chartRows.map((row) => row.rank).join(',')}`,
    )
    check(
      'chart rows carry the card subtitle and a poster',
      chartRows.every((row) => typeof row.subtitle === 'string') &&
        chartRows.some((row) => typeof row.poster === 'string' && row.poster.startsWith('https://')),
      JSON.stringify(chartRows.slice(0, 2).map((row) => row.subtitle)),
    )

    const chartLastPage = await getJson(
      `${api}/chart?source=douban&id=movie_top250&start=245&count=10`,
    )
    check(
      'GET /chart movie_top250 start=245 -> the last five rows and hasMore=false',
      chartLastPage.response.status === 200 &&
        chartLastPage.body?.ok === true &&
        chartLastPage.body?.hasMore === false &&
        Array.isArray(chartLastPage.body?.items) &&
        chartLastPage.body.items.length === 5 &&
        chartLastPage.body.items[4]?.rank === 250,
      `HTTP ${chartLastPage.response.status}, rows=${chartLastPage.body?.items?.length}, lastRank=${chartLastPage.body?.items?.[4]?.rank}`,
    )

    const genreId = encodeURIComponent('genre:动作:U')
    const genrePageOne = await getJson(
      `${api}/chart?source=douban&id=${genreId}&start=0&count=5`,
    )
    const genreRows = Array.isArray(genrePageOne.body?.items) ? genrePageOne.body.items : []
    check(
      'GET /chart genre:动作:U start=0 -> recent-hot rows with a capped total',
      genrePageOne.response.status === 200 &&
        genrePageOne.body?.ok === true &&
        genrePageOne.body?.id === 'genre:动作:U' &&
        Number.isInteger(genrePageOne.body?.total) &&
        genrePageOne.body.total <= 500 &&
        genrePageOne.body?.hasMore === true &&
        genreRows.length >= 4 &&
        genreRows.length <= 5 &&
        genreRows.every(isNormalizedResult) &&
        genreRows.every((row) => row.source === 'douban' && row.rank === null),
      `HTTP ${genrePageOne.response.status}, rows=${genreRows.length}, total=${genrePageOne.body?.total}`,
    )
    const genrePageTwo = await getJson(
      `${api}/chart?source=douban&id=${genreId}&start=20&count=5`,
    )
    const genrePageTwoRows = Array.isArray(genrePageTwo.body?.items) ? genrePageTwo.body.items : []
    check(
      'GET /chart genre:动作:U start=20 -> the next rows do not repeat page one',
      genrePageTwo.response.status === 200 &&
        genrePageTwoRows.length >= 4 &&
        genrePageTwoRows.length <= 5 &&
        genrePageTwoRows.every((row) => !genreRows.some((first) => first.id === row.id)),
      `HTTP ${genrePageTwo.response.status}, rows=${genrePageTwoRows.length}`,
    )
    const comedyGenreChart = await getJson(
      `${api}/chart?source=douban&id=${encodeURIComponent('genre:喜剧:S')}&start=0&count=5`,
    )
    check(
      'GET /chart genre:喜剧:S -> high-score comedy rows',
      comedyGenreChart.response.status === 200 &&
        comedyGenreChart.body?.ok === true &&
        Array.isArray(comedyGenreChart.body?.items) &&
        comedyGenreChart.body.items.length >= 4 &&
        comedyGenreChart.body.items.length <= 5 &&
        comedyGenreChart.body.items.every(isNormalizedResult),
      `HTTP ${comedyGenreChart.response.status}, rows=${comedyGenreChart.body?.items?.length}`,
    )
    const hiddenPage = await getJson(
      `${api}/chart?source=douban&id=${encodeURIComponent('hidden:动作')}&start=0&count=5`,
    )
    const hiddenRows = Array.isArray(hiddenPage.body?.items) ? hiddenPage.body.items : []
    check(
      'GET /chart hidden:动作 -> cold-gem rows with a capped total',
      hiddenPage.response.status === 200 &&
        hiddenPage.body?.ok === true &&
        hiddenPage.body?.id === 'hidden:动作' &&
        Number.isInteger(hiddenPage.body?.total) &&
        hiddenPage.body.total <= 500 &&
        hiddenPage.body?.hasMore === true &&
        hiddenRows.length >= 4 &&
        hiddenRows.length <= 5 &&
        hiddenRows.every(isNormalizedResult) &&
        hiddenRows.every((row) => row.source === 'douban' && row.rank === null),
      `HTTP ${hiddenPage.response.status}, rows=${hiddenRows.length}, total=${hiddenPage.body?.total}`,
    )
    const annualPage = await getJson(
      `${api}/chart?source=douban&id=year:2025%3AU&start=0&count=5`,
    )
    const annualRows = Array.isArray(annualPage.body?.items) ? annualPage.body.items : []
    check(
      'GET /chart year:2025:U -> annual rows with a capped total',
      annualPage.response.status === 200 &&
        annualPage.body?.ok === true &&
        annualPage.body?.id === 'year:2025:U' &&
        Number.isInteger(annualPage.body?.total) &&
        annualPage.body.total <= 500 &&
        annualRows.length >= 4 &&
        annualRows.length <= 5 &&
        annualRows.every(isNormalizedResult) &&
        annualRows.every((row) => typeof row.poster === 'string' && row.poster.startsWith('https://')) &&
        annualRows.filter((row) => row.year === 2025).length >= 3,
      `HTTP ${annualPage.response.status}, rows=${annualRows.length}, total=${annualPage.body?.total}, years=${[...new Set(annualRows.map((row) => row.year))].join(',')}`,
    )
    const tvGenrePage = await getJson(
      `${api}/chart?source=douban&id=${encodeURIComponent('tv-genre:悬疑:U')}&start=0&count=5`,
    )
    const tvGenreRows = Array.isArray(tvGenrePage.body?.items) ? tvGenrePage.body.items : []
    check(
      'GET /chart tv-genre:悬疑:U -> TV rows',
      tvGenrePage.response.status === 200 &&
        tvGenrePage.body?.ok === true &&
        tvGenrePage.body?.kind === 'tv' &&
        tvGenreRows.length >= 4 &&
        tvGenreRows.length <= 5 &&
        tvGenreRows.every(isNormalizedResult) &&
        tvGenreRows.every((row) => row.source === 'douban' && row.kind === 'tv' && row.rank === null),
      `HTTP ${tvGenrePage.response.status}, rows=${tvGenreRows.length}`,
    )
    const tvYearPage = await getJson(
      `${api}/chart?source=douban&id=${encodeURIComponent('tv-year:2025:U')}&start=0&count=5`,
    )
    const tvYearRows = Array.isArray(tvYearPage.body?.items) ? tvYearPage.body.items : []
    check(
      'GET /chart tv-year:2025:U -> TV annual rows',
      tvYearPage.response.status === 200 &&
        tvYearPage.body?.ok === true &&
        tvYearPage.body?.kind === 'tv' &&
        tvYearRows.length >= 4 &&
        tvYearRows.length <= 5 &&
        tvYearRows.every((row) => row.kind === 'tv'),
      `HTTP ${tvYearPage.response.status}, rows=${tvYearRows.length}`,
    )
    const tvOfficialPage = await getJson(
      `${api}/chart?source=douban&id=tv_global_best_weekly&start=0&count=5`,
    )
    check(
      'GET /chart tv_global_best_weekly -> ranked TV chart rows',
      tvOfficialPage.response.status === 200 &&
        tvOfficialPage.body?.ok === true &&
        tvOfficialPage.body?.kind === 'tv' &&
        Array.isArray(tvOfficialPage.body?.items) &&
        tvOfficialPage.body.items.length === 5 &&
        tvOfficialPage.body.items.every((row) => row.kind === 'tv'),
      `HTTP ${tvOfficialPage.response.status}, rows=${tvOfficialPage.body?.items?.length}`,
    )
    const badYearChart = await getJson(
      `${api}/chart?source=douban&id=year:1999%3AS`,
    )
    check(
      'chart unknown annual year -> 400 bad_chart',
      badYearChart.response.status === 400 && badYearChart.body?.code === 'bad_chart',
      `HTTP ${badYearChart.response.status}`,
    )
    const badGenreChart = await getJson(
      `${api}/chart?source=douban&id=${encodeURIComponent('genre:不存在:U')}`,
    )
    check(
      'chart unknown genre -> 400 bad_chart',
      badGenreChart.response.status === 400 && badGenreChart.body?.code === 'bad_chart',
      `HTTP ${badGenreChart.response.status}`,
    )

    const badHiddenChart = await getJson(
      `${api}/chart?source=douban&id=${encodeURIComponent('hidden:不存在')}`,
    )
    check(
      'chart unknown hidden-gem genre -> 400 bad_chart',
      badHiddenChart.response.status === 400 && badHiddenChart.body?.code === 'bad_chart',
      `HTTP ${badHiddenChart.response.status}`,
    )
    const chartBadId = await getJson(`${api}/chart?source=douban&id=nope`)
    check(
      'chart unsupported id -> 400 bad_chart',
      chartBadId.response.status === 400 && chartBadId.body?.code === 'bad_chart',
      `HTTP ${chartBadId.response.status}`,
    )
    const chartBadStart = await getJson(`${api}/chart?source=douban&id=movie_top250&start=-1`)
    check(
      'chart start=-1 -> 400 bad_start',
      chartBadStart.response.status === 400 && chartBadStart.body?.code === 'bad_start',
      `HTTP ${chartBadStart.response.status}`,
    )
    const chartBadCount = await getJson(`${api}/chart?source=douban&id=movie_top250&count=0`)
    check(
      'chart count=0 -> 400 bad_count',
      chartBadCount.response.status === 400 && chartBadCount.body?.code === 'bad_count',
      `HTTP ${chartBadCount.response.status}`,
    )
    const chartMissingSource = await getJson(`${api}/chart?id=movie_top250`)
    check(
      'chart without source -> 400 bad_source',
      chartMissingSource.response.status === 400 && chartMissingSource.body?.code === 'bad_source',
      `HTTP ${chartMissingSource.response.status}`,
    )
    const chartsBadSource = await getJson(`${api}/charts?source=tmdb`)
    check(
      'charts source=tmdb -> 400 bad_source',
      chartsBadSource.response.status === 400 && chartsBadSource.body?.code === 'bad_source',
      `HTTP ${chartsBadSource.response.status}`,
    )
    const chartsBadKind = await getJson(`${api}/charts?source=douban&kind=all`)
    check(
      'charts kind=all -> 400 bad_kind',
      chartsBadKind.response.status === 400 && chartsBadKind.body?.code === 'bad_kind',
      `HTTP ${chartsBadKind.response.status}`,
    )
    info(
      'charts sample',
      chartList
        .slice(0, 3)
        .map((chart) => `${chart.id}:${chart.title} (${chart.total})`)
        .join(' ; '),
    )

    /* ---------------- /image proxy ---------------- */
    if (posterUrl) {
      const image = await fetch(`${api}/image?url=${encodeURIComponent(posterUrl)}`)
      const imageBytes = Buffer.from(await image.arrayBuffer())
      const imageType = image.headers.get('content-type') || ''
      check(
        'image proxy: Douban poster -> 200 image/*',
        image.status === 200 && imageType.startsWith('image/'),
        `HTTP ${image.status}, ${imageType}, ${imageBytes.length} bytes`,
      )
      check(
        'image proxy sends cache + CORS + nosniff headers',
        (image.headers.get('cache-control') || '').includes('max-age=86400') &&
          image.headers.get('access-control-allow-origin') === '*' &&
          image.headers.get('x-content-type-options') === 'nosniff',
        `cache-control=${image.headers.get('cache-control')}`,
      )
      check(
        'image proxy body is a non-empty image within the 8 MiB cap',
        imageBytes.length > 0 && imageBytes.length <= 8 * 1024 * 1024,
        `${imageBytes.length} bytes`,
      )

      const direct = await fetch(posterUrl, {
        headers: { 'user-agent': DEFAULT_USER_AGENT },
      })
      info(
        'direct Douban poster without a Douban Referer',
        `HTTP ${direct.status} (expected 418; the proxy sets the Referer)`,
      )
      try {
        await direct.body?.cancel()
      } catch {
        /* ignore */
      }
    } else {
      check('image proxy: Douban poster -> 200 image/*', false, 'no poster URL to test')
    }

    const blocked = await getJson(
      `${api}/image?url=${encodeURIComponent('https://example.com/poster.jpg')}`,
    )
    check(
      'image proxy rejects a disallowed host -> 400 JSON',
      blocked.response.status === 400 && blocked.body?.ok === false,
      `HTTP ${blocked.response.status}, code=${blocked.body?.code}`,
    )

    /* ---------------- /detail (contract v1.4) ---------------- */
    const detail = await getJson(`${api}/detail?source=douban&id=1889243`)
    const detailBody = detail.body?.detail
    check(
      'GET /detail?source=douban&id=1889243 -> 200 ok:true with a synopsis',
      detail.response.status === 200 &&
        detail.body?.ok === true &&
        detailBody &&
        typeof detailBody.overview === 'string' &&
        detailBody.overview.length > 0 &&
        typeof detailBody.title === 'string' &&
        ['movie', 'tv'].includes(detailBody.kind) &&
        Array.isArray(detail.body?.errors) &&
        detail.body.errors.length === 0,
      `HTTP ${detail.response.status}, title=${JSON.stringify(detailBody?.title)}, overview=${(detailBody?.overview || '').length} chars`,
    )
    check(
      'detail rows carry genres, runtime and region metadata',
      Array.isArray(detailBody?.genres) &&
        typeof detailBody?.runtime === 'string' &&
        typeof detailBody?.region === 'string',
      `genres=${JSON.stringify(detailBody?.genres)}, runtime=${JSON.stringify(detailBody?.runtime)}`,
    )
    const detailCached = await getJson(`${api}/detail?source=douban&id=1889243`)
    check(
      'second /detail request is served from the Host cache',
      detailCached.response.status === 200 &&
        detailCached.body?.detail?.overview === detailBody?.overview &&
        detailCached.body?.detail?.title === detailBody?.title &&
        typeof detailCached.body?.tookMs === 'number' &&
        detailCached.body.tookMs <= 5,
      `tookMs=${detailCached.body?.tookMs}, overview=${(detailCached.body?.detail?.overview || '').length} chars`,
    )

    const detailNoSource = await getJson(`${api}/detail?id=1889243`)
    check(
      'detail without source -> 400 bad_source',
      detailNoSource.response.status === 400 && detailNoSource.body?.code === 'bad_source',
      `HTTP ${detailNoSource.response.status}, code=${detailNoSource.body?.code}`,
    )
    const detailBadSource = await getJson(`${api}/detail?source=imdb&id=1889243`)
    check(
      'detail with an unsupported source -> 400 bad_source',
      detailBadSource.response.status === 400 && detailBadSource.body?.code === 'bad_source',
      `HTTP ${detailBadSource.response.status}, code=${detailBadSource.body?.code}`,
    )
    const detailNoId = await getJson(`${api}/detail?source=douban`)
    check(
      'detail without id -> 400 empty_id',
      detailNoId.response.status === 400 && detailNoId.body?.code === 'empty_id',
      `HTTP ${detailNoId.response.status}, code=${detailNoId.body?.code}`,
    )
    const detailBadId = await getJson(`${api}/detail?source=douban&id=abc`)
    check(
      'detail with a non-numeric id -> 400 bad_id',
      detailBadId.response.status === 400 && detailBadId.body?.code === 'bad_id',
      `HTTP ${detailBadId.response.status}, code=${detailBadId.body?.code}`,
    )

    /* ---------------- /detail tmdb + /collection (contract v1.13) ---------------- */
    const detailTmdbNoKey = await getJson(`${api}/detail?source=tmdb&id=157336`)
    check(
      'detail source=tmdb without a credential -> 200 ok:true, detail null, tmdb_key_missing',
      detailTmdbNoKey.response.status === 200 &&
        detailTmdbNoKey.body?.ok === true &&
        detailTmdbNoKey.body?.source === 'tmdb' &&
        detailTmdbNoKey.body?.detail === null &&
        typeof detailTmdbNoKey.body?.lang === 'string' &&
        detailTmdbNoKey.body?.errors?.[0]?.code === 'tmdb_key_missing',
      `HTTP ${detailTmdbNoKey.response.status}, code=${detailTmdbNoKey.body?.errors?.[0]?.code}`,
    )
    const collectionNoSource = await getJson(`${api}/collection?id=86311`)
    check(
      'collection without source -> 400 bad_source',
      collectionNoSource.response.status === 400 && collectionNoSource.body?.code === 'bad_source',
      `HTTP ${collectionNoSource.response.status}, code=${collectionNoSource.body?.code}`,
    )
    const collectionBadSource = await getJson(`${api}/collection?source=douban&id=86311`)
    check(
      'collection with an unsupported source -> 400 bad_source',
      collectionBadSource.response.status === 400 && collectionBadSource.body?.code === 'bad_source',
      `HTTP ${collectionBadSource.response.status}, code=${collectionBadSource.body?.code}`,
    )
    const collectionNoId = await getJson(`${api}/collection?source=tmdb`)
    check(
      'collection without id -> 400 empty_id',
      collectionNoId.response.status === 400 && collectionNoId.body?.code === 'empty_id',
      `HTTP ${collectionNoId.response.status}, code=${collectionNoId.body?.code}`,
    )
    const collectionBadId = await getJson(`${api}/collection?source=tmdb&id=abc`)
    check(
      'collection with a non-numeric id -> 400 bad_id',
      collectionBadId.response.status === 400 && collectionBadId.body?.code === 'bad_id',
      `HTTP ${collectionBadId.response.status}, code=${collectionBadId.body?.code}`,
    )
    const collectionNoKey = await getJson(`${api}/collection?source=tmdb&id=86311`)
    check(
      'collection without a credential -> 200 ok:true, empty parts, tmdb_key_missing',
      collectionNoKey.response.status === 200 &&
        collectionNoKey.body?.ok === true &&
        collectionNoKey.body?.collection === null &&
        Array.isArray(collectionNoKey.body?.items) &&
        collectionNoKey.body.items.length === 0 &&
        collectionNoKey.body?.errors?.[0]?.code === 'tmdb_key_missing',
      `HTTP ${collectionNoKey.response.status}, code=${collectionNoKey.body?.errors?.[0]?.code}`,
    )

    // Offline normalizers: collection metadata from belongs_to_collection and
    // every part mapped into the shared result shape.
    const movieDetailFixture = {
      id: 157336,
      title: '星际穿越',
      original_title: 'Interstellar',
      release_date: '2014-11-05',
      overview: '一队探险家…',
      belongs_to_collection: { id: 86311, name: '星际穿越合集', poster_path: '/abc.jpg' },
    }
    const normalizedDetail = normalizeTmdbMovieDetail(movieDetailFixture, '157336')
    check(
      'normalizeTmdbMovieDetail maps belongs_to_collection',
      String(normalizedDetail?.collection?.id) === '86311' &&
        normalizedDetail?.collection?.name === '星际穿越合集' &&
        typeof normalizedDetail?.collection?.poster === 'string' &&
        normalizedDetail.collection.poster.startsWith('https://image.tmdb.org/t/p/w342/'),
      `collection=${JSON.stringify(normalizedDetail?.collection)}`,
    )
    const collectionFixture = {
      id: 86311,
      name: '星际穿越合集',
      overview: '合集介绍',
      poster_path: '/coll.jpg',
      parts: [
        { id: 3, title: '第三部', release_date: '2020-01-01', vote_average: 7, poster_path: '/p3.jpg' },
        { id: 1, title: '第一部', release_date: '2014-01-01', vote_average: 9, poster_path: '/p1.jpg' },
      ],
    }
    const normalizedCollection = normalizeTmdbCollection(collectionFixture, '86311')
    check(
      'normalizeTmdbCollection maps parts into movie results sorted by year',
      normalizedCollection?.name === '星际穿越合集' &&
        normalizedCollection.items.length === 2 &&
        normalizedCollection.items[0].title === '第一部' &&
        normalizedCollection.items[0].kind === 'movie' &&
        normalizedCollection.items[1].title === '第三部' &&
        typeof normalizedCollection.items[0].poster === 'string' &&
        typeof normalizedCollection.cover === 'string',
      `items=${normalizedCollection?.items?.map(item => item.title).join(',')}`,
    )

    /* ---------------- bad requests / envelopes ---------------- */
    const empty = await getJson(`${api}/search?q=%20%20&source=imdb`)
    check(
      'empty query -> 400 empty_query',
      empty.response.status === 400 && empty.body?.code === 'empty_query',
      `HTTP ${empty.response.status}, code=${empty.body?.code}`,
    )

    const badSource = await getJson(`${api}/search?q=Inception&source=nope`)
    check(
      'bad source -> 400 bad_source',
      badSource.response.status === 400 && badSource.body?.code === 'bad_source',
      `HTTP ${badSource.response.status}, code=${badSource.body?.code}`,
    )

    const unknown = await getJson(`${api}/nope`)
    check(
      'unknown subpath -> 404 JSON',
      unknown.response.status === 404 &&
        unknown.body?.ok === false &&
        unknown.body?.code === 'not_found',
      `HTTP ${unknown.response.status}, code=${unknown.body?.code}`,
    )

    const post = await fetch(`${api}/status`, { method: 'POST' })
    let postBody = null
    try {
      postBody = await post.json()
    } catch {
      postBody = null
    }
    check(
      'unsupported method -> 405 JSON with Allow',
      post.status === 405 &&
        postBody?.ok === false &&
        String(post.headers.get('allow') || '').includes('GET'),
      `HTTP ${post.status}, code=${postBody?.code}`,
    )

    const options = await fetch(`${api}/status`, { method: 'OPTIONS' })
    check(
      'OPTIONS -> 204 with CORS + x-mw-tmdb-key allow header',
      options.status === 204 &&
        options.headers.get('access-control-allow-origin') === '*' &&
        String(options.headers.get('access-control-allow-headers') || '').includes(
          'x-mw-tmdb-key',
        ),
      `HTTP ${options.status}, allow-headers=${options.headers.get('access-control-allow-headers')}`,
    )

    /* ---------------- extra live/defensive probes (informational) ---------------- */
    console.log('')
    const unauthorized = await getJson(`${api}/search?q=Inception&source=tmdb`, {
      headers: { 'x-mw-tmdb-key': 'deadbeefdeadbeefdeadbeefdeadbeef' },
    })
    info(
      'tmdb_unauthorized path (live TMDB 401 via bogus x-mw-tmdb-key)',
      `HTTP ${unauthorized.response.status}, code=${unauthorized.body?.errors?.[0]?.code}`,
    )

    const trendingUnauthorized = await getJson(`${api}/trending?source=tmdb`, {
      headers: { 'x-mw-tmdb-key': 'deadbeefdeadbeefdeadbeefdeadbeef' },
    })
    info(
      'trending tmdb_unauthorized path (live TMDB 401 via bogus x-mw-tmdb-key)',
      `HTTP ${trendingUnauthorized.response.status}, code=${trendingUnauthorized.body?.errors?.[0]?.code}`,
    )

    /* ---------------- /torrents (contract v1.3) ---------------- */
    const torrentFields = ['source', 'id', 'title', 'size', 'seeders', 'leechers', 'category', 'magnet', 'page', 'publishedAt']
    const torrents = await getJson(`${api}/torrents?q=${encodeURIComponent('Inception 2010')}&source=all&limit=20`)
    const torrentRows = Array.isArray(torrents.body?.results) ? torrents.body.results : []
    check(
      'GET /torrents -> 200 ok:true (paged envelope)',
      torrents.response.status === 200 &&
        torrents.body?.ok === true &&
        torrents.body?.page === 1 &&
        typeof torrents.body?.hasMore === 'boolean',
      `HTTP ${torrents.response.status}`,
    )
    check(
      'torrents returns contract-shaped rows with magnet links',
      torrentRows.length > 0 &&
        torrentRows.every(
          (row) =>
            torrentFields.every((field) => field in row) &&
            typeof row.magnet === 'string' &&
            row.magnet.startsWith('magnet:?xt=urn:btih:'),
        ),
      `${torrentRows.length} row(s)`,
    )
    const torrentSources = new Set(torrentRows.map((row) => row.source))
    check(
      'torrents (source=all) keeps both indexes visible',
      torrentSources.has('bitsearch') && torrentSources.has('bt4g'),
      JSON.stringify([...torrentSources]),
    )
    check(
      'torrents bitsearch rows publish numeric seeders',
      torrentRows.some((row) => row.source === 'bitsearch' && Number.isInteger(row.seeders)),
      JSON.stringify(torrentRows.slice(0, 3).map((row) => row.seeders)),
    )
    check(
      'torrents bt4g rows keep movie-ish categories and null seeders',
      torrentRows.filter((row) => row.source === 'bt4g').every(
        (row) => row.seeders === null && (!row.category || /movie|tv|video|anime|archive/i.test(row.category)),
      ),
      JSON.stringify(torrentRows.filter((row) => row.source === 'bt4g').map((row) => row.category)),
    )
    check(
      'torrents dedupe rows by info hash',
      new Set(torrentRows.map((row) => row.id)).size === torrentRows.length,
      `${torrentRows.length} unique`,
    )
    const torrentsAlt = await getJson(
      `${api}/torrents?q=${encodeURIComponent('星际穿越 2014')}&alt=${encodeURIComponent('Inception 2010')}&source=all&limit=20`,
    )
    check(
      'torrents accept alt query and echo it',
      torrentsAlt.body?.ok === true &&
        torrentsAlt.body?.alt === 'Inception 2010' &&
        Array.isArray(torrentsAlt.body?.results) &&
        torrentsAlt.body.results.length > 0,
      `rows=${torrentsAlt.body?.results?.length}`,
    )
    const torrentsLimited = await getJson(`${api}/torrents?q=Inception&limit=5`)
    check(
      'torrents limit=5 caps the merged list',
      Array.isArray(torrentsLimited.body?.results) &&
        torrentsLimited.body.results.length > 0 &&
        torrentsLimited.body.results.length <= 5,
      `rows=${torrentsLimited.body?.results?.length}`,
    )
    const torrentsPage2 = await getJson(
      `${api}/torrents?q=${encodeURIComponent('Inception 2010')}&source=all&limit=20&page=2`,
    )
    const torrentRows2 = Array.isArray(torrentsPage2.body?.results) ? torrentsPage2.body.results : []
    const pageOneIds = new Set(torrentRows.map((row) => row.id))
    check(
      'torrents page=2 -> a second normalized page',
      torrentsPage2.response.status === 200 &&
        torrentsPage2.body?.ok === true &&
        torrentsPage2.body?.page === 2 &&
        typeof torrentsPage2.body?.hasMore === 'boolean' &&
        torrentRows2.length > 0 &&
        torrentRows2.every((row) => row.id && row.magnet && row.title),
      `HTTP ${torrentsPage2.response.status}, rows=${torrentRows2.length}, hasMore=${torrentsPage2.body?.hasMore}`,
    )
    check(
      'torrents page 2 does not repeat page 1 rows',
      torrentRows2.every((row) => !pageOneIds.has(row.id)),
      `overlap=${torrentRows2.filter((row) => pageOneIds.has(row.id)).length}`,
    )
    const torrentsBt4gPage2 = await getJson(`${api}/torrents?q=Inception&source=bt4g&page=2`)
    check(
      'torrents bt4g page=2 -> empty single-page source',
      torrentsBt4gPage2.response.status === 200 &&
        torrentsBt4gPage2.body?.ok === true &&
        torrentsBt4gPage2.body?.page === 2 &&
        torrentsBt4gPage2.body?.hasMore === false &&
        Array.isArray(torrentsBt4gPage2.body?.results) &&
        torrentsBt4gPage2.body.results.length === 0,
      `HTTP ${torrentsBt4gPage2.response.status}, rows=${torrentsBt4gPage2.body?.results?.length}`,
    )
    for (const pageValue of ['0', 'abc', '21']) {
      const badPage = await getJson(`${api}/torrents?q=Inception&page=${pageValue}`)
      check(
        `torrents page=${pageValue} -> 400 bad_page`,
        badPage.response.status === 400 && badPage.body?.code === 'bad_page',
        `HTTP ${badPage.response.status}, code=${badPage.body?.code}`,
      )
    }
    const torrentsEmpty = await getJson(`${api}/torrents?q=`)
    check(
      'torrents empty q -> 400 empty_query',
      torrentsEmpty.response.status === 400 && torrentsEmpty.body?.code === 'empty_query',
      `HTTP ${torrentsEmpty.response.status}, code=${torrentsEmpty.body?.code}`,
    )
    const torrentsBadSource = await getJson(`${api}/torrents?q=Inception&source=nope`)
    check(
      'torrents bad source -> 400 bad_source',
      torrentsBadSource.response.status === 400 && torrentsBadSource.body?.code === 'bad_source',
      `HTTP ${torrentsBadSource.response.status}, code=${torrentsBadSource.body?.code}`,
    )
    info(
      'torrents sample rows',
      torrentRows
        .slice(0, 3)
        .map((row) => `${row.source}:${String(row.title).slice(0, 42)} | ${row.size} | seeders=${row.seeders}`)
        .join(' ; '),
    )

    const upstreamImage = await getJson(
      `${api}/image?url=${encodeURIComponent('https://image.tmdb.org/t/p/w342/movie-workbench-missing-poster.jpg')}`,
    )
    info(
      'upstream_error path (allowed host, missing image)',
      `HTTP ${upstreamImage.response.status}, code=${upstreamImage.body?.code}`,
    )

    const timeoutHandler = createHandler({ requestTimeoutMs: 2 })
    timeoutInstance = await startServer(timeoutHandler)
    const timeoutApi = `${timeoutInstance.origin}${API}`
    const timedOut = await getJson(`${timeoutApi}/search?q=Inception&source=imdb`)
    info(
      'timeout path (requestTimeoutMs=2)',
      `HTTP ${timedOut.response.status}, code=${timedOut.body?.errors?.[0]?.code}`,
    )

    const malformed = await callHandlerDirect(primaryHandler, {
      method: 'GET',
      url: 'http://[',
      headers: {},
    })
    info(
      'malformed URL (direct handler call)',
      `HTTP ${malformed.statusCode}, code=${malformed.body?.code}`,
    )

    const missingTarget = await callHandlerDirect(primaryHandler, {
      method: 'GET',
      url: '',
      headers: {},
    })
    info(
      'missing request target falls back to / -> 404 not_found',
      `HTTP ${missingTarget.statusCode}, code=${missingTarget.body?.code}`,
    )
    await primaryHandler({ method: 'GET', url: `${API}/status`, headers: {} }, undefined)
    info('missing ServerResponse (direct handler call)', 'handler resolved without throwing')
  } finally {
    await stopServer(primaryServer)
    await stopServer(timeoutInstance?.server)
  }

  /* ---------------- summary ---------------- */
  const passedChecks = checks.length - failedChecks
  console.log('')
  console.log(`SUMMARY: ${passedChecks}/${checks.length} required checks passed`)
  if (failedChecks > 0) {
    console.log('FAILED:')
    for (const entry of checks) if (!entry.ok) console.log(`  - ${entry.name}`)
  }
  console.log(failedChecks === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
  process.exitCode = failedChecks === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('FATAL:', error)
  process.exitCode = 1
})
