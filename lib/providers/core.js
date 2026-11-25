import { isIP } from 'node:net'

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
export const EXACT_IMAGE_HOSTS = new Set(['image.tmdb.org', 'm.media-amazon.com'])

/** Domain suffixes allowed for image hosts (any subdomain matches). */
export const IMAGE_HOST_SUFFIXES = ['.doubanio.com', '.douban.com']

export const ERROR_TMDB_KEY_MISSING = 'tmdb_key_missing'
export const ERROR_TMDB_UNAUTHORIZED = 'tmdb_unauthorized'
export const ERROR_UPSTREAM = 'upstream_error'

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

/**
 * Failure raised by a provider, carrying a stable contract error code.
 */
export function interleaveRows(first, second) {
  const merged = []
  const max = Math.max(first.length, second.length)
  for (let index = 0; index < max; index += 1) {
    if (index < first.length) merged.push(first[index])
    if (index < second.length) merged.push(second[index])
  }
  return merged
}
/**
 * Ask IMDb's image host for a small poster variant instead of the full still:
 * `i.imageUrl` is commonly 2-4 MiB while the `QL75_UX164` variant is ~12 KiB.
 * A URL shape this does not recognize is returned unchanged.
 *
 * @param {string} url
 * @returns {string}
 */
export function imdbThumbnail(url) {
  return url.replace(/_V1_\.(jpg|jpeg|png)$/i, '_V1_QL75_UX164_.$1')
}
/**
 * Build a contract result row with every field present.
 *
 * @param {string} source
 * @param {object} values
 * @returns {object}
 */
export function createResult(source, values) {
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
export function asString(value) {
  return typeof value === 'string' ? value : ''
}
/**
 * @param {unknown} value
 * @returns {string}
 */
export function trimString(value) {
  return asString(value).trim()
}
/**
 * @param {unknown} value
 * @returns {string}
 */
export function toId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value))
  if (typeof value === 'string') return value.trim()
  return ''
}
/**
 * @param {unknown} value
 * @returns {number | null} four-digit year or null
 */
export function toYear(value) {
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
export function toRating(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.min(10, Math.round(number * 10) / 10)
}
/**
 * @param {unknown} value
 * @returns {number | null} non-negative integer vote count or null
 */
export function toVotes(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  return Math.trunc(number)
}
/**
 * @param {unknown} value
 * @returns {string | null} allowed absolute https poster URL or null
 */
export function toPoster(value) {
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
export function toPageUrl(value, fallback) {
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
export function subjectIdFromUrl(raw) {
  const match = raw.match(/\/subject\/(\d+)/)
  return match ? match[1] : ''
}
/**
 * Map an IMDb `qid` to a contract `kind`.
 *
 * @param {string} qid
 * @returns {'movie' | 'tv' | 'other'}
 */
export function imdbKind(qid) {
  if (qid === 'tvMovie' || qid === 'tvSeries' || qid === 'tvMiniSeries') return 'tv'
  if (qid === 'movie' || qid === 'short' || qid === 'video') return 'movie'
  return 'other'
}
/**
 * @param {unknown} hostname
 * @returns {boolean}
 */
export function isIpLiteral(hostname) {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return isIP(bare) !== 0
}
/**
 * Read a text body; an unreadable body is an upstream failure.
 * @param {Response} response
 * @param {string} label
 * @returns {Promise<string>}
 */
export async function readText(response, label) {
  try {
    return await response.text()
  } catch (error) {
    if (isTimeoutError(error)) throw error
    throw new ProviderError(ERROR_UPSTREAM, `${label} returned an unreadable response.`)
  }
}
export async function readJson(response, label) {
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
export function discardBody(response) {
  try {
    if (response.body && typeof response.body.cancel === 'function') {
      const pending = response.body.cancel()
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    }
  } catch {
    /* a broken body stream is already irrelevant */
  }
}
