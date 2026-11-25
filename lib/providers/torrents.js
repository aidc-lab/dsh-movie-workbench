import { DEFAULT_USER_AGENT, ERROR_UPSTREAM, ProviderError, discardBody, isTimeoutError, readText } from './core.js'

export const BT4G_RSS_URL = 'https://bt4gprx.com/search'
export const BITSEARCH_SEARCH_URL = 'https://bitsearch.to/search'
export const BITSEARCH_TORRENT_BASE_URL = 'https://bitsearch.to/torrent'

export const TORRENT_CACHE_TTL_MS = 10 * 60 * 1000
export const TORRENT_CACHE_LIMIT = 80
export const torrentCache = new Map()

export const BT4G_KEPT_CATEGORY = /movie|tv|video|anime|archive/i
export const BITSEARCH_KEPT_CATEGORY = /movie|tv|anime|video/i

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
 * Search one BitSearch result page. The site 301s to `bitsearch.eu`; redirects
 * are followed and the accessible result cards are parsed. Page 1 uses the
 * bare query URL; deeper pages append `&page=<n>`.
 *
 * @param {object} options
 * @param {string} options.query
 * @param {number} [options.page]
 * @param {number} options.timeoutMs
 * @param {string} [options.userAgent]
 * @returns {Promise<object[]>} normalized torrent rows with swarm counts
 */
export async function searchTorrentsBitsearch({ query, page = 1, timeoutMs, userAgent }) {
  const cached = readTorrentCache('bitsearch', query, page)
  if (cached) return cached
  const pageParam = page > 1 ? `&page=${page}` : ''
  const url = `${BITSEARCH_SEARCH_URL}?q=${encodeURIComponent(query)}${pageParam}`
  let lastError = null
  // BitSearch occasionally answers with a challenge shell (zero parsable cards)
  // or a transient 429/5xx; one short retry keeps the merged list complete.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const rows = await requestBitsearchPage(url, timeoutMs, userAgent)
      if (rows.length > 0) {
        writeTorrentCache('bitsearch', query, rows, page)
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
export async function requestBitsearchPage(url, timeoutMs, userAgent) {
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
export function readXmlTag(item, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(item)
  return match ? match[1].trim() : ''
}
/**
 * Read the CDATA payload of a feed item's `description`.
 * @param {string} item
 * @returns {string}
 */
export function readXmlCdata(item) {
  const match = /<description>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/description>/.exec(item)
  return match ? match[1] : ''
}
/**
 * Decode the HTML entities the two index pages use.
 * @param {string} value
 * @returns {string}
 */
export function decodeEntities(value) {
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
export function codePoint(digits, radix) {
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
export function stripTags(value) {
  return decodeEntities(String(value == null ? '' : value).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}
/**
 * Lowercased info hash from a magnet link, or ''.
 * @param {string} magnet
 * @returns {string}
 */
export function hashFromMagnet(magnet) {
  const match = /^magnet:\?xt=urn:btih:([a-z0-9]+)/i.exec(String(magnet || '').trim())
  return match ? match[1].toLowerCase() : ''
}
/**
 * @param {string} raw
 * @returns {string | null} `YYYY-MM-DD` or null
 */
export function isoDate(raw) {
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
export function toCount(raw) {
  const value = Number(String(raw || '').replace(/,/g, ''))
  return Number.isFinite(value) && value >= 0 ? value : null
}
/**
 * @param {'bt4g' | 'bitsearch'} provider
 * @param {string} query
 * @param {number} [page]
 * @returns {object[] | null}
 */
export function readTorrentCache(provider, query, page = 1) {
  const key = `${provider}|${String(query).toLowerCase()}|${page}`
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
 * @param {number} [page]
 */
export function writeTorrentCache(provider, query, rows, page = 1) {
  if (torrentCache.size >= TORRENT_CACHE_LIMIT) torrentCache.clear()
  torrentCache.set(`${provider}|${String(query).toLowerCase()}|${page}`, { at: Date.now(), rows })
}
