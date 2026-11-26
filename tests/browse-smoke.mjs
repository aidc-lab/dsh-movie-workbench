/**
 * Offline test for the Douban browse filter/sort contract (v1.22).
 *
 * Run via `make smoke` or `node tests/browse-smoke.mjs`.
 */
import http from 'node:http'
import {
  DEFAULT_DOUBAN_BROWSE_FILTERS,
  filterDoubanRows,
  hasDoubanBrowseFilters,
  sortDoubanRows,
} from '../lib/providers/douban.js'
import { parseDoubanBrowseFilters } from '../lib/host/params.js'
import { createHandler } from '../lib/host.js'

const tests = []
const failures = []

function check(name, ok, detail) {
  tests.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

function params(query) {
  return new URLSearchParams(query)
}

function row(id, year, rating, votes, kind = 'movie') {
  return { id, title: id, year, rating, votes, kind }
}

const ROWS = [
  row('classic', 1994, 9.6, 300),
  row('recent-low', 2024, 7.2, 900),
  row('recent-high', 2021, 8.7, 120),
  row('old', 1985, 8.1, 50),
  row('unknown-rating', 2022, null, 700),
  row('tv-recent', 2023, 8.4, 400, 'tv'),
]

const defaults = parseDoubanBrowseFilters(params(''))
check('defaults parse', defaults && defaults.sort === 'default' && defaults.decade === 'all'
  && defaults.minRating === 0 && defaults.kind === 'all', JSON.stringify(defaults))
check('defaults allow explicit values', parseDoubanBrowseFilters(
  params('sort=rating&decade=2020s&minRating=8&kind=movie'),
)?.sort === 'rating')
check('bad sort rejected', parseDoubanBrowseFilters(params('sort=rating;drop')) === null)
check('bad decade rejected', parseDoubanBrowseFilters(params('decade=2030s')) === null)
check('bad minRating rejected', parseDoubanBrowseFilters(params('minRating=6')) === null)
check('bad kind rejected', parseDoubanBrowseFilters(params('kind=anime')) === null)
check('filter activation', hasDoubanBrowseFilters(DEFAULT_DOUBAN_BROWSE_FILTERS) === false
  && hasDoubanBrowseFilters({ ...DEFAULT_DOUBAN_BROWSE_FILTERS, sort: 'rating' }) === true)

const filtered = filterDoubanRows(ROWS, { ...DEFAULT_DOUBAN_BROWSE_FILTERS, decade: '2020s', minRating: 8 })
check('decade and rating filter', filtered.length === 2
  && filtered.every(x => x.year >= 2020 && x.rating >= 8), filtered.map(x => x.id).join(','))
const movies = filterDoubanRows(ROWS, { ...DEFAULT_DOUBAN_BROWSE_FILTERS, kind: 'movie' })
check('kind filter', movies.length === 5 && movies.every(x => x.kind === 'movie'))
const older = filterDoubanRows(ROWS, { ...DEFAULT_DOUBAN_BROWSE_FILTERS, decade: 'older' })
check('older decade', older.length === 1 && older[0].id === 'old')

const byRating = sortDoubanRows(ROWS, 'rating')
check('rating sort with unknown last', byRating[0].id === 'classic'
  && byRating[byRating.length - 1].id === 'unknown-rating', byRating.map(x => x.id).join(','))
const byVotes = sortDoubanRows(ROWS, 'votes')
check('votes sort', byVotes[0].id === 'recent-low' && byVotes[1].id === 'unknown-rating')
const byYear = sortDoubanRows(ROWS, 'year')
check('year sort', byYear[0].id === 'recent-low' && byYear[byYear.length - 1].id === 'old')
check('default sort preserves order', sortDoubanRows(ROWS, 'default')[0].id === 'classic')

async function startServer(handler) {
  const server = http.createServer((req, res) => void handler(req, res))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

async function stopServer(server) {
  if (!server) return
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

const originalFetch = globalThis.fetch
const localFetch = originalFetch
const seenUrls = []
globalThis.fetch = async (url) => {
  seenUrls.push(String(url))
  return {
    ok: true,
    status: 200,
    json: async () => ({ items: [] }),
    body: null,
    headers: new Headers(),
  }
}

const { server, origin } = await startServer(createHandler({}))
try {
  const bad = await localFetch(`${origin}/movie-workbench/api/browse?source=douban&sort=bogus`)
  const badBody = await bad.json()
  check('browse bad_filter 400', bad.status === 400 && badBody.code === 'bad_filter', JSON.stringify(badBody))

  seenUrls.length = 0
  const good = await localFetch(`${origin}/movie-workbench/api/browse?source=douban&category=popular&sort=rating&decade=2020s&minRating=8&kind=movie`)
  const goodBody = await good.json()
  check('filtered browse 200', good.status === 200 && goodBody.ok === true && Array.isArray(goodBody.items))
  check('filtered browse uses the 200-row pool', seenUrls.length === 2
    && seenUrls.every(url => new URL(url).searchParams.get('count') === '200'),
  seenUrls.map(url => url.split('?')[1] || url).join(' | '))
} finally {
  globalThis.fetch = originalFetch
  await stopServer(server)
}

if (failures.length > 0) {
  console.error(`\nFAIL browse smoke: ${failures.length} of ${tests.length} checks failed.`)
  process.exitCode = 1
} else {
  console.log(`\nPASS browse smoke: ${tests.length} checks.`)
}
