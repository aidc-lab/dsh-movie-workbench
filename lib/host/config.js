import { DEFAULT_USER_AGENT } from '../providers.js'

export const API_PREFIX = '/movie-workbench/api'

/** Host half version reported by `/status` (mirrors package.json). */
export const VERSION = '1.9.3'

export const DEFAULT_MAX_RESULTS = 12
export const DEFAULT_REQUEST_TIMEOUT_MS = 8000
export const DEFAULT_LANG = 'zh-CN'
export const MAX_QUERY_CHARS = 120
export const MAX_LANG_CHARS = 32
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Contract v1.2: `/trending?limit=` is an integer 1–30 (larger values clamp). */
export const MAX_TRENDING_LIMIT = 30

/** Contract v1.6: `/browse` categories, page size and page cap. */
export const BROWSE_PAGE_SIZE = 20
export const MAX_BROWSE_PAGE = 100
/** IMDb browse cursors are opaque tokens; cap them defensively. */
export const MAX_BROWSE_CURSOR_CHARS = 4096
export const BROWSE_CATEGORIES = Object.freeze({
  tmdb: Object.freeze(['trending', 'movie', 'tv']),
  imdb: Object.freeze(['featured', 'movie', 'tv']),
  douban: Object.freeze(['popular', 'movie', 'tv']),
})

/** Contract v1.8: `/charts` and `/chart` bounds (Douban official charts). */
export const CHART_PAGE_SIZE = 20
export const MAX_CHART_PAGE_SIZE = 30
export const MAX_CHART_START = 1000

/** Contract v1.3: `/torrents` providers and request bounds. */
export const TORRENT_SOURCES = ['bitsearch', 'bt4g']
export const DEFAULT_TORRENT_LIMIT = 20
export const MAX_TORRENT_LIMIT = 30
export const MAX_TORRENT_QUERY_CHARS = 160
export const MAX_TORRENT_PAGE = 20
/** Providers that can page past the first result page (BT4G's RSS has one page). */
export const TORRENT_PAGE_SOURCES = Object.freeze(['bitsearch'])
/** Scraped index pages are slower than the JSON APIs; give them a floor. */
export const TORRENT_TIMEOUT_FLOOR_MS = 15000

/** Contract v1.17: `POST /pick` bounds (AI chooses the best BT row). */
export const PICK_MAX_ROWS = 30
export const PICK_MAX_BODY_BYTES = 512 * 1024
export const PICK_LLM_TIMEOUT_MS = 45000
export const PICK_MAX_TOKENS = 3000
export const PICK_MAX_ID_CHARS = 200
export const PICK_MAX_TITLE_CHARS = 500
export const PICK_MAX_PROMPT_CHARS = 4000
export const PICK_PREFERENCE_KEYS = ['quality', 'language', 'subtitle']
export const PICK_PREFERENCE_OPTIONS = Object.freeze({
  quality: ['best', 'balanced', 'compact'],
  language: ['any', 'zh', 'en', 'ja', 'original'],
  subtitle: ['any', 'zh', 'bilingual', 'none'],
})
export const PICK_PREFERENCE_DEFAULTS = Object.freeze({ quality: 'balanced', language: 'any', subtitle: 'any' })
export const PICK_PREFERENCE_LABELS = Object.freeze({
  zh: {
    quality: { title: '画质', best: '最高画质', balanced: '均衡', compact: '小体积' },
    language: { title: '语言', any: '不限', zh: '国语/普通话', en: '英语', ja: '日语', original: '原声' },
    subtitle: { title: '字幕', any: '不限', zh: '中文字幕', bilingual: '中英双语', none: '不需要字幕' },
    priority: '用户偏好（请优先满足，无法满足时再按综合质量排序）：',
  },
  en: {
    quality: { title: 'Quality', best: 'Best quality', balanced: 'Balanced', compact: 'Small size' },
    language: { title: 'Language', any: 'Any', zh: 'Mandarin', en: 'English', ja: 'Japanese', original: 'Original audio' },
    subtitle: { title: 'Subtitles', any: 'Any', zh: 'Chinese', bilingual: 'Bilingual', none: 'None' },
    priority: 'Viewer preferences (prefer these when possible, then rank by overall quality):',
  },
})
/** Routing id for session-scoped LLM providers; picks are auxiliary calls. */
export const PICK_LLM_SESSION_ID = 'movie-workbench-pick'

/** Contract v1.18: `/models` catalog cache and bounds. */
export const MODELS_CACHE_TTL_MS = 60 * 1000
export const MODEL_LOOKUP_TIMEOUT_MS = 8000
export const MODEL_MAX_PROVIDERS = 12

/** Provider order for `source=all` (also the merge order). */
export const SOURCES = ['tmdb', 'imdb', 'douban']

export const SOURCE_LABELS = { tmdb: 'TMDB', imdb: 'IMDb', douban: 'Douban', bt4g: 'BT4G', bitsearch: 'BitSearch' }

/**
 * Resolve plugin config into a frozen, fully populated settings object.
 *
 * @param {unknown} config
 * @returns {{ maxResults: number, requestTimeoutMs: number, userAgent: string, tmdbApiKey: string }}
 */
export function normalizeSettings(config) {
  const source = config && typeof config === 'object' ? config : {}
  const maxResults =
    Number.isFinite(source.maxResults) && source.maxResults >= 1
      ? Math.floor(source.maxResults)
      : DEFAULT_MAX_RESULTS
  const requestTimeoutMs =
    Number.isFinite(source.requestTimeoutMs) && source.requestTimeoutMs >= 1
      ? Math.floor(source.requestTimeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS
  const userAgent =
    typeof source.userAgent === 'string' && source.userAgent.trim()
      ? source.userAgent.trim()
      : DEFAULT_USER_AGENT
  const tmdbApiKey = typeof source.tmdbApiKey === 'string' ? source.tmdbApiKey.trim() : ''
  return Object.freeze({ maxResults, requestTimeoutMs, userAgent, tmdbApiKey })
}
