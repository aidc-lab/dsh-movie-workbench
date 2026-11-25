import { DOUBAN_ANNUAL_YEARS, DOUBAN_GENRES, DOUBAN_GENRE_SORTS, parseTmdbCredential, resolveTmdbCredential } from '../providers.js'
import { CHART_PAGE_SIZE, DEFAULT_LANG, MAX_BROWSE_PAGE, MAX_CHART_PAGE_SIZE, MAX_CHART_START, MAX_LANG_CHARS, MAX_TRENDING_LIMIT, SOURCES } from './config.js'
import { readHeader } from './http.js'

/**
 * Read the optional `source` parameter (default `all`).
 *
 * @param {URLSearchParams} searchParams
 * @returns {{ requested: string, source: string, valid: boolean }}
 */
export function parseSourceParam(searchParams) {
  const requested = (searchParams.get('source') || '').trim().toLowerCase()
  const source = requested || 'all'
  return { requested, source, valid: source === 'all' || SOURCES.includes(source) }
}
/**
 * Read the optional `lang` parameter (default `zh-CN`).
 *
 * @param {URLSearchParams} searchParams
 * @returns {string}
 */
export function parseLangParam(searchParams) {
  const requested = (searchParams.get('lang') || '').trim()
  return requested ? requested.slice(0, MAX_LANG_CHARS) : DEFAULT_LANG
}
/**
 * Read the optional `/trending` `limit` parameter (contract v1.2): an integer
 * 1–30 that overrides the configured `maxResults` for this request. Invalid
 * values (non-numeric, zero, negative) fall back to `maxResults`; values above
 * 30 clamp to 30.
 *
 * @param {URLSearchParams} searchParams
 * @param {number} fallback configured `maxResults`
 * @returns {number}
 */
export function parseLimitParam(searchParams, fallback) {
  const raw = (searchParams.get('limit') || '').trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  const limit = Math.floor(value)
  if (limit < 1) return fallback
  return Math.min(MAX_TRENDING_LIMIT, limit)
}
/**
 * Read the optional `/browse` `page` parameter (contract v1.6): an integer
 * 1–`MAX_BROWSE_PAGE`; omitted means page 1, anything else is invalid.
 *
 * @param {URLSearchParams} searchParams
 * @returns {number} page number, or 0 when the value is invalid
 */
export function parseBrowsePage(searchParams) {
  const raw = (searchParams.get('page') || '').trim()
  if (!raw) return 1
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_BROWSE_PAGE) return 0
  return value
}
/**
 * Read the optional `/chart` `start` parameter (contract v1.8): a non-negative
 * integer up to `MAX_CHART_START`; omitted means 0.
 *
 * @param {URLSearchParams} searchParams
 * @returns {number | null} start offset, or null when invalid
 */
/** `collection:<id>` chart ids open a title's Douban subject collection. */
export function parseDoubanCollectionChartId(value) {
  const text = String(value || '')
  if (text.indexOf('collection:') !== 0) return ''
  const raw = text.slice('collection:'.length)
  return /^[A-Za-z0-9_]{1,64}$/.test(raw) ? raw : ''
}
export function parseChartStart(searchParams) {
  const raw = (searchParams.get('start') || '').trim()
  if (!raw) return 0
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > MAX_CHART_START) return null
  return value
}
export function parseChartCount(searchParams) {
  const raw = (searchParams.get('count') || '').trim()
  if (!raw) return CHART_PAGE_SIZE
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_CHART_PAGE_SIZE) return 0
  return value
}
/**
 * Generated chart entries per kind (contract v1.11). Movie lists: 54 genre
 * charts (27 genres x 高分经典/近期热门), 27 冷门佳作 charts (one per genre) and
 * two 年度榜单 charts (高分/热门) for each configured year. TV lists: the same
 * annual and genre charts with `tv-` ids; Douban has too few TV 冷门佳片 rows,
 * so TV gets no hidden-gems family.
 * Titles and descriptions are static so `/charts` stays a single cheap request;
 * rows come from `/chart?source=douban&id=<generated id>`.
 *
 * @param {'movie' | 'tv'} kind
 * @returns {object[]}
 */
export function generatedChartCatalog(kind) {
  const charts = []
  const prefix = kind === 'tv' ? 'tv-' : ''
  const suffix = kind === 'tv' ? '剧' : '片'
  for (const genre of DOUBAN_GENRES) {
    for (const sort of DOUBAN_GENRE_SORTS) {
      charts.push({
        id: `${prefix}genre:${genre}:${sort.key}`,
        title: `${sort.label}${genre}${suffix}`,
        subtitle: '分类榜单',
        description: sort.description,
        total: null,
        cover: null,
        family: sort.key === 'S' ? 'rating' : 'heat',
        kind,
      })
    }
  }
  if (kind === 'movie') {
    for (const genre of DOUBAN_GENRES) {
      charts.push({
        id: `hidden:${genre}`,
        title: `冷门佳作 · ${genre}`,
        subtitle: '冷门佳片',
        description: '评分优先的冷门佳片',
        total: null,
        cover: null,
        family: 'hidden',
        kind,
      })
    }
  }
  for (const year of DOUBAN_ANNUAL_YEARS) {
    for (const sort of DOUBAN_GENRE_SORTS) {
      charts.push({
        id: `${prefix}year:${year}:${sort.key}`,
        title: sort.key === 'S' ? `${year} 年度高分` : `${year} 年度热门`,
        subtitle: '年度片单',
        description: sort.description,
        total: null,
        cover: null,
        family: 'annual',
        kind,
      })
    }
  }
  return charts
}
/**
 * Resolve the TMDB credential for one request: the `x-mw-tmdb-key` header
 * first, then plugin config, then `process.env.TMDB_API_KEY`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object} settings
 * @returns {{ kind: 'bearer' | 'v3', value: string } | null}
 */
export function resolveRequestCredential(req, settings) {
  const headerCredential = parseTmdbCredential(readHeader(req, 'x-mw-tmdb-key'))
  return headerCredential || resolveTmdbCredential(settings.tmdbApiKey)
}
