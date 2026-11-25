/**
 * Provider half — re-exported from focused modules.
 *
 * Public contract is unchanged; importers keep using `lib/providers.js`.
 */

export {
  DOUBAN_CHARTS,
  DOUBAN_CHART_IDS,
  DOUBAN_CHART_KINDS,
  doubanChartKind,
  DOUBAN_GENRES,
  DOUBAN_GENRE_SORTS,
  DOUBAN_HIDDEN_TAGS,
  DOUBAN_ANNUAL_YEARS,
  normalizeDoubanItem,
  normalizeDoubanTrendingItem,
  normalizeDoubanRecommendItem,
  searchDouban,
  fetchDoubanDetail,
  fetchDoubanChartMeta,
  listDoubanCharts,
  fetchDoubanChartItems,
  parseDoubanChartRef,
  fetchDoubanTagChartItems,
  browseDouban,
  recommendDouban,
} from './providers/douban.js'

export {
  DEFAULT_USER_AGENT,
  ProviderError,
  isTimeoutError,
  parseTmdbCredential,
  resolveTmdbCredential,
  isAllowedImageUrl,
  isDoubanHost,
} from './providers/core.js'

export {
  searchTorrentsBt4g,
  searchTorrentsBitsearch,
  searchTorrentsBitsearchPage,
  parseBt4gRss,
  parseBitsearchHtml,
} from './providers/torrents.js'

export {
  IMDB_SERIES_RELATION_CATEGORIES,
  IMDB_TRENDING_SEEDS,
  normalizeImdbItem,
  searchImdb,
  recommendImdb,
  browseImdb,
  fetchImdbSeries,
  normalizeImdbDetail,
  fetchImdbDetail,
} from './providers/imdb.js'

export {
  normalizeTmdbItem,
  normalizeTmdbBrowseItem,
  searchTmdb,
  recommendTmdb,
  browseTmdb,
  normalizeTmdbMovieDetail,
  normalizeTmdbCollection,
  fetchTmdbMovieDetail,
  fetchTmdbCollection,
} from './providers/tmdb.js'
