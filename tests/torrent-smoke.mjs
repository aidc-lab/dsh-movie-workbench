/**
 * Offline tests for BitSearch pagination metadata and its cache.
 *
 * The provider used to infer "there is another page" from the number of kept
 * cards. Category filtering can leave fewer than a full page while the site
 * still links later pages, so `hasMore` now comes from the pagination markup.
 * A fake fetch keeps these checks independent of the live index.
 *
 * Run via `make smoke` or `node tests/torrent-smoke.mjs`.
 */
import assert from 'node:assert/strict'
import { mergeTorrentProviders, torrentSource } from '../lib/host/sources.js'
import {
  bitsearchHasNextPage,
  readTorrentCacheEntry,
  searchTorrentsBitsearchPage,
  torrentCache,
} from '../lib/providers/torrents.js'

const tests = []
const failures = []

function check(name, ok, detail) {
  tests.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

function card(title, id = '0123456789abcdef01234567', seeders = 12) {
  const hash = id.padEnd(40, 'a').slice(0, 40)
  return `
    <div class="torrent-result-card p-3">
      <a href="/torrent/${id}">details</a>
      <h3><a href="/torrent/${id}">${title}</a></h3>
      <a href="magnet:?xt=urn:btih:${hash}&amp;dn=Fixture">magnet</a>
      <i class="fa fa-file"></i><span>Movies</span>
      <i class="fa fa-download"></i><span>1.2 GB</span>
      <i class="fa fa-calendar"></i><span>1/2/2024</span>
      <span class="font-medium">${seeders}</span><span>seeders</span>
      <span class="font-medium">3</span><span>leechers</span>
    </div>`
}

function searchHtml(pageLinks, title = 'Fixture 1080p', id = '0123456789abcdef01234567', seeders = 12) {
  return `<html><body>${card(title, id, seeders)}${pageLinks}</body></html>`
}

function fakeFetch(html) {
  return async () => new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })
}

const originalFetch = globalThis.fetch
torrentCache.clear()

try {
  // --- pagination markup ---------------------------------------------------

  check(
    'page 1 with a later link reports hasMore',
    bitsearchHasNextPage('<a href="?q=x&amp;page=2">2</a>', 1) === true,
  )
  check(
    'current page with a later link reports hasMore',
    bitsearchHasNextPage('<a href="?q=x&page=1">1</a><a href="?q=x&page=2">2</a>', 1) === true,
  )
  check(
    'last page reports no more',
    bitsearchHasNextPage('<a href="?q=x&page=1">1</a><a href="?q=x&page=16">16</a>', 16) === false,
  )
  check(
    'page without pagination reports no more',
    bitsearchHasNextPage('<a href="?q=x">fallback</a>', 1) === false,
  )
  check('empty html reports no more', bitsearchHasNextPage('', 1) === false)

  // --- page result and cache ----------------------------------------------

  globalThis.fetch = fakeFetch(searchHtml('<a href="?q=Fixture&amp;page=2">2</a>'))
  const first = await searchTorrentsBitsearchPage({ query: 'Fixture', timeoutMs: 1000 })
  check('parses the fixture card', first.rows.length === 1 && first.rows[0].title === 'Fixture 1080p')
  check('page result carries hasMore', first.hasMore === true)
  check('cache stores hasMore', readTorrentCacheEntry('bitsearch', 'Fixture', 1)?.hasMore === true)

  globalThis.fetch = async () => {
    throw new Error('cache should avoid the network')
  }
  const cached = await searchTorrentsBitsearchPage({ query: 'Fixture', timeoutMs: 1000 })
  check('cached page keeps hasMore', cached.hasMore === true && cached.rows.length === 1)

  // --- an empty result page is not a provider failure ----------------------

  globalThis.fetch = fakeFetch('<html><body><p>No results</p></body></html>')
  const empty = await searchTorrentsBitsearchPage({ query: 'EmptyPage', timeoutMs: 1000 })
  check('a page with no cards returns an empty result', empty.rows.length === 0 && empty.hasMore === false)
  check('empty results are not cached', readTorrentCacheEntry('bitsearch', 'EmptyPage', 1) === null)

  // --- host uses provider metadata and tolerates an empty alt page ---------

  globalThis.fetch = async (url) => new Response(
    url.includes('AltFixture') ? '<html><body><p>No results</p></body></html>' : searchHtml('<a href="?q=Fixture&amp;page=2">2</a>'),
    { status: 200, headers: { 'content-type': 'text/html' } },
  )
  const merged = await torrentSource('bitsearch', {
    queries: ['PrimaryFixture', 'AltFixture'],
    settings: { requestTimeoutMs: 1000, userAgent: 'test' },
    page: 1,
  })
  check('host keeps the provider hasMore flag', merged.rows.length === 1 && merged.hasMore === true)
  check('an empty alternate query does not fail the source', merged.rows[0]?.title === 'Fixture 1080p')

  // --- both title spellings reach the first page ---------------------------

  globalThis.fetch = async (url) => new Response(
    url.includes('AltInterleave')
      ? searchHtml('', '中文资源', 'bbbbbbbbbbbbbbbbbbbbbbbb', 1)
      : searchHtml('', 'English release', 'aaaaaaaaaaaaaaaaaaaaaaaa', 100),
    { status: 200, headers: { 'content-type': 'text/html' } },
  )
  const both = await torrentSource('bitsearch', {
    queries: ['PrimaryInterleave', 'AltInterleave'],
    settings: { requestTimeoutMs: 1000, userAgent: 'test' },
    page: 1,
  })
  check(
    'query spellings are interleaved',
    both.rows.map(row => row.title).join('|') === 'English release|中文资源',
  )

  globalThis.fetch = async (url) => {
    const html = url.includes('AltPriority')
      ? `<html>${card('中 1', 'bbbbbbbbbbbbbbbbbbbbbbb1', 1)}${card('中 2', 'bbbbbbbbbbbbbbbbbbbbbbb2', 2)}</html>`
      : `<html>${card('E 1', 'aaaaaaaaaaaaaaaaaaaaaaa1', 100)}${card('E 2', 'aaaaaaaaaaaaaaaaaaaaaaa2', 90)}${card('E 3', 'aaaaaaaaaaaaaaaaaaaaaaa3', 80)}</html>`
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
  }
  const weighted = await torrentSource('bitsearch', {
    queries: ['PrimaryPriority', 'AltPriority'],
    settings: { requestTimeoutMs: 1000, userAgent: 'test' },
    page: 1,
  })
  check(
    'localized spelling gets two slots per round',
    weighted.rows.map(row => row.title).join('|') === 'E 1|中 2|中 1|E 2|E 3',
  )

  // --- a short provider does not leave holes in the page -------------------

  const longGroup = {
    source: 'bitsearch',
    rows: Array.from({ length: 12 }, (_, index) => ({ id: `bit-${index}`, title: `Bit ${index}` })),
  }
  const shortGroup = {
    source: 'bt4g',
    rows: [{ id: 'bt-0', title: 'BT 0' }, { id: 'bt-1', title: 'BT 1' }],
  }
  const filled = mergeTorrentProviders([longGroup, shortGroup], 10)
  check(
    'unused provider quota is filled by the other source',
    filled.length === 10 && filled.filter(row => row.id.startsWith('bit-')).length === 8,
  )

} finally {
  globalThis.fetch = originalFetch
  torrentCache.clear()
}

const failed = failures.length
console.log(`\n${tests.length - failed}/${tests.length} torrent checks passed`)
assert.equal(failed, 0)
