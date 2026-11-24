/**
 * dsh-movie-workbench — browser half.
 *
 * Registers one global panel in the left sidebar (`sidebar.panellist`, id
 * `movies-workbench`) and its page in the keyed `main` slot under the same key.
 * The page searches TMDB, IMDb and 豆瓣 through the bundle's own local
 * routes under `/movie-workbench/api` (the Host half), shows poster results
 * grouped by channel and a detail pane that links back to the source page.
 *
 * Plain browser JavaScript: no JSX, no imports besides React from the shared
 * module table, no build step.
 */
window.__ModuleLoader__.load({
  id: 'dsh-movie-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    const NS = 'movies.workbench'
    const PANEL_ID = 'movies-workbench'
    const API_BASE = '/movie-workbench/api'
    const KEY_STORAGE = 'dsh-movie-workbench.tmdb-key'
    const RECENT_STORAGE = 'dsh-movie-workbench.recent-searches'
    const SOURCES_STORAGE = 'dsh-movie-workbench.sources'
    const AI_MODEL_STORAGE = 'dsh-movie-workbench.ai-model'
    /* Earlier builds stored both values under the `movies-workbench.` prefix;
       read through to the legacy keys so an existing key and search history
       survive the rename. */
    const LEGACY_KEY_STORAGE = 'movies-workbench.tmdb-key'
    const LEGACY_RECENT_STORAGE = 'movies-workbench.recent-searches'
    const PROVIDERS = ['tmdb', 'imdb', 'douban']
    const SOURCES = ['all', 'tmdb', 'imdb', 'douban']
    const TMDB_SETTINGS_URL = 'https://www.themoviedb.org/settings/api'

    /* Channel browse categories (contract v1.6); the Host reports the same list. */
    const BROWSE_CATEGORIES = {
      tmdb: ['trending', 'movie', 'tv'],
      imdb: ['featured', 'movie', 'tv'],
      douban: ['popular', 'movie', 'tv'],
    }

    /* Douban's official charts live behind two client-only tabs; the Host
       serves them from /charts and /chart rather than /browse (contract v1.11).
       Each tab asks for one chart kind: movie lists or TV lists. */
    const DOUBAN_MOVIE_LISTS = 'movie-lists'
    const DOUBAN_TV_LISTS = 'tv-lists'
    const CHART_PAGE_SIZE = 20

    /** Chart kind a lists tab loads; null for an ordinary browse tab. */
    function listsKindFor(category) {
      if (category === DOUBAN_MOVIE_LISTS) return 'movie'
      if (category === DOUBAN_TV_LISTS) return 'tv'
      return null
    }

    const RECOMMENDATION_CARD_MIN_WIDTH = 148
    const RECOMMENDATION_CARD_GAP = 16
    const RECOMMENDATION_MAX_ITEMS = 30

    /**
     * How many titles a recommendation row needs to fill exactly two grid rows
     * at the given content width. The grid is auto-fill with 148px cards and a
     * 16px column gap, so this mirrors that arithmetic and asks the Host for
     * two rows worth of titles (clamped to its per-request limit).
     *
     * @param {number} width available row width in CSS pixels
     * @returns {number}
     */
    function recommendationLimitForWidth(width) {
      if (!Number.isFinite(width) || width <= 0) return 12
      const columns = Math.max(
        1,
        Math.floor((width + RECOMMENDATION_CARD_GAP) / (RECOMMENDATION_CARD_MIN_WIDTH + RECOMMENDATION_CARD_GAP)),
      )
      return Math.min(RECOMMENDATION_MAX_ITEMS, Math.max(2, columns * 2))
    }

    function channelCategories(source) {
      return BROWSE_CATEGORIES[source] || []
    }

    /** Tabs a channel page shows: its browse categories plus Douban's two lists. */
    function channelCategoryTabs(source) {
      const categories = channelCategories(source)
      if (source !== 'douban') return categories
      return categories.concat([DOUBAN_MOVIE_LISTS, DOUBAN_TV_LISTS])
    }

    /** Cache key for one channel category inside `session.channels`. */
    function channelCacheKey(source, category) {
      return source + '|' + category
    }

    /* ------------------------------------------------------------------ */
    /* Locale dictionaries                                                 */
    /* ------------------------------------------------------------------ */

    const ZH = {
      panel: '影视工作台',
      title: '影视工作台',
      subtitle: '跨 TMDB、IMDb、豆瓣检索电影与剧集',
      'search.placeholder': '搜索电影或剧集…',
      'search.action': '搜索',
      'search.clear': '取消搜索，回到推荐',
      'search.aria': '搜索影视作品',
      source: '渠道',
      'source.all': '全部',
      'source.tmdb': 'TMDB',
      'source.imdb': 'IMDb',
      'source.douban': '豆瓣',
      loading: '正在检索…',
      'idle.title': '从一个片名开始',
      'idle.hint': '选择渠道后输入片名，命中的结果会按渠道分组展示。',
      'recommend.tmdb': '本周趋势',
      'recommend.imdb': '精选作品',
      'recommend.douban': '热门推荐',
      'recommend.loading': '正在加载推荐…',
      'recommend.failed': '推荐加载失败',
      'recommend.refresh': '刷新',
      'refresh.action': '刷新',
      'recommend.retry': '重试',
      'recommend.empty': '暂无推荐',
      'recommend.more': '查看全部',
      'recommend.back': '返回推荐',
      'browse.trending': '本周趋势',
      'browse.featured': '精选作品',
      'browse.popular': '热门推荐',
      'browse.movie': '电影',
      'browse.tv': '剧集',
      'browse.tabs': '浏览分类',
      'browse.loadMore': '加载更多',
      'browse.loadingMore': '正在加载…',
      'browse.end': '没有更多了',
      'browse.moreFailed': '加载更多失败',
      'browse.movie-lists': '电影榜单',
      'browse.tv-lists': '剧集榜单',
      'lists.official': '官方榜单',
      'lists.annual': '年度榜单',
      'lists.hidden': '冷门佳作',
      'lists.rating': '高分经典',
      'lists.heat': '近期热门',
      'chart.back': '返回片单',
      'chart.count': '共 {count} 部',
      'chart.loading': '正在加载片单…',
      'chart.failed': '片单加载失败',
      'chart.empty': '该榜单暂时没有内容',
      'torrent.aiPick': 'AI 选资源',
      'torrent.aiPicking': 'AI 正在挑选资源…',
      'torrent.aiFailed': 'AI 挑选失败',
      'torrent.aiUnavailable': '当前环境未启用 AI 服务',
      'torrent.aiNoModel': '未配置可用的 AI 模型',
      'torrent.aiRecommend': 'AI 推荐',
      'torrent.aiNoPick': 'AI 没有给出明确推荐',
      'torrent.title': 'BT 资源',
      'torrent.note': '来自公开 BT 索引，仅供检索，请自行判断内容合法性',
      'torrent.loading': '正在搜索 BT 资源…',
      'torrent.loadMore': '加载更多',
      'torrent.loadingMore': '正在加载…',
      'torrent.moreFailed': '加载更多失败',
      'torrent.end': '没有更多了',
      'torrent.empty': '没有找到相关 BT 资源',
      'torrent.failed': 'BT 资源搜索失败',
      'torrent.retry': '重试',
      'torrent.copy': '复制',
      'torrent.sort.label': '排序',
      'torrent.sort.default': '默认',
      'torrent.sort.seeders': '做种',
      'torrent.sort.leechers': '下载',
      'torrent.sort.size': '大小',
      'torrent.sort.asc': '升序',
      'torrent.sort.desc': '降序',
      'torrent.copied': '已复制',
      'torrent.copyFailed': '复制失败',
      'torrent.page': '详情',
      'torrent.seeders': '做种 {count}',
      'torrent.leechers': '下载 {count}',
      'torrent.searchOn': '在 {site} 搜索',
      'recent.title': '最近搜索',
      'recent.clear': '清除记录',
      'results.count': '显示 {count} 部作品',
      'results.empty.title': '没有找到相关作品',
      'results.empty.hint': '换一个片名、试试英文原名，或切到「全部」渠道再检索。',
      'results.took': '耗时 {ms} ms',
      'error.title': '检索失败',
      'error.retry': '重试',
      'error.network': '无法连接本地插件接口，请确认插件已启用后重试。',
      'error.empty_query': '请输入片名后再搜索。',
      'error.bad_source': '这个渠道暂不支持。',
      'error.tmdb_key_missing': 'TMDB 需要 API Key，点右上角的钥匙图标填写。',
      'error.tmdb_unauthorized': 'TMDB Key 无效或已过期，请重新填写。',
      'error.upstream_error': '上游接口暂时不可用，请稍后重试。',
      'error.timeout': '请求超时，请稍后重试。',
      'error.internal_error': '插件内部错误，请稍后重试。',
      'notice.setKey': '设置 Key',
      'detail.back': '返回结果',
      'detail.overview': '简介',
      'detail.overviewLoading': '简介加载中…',
      'detail.noOverview': '该渠道没有提供简介。',
      'detail.open': '在 {source} 查看',
      'collection.label': '所属合集',
      'collection.loading': '正在加载合集…',
      'collection.failed': '合集加载失败',
      'collection.empty': '该合集暂时没有可展示的作品',
      'collection.back': '返回详情',
      'collection.count': '共 {count} 部作品',
      'collection.note': '共 {count} 部作品',
      'series.label': '相关系列',
      'series.loading': '正在加载相关系列…',
      'series.failed': '相关系列加载失败',
      'series.empty': '暂无相关系列',
      'series.back': '返回详情',
      'series.count': '共 {count} 部作品',
      'series.truncated': '关系过多，仅展示前 {count} 部',
      'rankings.label': '收录于榜单',
      'chart.backDetail': '返回详情',
      'detail.rating': '评分',
      'detail.votes': '{count} 人评分',
      'kind.movie': '电影',
      'kind.tv': '剧集',
      'kind.short': '短片',
      'kind.other': '其他',
      'key.button': 'TMDB Key',
      'key.title': 'TMDB API Key',
      'key.hint': '只保存在本机浏览器。可在 TMDB 账户设置里创建 API Key（v3）或读取令牌（v4）。',
      'key.placeholder': '粘贴 v3 Key 或 v4 令牌',
      'key.save': '保存',
      'key.clear': '清除',
      'key.saved': 'TMDB Key 已保存到本机浏览器。',
      'key.server': '服务端已配置 Key，本机留空即可使用。',
      'key.local': '正在使用本机 Key。',
      'key.open': '打开 TMDB 设置',
      'settings.button': '数据源设置',
      'settings.title': '数据源',
      'settings.sourcesHint': '关闭后该数据源不再出现在推荐、筛选项和搜索结果中。',
      'settings.toggle': '切换 {source} 数据源',
      'settings.lastSource': '至少保留一个数据源。',
      'settings.defaultModel': '默认模型',
      'settings.usage': '用途',
      'settings.modelColumn': '模型',
      'settings.aiPickUsage': 'AI 选资源',
      'settings.aiModelLoading': '正在读取可用模型…',
      'settings.aiModelEmpty': '当前 Profile 没有可选的模型。',
      'settings.aiModelFailed': '读取模型列表失败',
      'settings.aiModelRetry': '重试',
      'aiDialog.title': 'AI 选资源',
      'aiDialog.close': '关闭',
      'aiDialog.prefs': '选择倾向',
      'aiDialog.quality': '画质',
      'aiDialog.quality.best': '最高画质',
      'aiDialog.quality.balanced': '均衡',
      'aiDialog.quality.compact': '小体积',
      'aiDialog.language': '语言',
      'aiDialog.language.any': '不限',
      'aiDialog.language.zh': '国语',
      'aiDialog.language.en': '英语',
      'aiDialog.language.ja': '日语',
      'aiDialog.language.original': '原声',
      'aiDialog.subtitle': '字幕',
      'aiDialog.subtitle.any': '不限',
      'aiDialog.subtitle.zh': '中文字幕',
      'aiDialog.subtitle.bilingual': '中英双语',
      'aiDialog.subtitle.none': '不需要',
      'aiDialog.modeSimple': '简单模式',
      'aiDialog.modeFree': '自由模式',
      'aiDialog.freeHint': '可直接编辑发送给模型的提示词，并查看模型的原始输出。',
      'aiDialog.prefSummary': '当前偏好：{summary}',
      'aiDialog.prompt': '提示词',
      'aiDialog.promptPlaceholder': '留空则使用默认提示词（含候选项）。',
      'aiDialog.promptLoading': '正在生成默认提示词…',
      'aiDialog.promptFailed': '提示词生成失败',
      'aiDialog.resetPrompt': '恢复默认',
      'aiDialog.raw': '模型原始输出',
      'aiDialog.running': '模型正在比较这些资源…',
      'aiDialog.elapsed': '已用时 {seconds} 秒',
      'aiDialog.modelLabel': '模型',
      'aiDialog.modelLoading': '正在加载模型…',
      'aiDialog.modelHint': '切换评估使用的模型',
      'aiDialog.modelEmpty': '暂无可用模型',
      'aiDialog.defaultModel': '跟随默认模型',
      'aiDialog.result': '推荐结果',
      'aiDialog.reason': '推荐理由',
      'aiDialog.failed': '挑选失败',
      'aiDialog.retry': '重新挑选',
      'aiDialog.unavailable': '当前环境未启用 AI 服务',
      'aiDialog.noModel': '未配置可用的 AI 模型',
      'aiDialog.noPick': 'AI 没有给出明确推荐',
      'aiDialog.overlayClose': '关闭弹窗',
      'aiDialog.start': '开始评估',
      'aiDialog.reevaluate': '重新评估',
      'aiDialog.intro': 'AI 会综合做种数、体积、画质与来源可靠性，从这些候选资源中挑出一个更值得下载的。',
      'aiDialog.interrupted': '上次评估已中断，请重新评估。',
      'aria.results': '检索结果',
      'aria.group': '{source}的结果',
    }

    const EN = {
      panel: 'Movies workbench',
      title: 'Movies workbench',
      subtitle: 'Search film and TV across TMDB, IMDb and 豆瓣',
      'search.placeholder': 'Search a film or series…',
      'search.action': 'Search',
      'search.clear': 'Cancel the search and return to recommendations',
      'search.aria': 'Search films and TV',
      source: 'Channel',
      'source.all': 'All',
      'source.tmdb': 'TMDB',
      'source.imdb': 'IMDb',
      'source.douban': '豆瓣',
      loading: 'Searching…',
      'idle.title': 'Start with a title',
      'idle.hint': 'Pick a channel and type a title; matching results are grouped by channel.',
      'recommend.tmdb': 'Trending this week',
      'recommend.imdb': 'Editor picks',
      'recommend.douban': 'Popular now',
      'recommend.loading': 'Loading recommendations…',
      'recommend.failed': 'Recommendations unavailable',
      'recommend.refresh': 'Refresh',
      'refresh.action': 'Refresh',
      'recommend.retry': 'Retry',
      'recommend.empty': 'No recommendations',
      'recommend.more': 'See all',
      'recommend.back': 'Back to recommendations',
      'browse.trending': 'This week',
      'browse.featured': 'Featured',
      'browse.popular': 'Popular',
      'browse.movie': 'Movies',
      'browse.tv': 'TV',
      'browse.tabs': 'Browse categories',
      'browse.loadMore': 'Load more',
      'browse.loadingMore': 'Loading more…',
      'browse.end': 'No more titles',
      'browse.moreFailed': 'Could not load more',
      'browse.movie-lists': 'Movie charts',
      'browse.tv-lists': 'TV charts',
      'lists.official': 'Official charts',
      'lists.annual': 'Annual',
      'lists.hidden': 'Hidden gems',
      'lists.rating': 'High-score classics',
      'lists.heat': 'Recent hits',
      'chart.back': 'Back to lists',
      'chart.count': '{count} titles',
      'chart.loading': 'Loading lists…',
      'chart.failed': 'Could not load lists',
      'chart.empty': 'This chart is empty',
      'torrent.aiPick': 'Pick with AI',
      'torrent.aiPicking': 'AI is picking a torrent…',
      'torrent.aiFailed': 'AI pick failed',
      'torrent.aiUnavailable': 'The AI service is not available here',
      'torrent.aiNoModel': 'No AI model is configured',
      'torrent.aiRecommend': 'AI pick',
      'torrent.aiNoPick': 'The model did not pick a torrent',
      'torrent.title': 'BT resources',
      'torrent.note': 'From public torrent indexes; search only — check legality yourself',
      'torrent.loading': 'Searching torrent indexes…',
      'torrent.loadMore': 'Load more',
      'torrent.loadingMore': 'Loading more…',
      'torrent.moreFailed': 'Could not load more',
      'torrent.end': 'No more results',
      'torrent.empty': 'No BT resources found',
      'torrent.failed': 'Torrent search failed',
      'torrent.retry': 'Retry',
      'torrent.copy': 'Copy',
      'torrent.sort.label': 'Sort',
      'torrent.sort.default': 'Default',
      'torrent.sort.seeders': 'Seeders',
      'torrent.sort.leechers': 'Leechers',
      'torrent.sort.size': 'Size',
      'torrent.sort.asc': 'Ascending',
      'torrent.sort.desc': 'Descending',
      'torrent.copied': 'Copied',
      'torrent.copyFailed': 'Copy failed',
      'torrent.page': 'Details',
      'torrent.seeders': '{count} seeders',
      'torrent.leechers': '{count} leechers',
      'torrent.searchOn': 'Search on {site}',
      'recent.title': 'Recent searches',
      'recent.clear': 'Clear',
      'results.count': '{count} titles shown',
      'results.empty.title': 'No matching titles',
      'results.empty.hint': 'Try another title, the original-language name, or the All channel.',
      'results.took': '{ms} ms',
      'error.title': 'Search failed',
      'error.retry': 'Retry',
      'error.network': 'The local plugin route is unreachable. Check that the plugin is enabled.',
      'error.empty_query': 'Enter a title before searching.',
      'error.bad_source': 'That channel is not supported.',
      'error.tmdb_key_missing': 'TMDB needs an API key. Use the key control in the page header.',
      'error.tmdb_unauthorized': 'The TMDB key is invalid or expired. Enter it again.',
      'error.upstream_error': 'The upstream endpoint is unavailable right now.',
      'error.timeout': 'The request timed out. Try again.',
      'error.internal_error': 'The plugin hit an internal error. Try again.',
      'notice.setKey': 'Set key',
      'detail.back': 'Back to results',
      'detail.overview': 'Overview',
      'detail.overviewLoading': 'Loading overview…',
      'detail.noOverview': 'This channel returned no overview.',
      'detail.open': 'Open on {source}',
      'collection.label': 'Collection',
      'collection.loading': 'Loading collection…',
      'collection.failed': 'Could not load the collection',
      'collection.empty': 'This collection has no titles yet',
      'collection.back': 'Back to title',
      'collection.count': '{count} titles',
      'collection.note': '{count} titles',
      'series.label': 'Related titles',
      'series.loading': 'Loading related titles…',
      'series.failed': 'Could not load related titles',
      'series.empty': 'No related titles found',
      'series.back': 'Back to title',
      'series.count': '{count} titles',
      'series.truncated': 'Only the first {count} related titles are shown',
      'rankings.label': 'Featured in charts',
      'chart.backDetail': 'Back to title',
      'detail.rating': 'Rating',
      'detail.votes': '{count} votes',
      'kind.movie': 'Film',
      'kind.tv': 'Series',
      'kind.short': 'Short',
      'kind.other': 'Other',
      'key.button': 'TMDB key',
      'key.title': 'TMDB API key',
      'key.hint': 'Stored in this browser only. Create an API key (v3) or read your API read access token (v4) in your TMDB account settings.',
      'key.placeholder': 'Paste a v3 key or v4 token',
      'key.save': 'Save',
      'key.clear': 'Clear',
      'key.saved': 'TMDB key saved in this browser.',
      'key.server': 'A server-side key is configured; leave this empty to use it.',
      'key.local': 'Using the key from this browser.',
      'key.open': 'Open TMDB settings',
      'settings.button': 'Data sources',
      'settings.title': 'Data sources',
      'settings.sourcesHint': 'A disabled source is hidden from recommendations, filters and search results.',
      'settings.toggle': 'Toggle the {source} source',
      'settings.lastSource': 'Keep at least one source enabled.',
      'settings.defaultModel': 'Default model',
      'settings.usage': 'Usage',
      'settings.modelColumn': 'Model',
      'settings.aiPickUsage': 'AI pick',
      'settings.aiModelLoading': 'Loading available models…',
      'settings.aiModelEmpty': 'This profile has no selectable model.',
      'settings.aiModelFailed': 'Could not load the model list',
      'settings.aiModelRetry': 'Retry',
      'aiDialog.title': 'AI torrent pick',
      'aiDialog.close': 'Close',
      'aiDialog.prefs': 'Preferences',
      'aiDialog.quality': 'Quality',
      'aiDialog.quality.best': 'Best quality',
      'aiDialog.quality.balanced': 'Balanced',
      'aiDialog.quality.compact': 'Small size',
      'aiDialog.language': 'Language',
      'aiDialog.language.any': 'Any',
      'aiDialog.language.zh': 'Mandarin',
      'aiDialog.language.en': 'English',
      'aiDialog.language.ja': 'Japanese',
      'aiDialog.language.original': 'Original audio',
      'aiDialog.subtitle': 'Subtitles',
      'aiDialog.subtitle.any': 'Any',
      'aiDialog.subtitle.zh': 'Chinese',
      'aiDialog.subtitle.bilingual': 'Bilingual',
      'aiDialog.subtitle.none': 'None',
      'aiDialog.modeSimple': 'Simple',
      'aiDialog.modeFree': 'Free mode',
      'aiDialog.freeHint': 'Edit the prompt sent to the model and inspect its raw output.',
      'aiDialog.prefSummary': 'Preferences: {summary}',
      'aiDialog.prompt': 'Prompt',
      'aiDialog.promptPlaceholder': 'Leave empty to use the default prompt (includes the candidates).',
      'aiDialog.promptLoading': 'Building the default prompt…',
      'aiDialog.promptFailed': 'Could not build the prompt',
      'aiDialog.resetPrompt': 'Reset',
      'aiDialog.raw': 'Raw model output',
      'aiDialog.running': 'The model is comparing these torrents…',
      'aiDialog.elapsed': '{seconds}s elapsed',
      'aiDialog.modelLabel': 'Model',
      'aiDialog.modelLoading': 'Loading models…',
      'aiDialog.modelHint': 'Change the model used for the evaluation',
      'aiDialog.modelEmpty': 'No models available',
      'aiDialog.defaultModel': 'Profile default',
      'aiDialog.result': 'Result',
      'aiDialog.reason': 'Reason',
      'aiDialog.failed': 'Pick failed',
      'aiDialog.retry': 'Pick again',
      'aiDialog.unavailable': 'The AI service is not available here',
      'aiDialog.noModel': 'No AI model is configured',
      'aiDialog.noPick': 'The model did not pick a torrent',
      'aiDialog.overlayClose': 'Close the dialog',
      'aiDialog.start': 'Start evaluation',
      'aiDialog.reevaluate': 'Evaluate again',
      'aiDialog.intro': 'The AI compares seeders, size, quality and index reliability to pick the most worthwhile torrent.',
      'aiDialog.interrupted': 'The last evaluation was interrupted. Please evaluate again.',
      'aria.results': 'Search results',
      'aria.group': 'Results from {source}',
    }

    /* ------------------------------------------------------------------ */
    /* Small helpers                                                       */
    /* ------------------------------------------------------------------ */

    function readStorage(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null || raw === '') return fallback
        const parsed = JSON.parse(raw)
        return parsed === null || parsed === undefined ? fallback : parsed
      } catch (error) {
        return fallback
      }
    }

    function writeStorage(key, value) {
      try {
        if (value === null || value === undefined || value === '') window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, JSON.stringify(value))
      } catch (error) {
        /* A browser with storage disabled still gets a working panel. */
      }
    }

    function readStorageMigrating(key, legacyKey, fallback) {
      const current = readStorage(key, null)
      if (current !== null) return current
      const legacy = readStorage(legacyKey, null)
      if (legacy === null) return fallback
      writeStorage(key, legacy)
      return legacy
    }

    function readTmdbKey() {
      const value = readStorageMigrating(KEY_STORAGE, LEGACY_KEY_STORAGE, '')
      return typeof value === 'string' ? value : ''
    }

    function readRecent() {
      const value = readStorageMigrating(RECENT_STORAGE, LEGACY_RECENT_STORAGE, [])
      if (!Array.isArray(value)) return []
      return value.filter(item => typeof item === 'string' && item.trim() !== '').slice(0, 6)
    }

    /** Enabled data sources; a missing entry means "on", so new sources default on. */
    function readAiModelPrefs() {
      const value = readStorage(AI_MODEL_STORAGE, null)
      if (!value || typeof value !== 'object') return null
      const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
      const model = typeof value.model === 'string' ? value.model.trim() : ''
      return provider && model ? { provider: provider, model: model } : null
    }

    const AI_PICK_PREFS_STORAGE = 'dsh-movie-workbench.ai-prefs'
    const AI_FREE_STORAGE = 'dsh-movie-workbench.ai-free'
    const AI_PICK_PREF_VALUES = {
      quality: ['best', 'balanced', 'compact'],
      language: ['any', 'zh', 'en', 'ja', 'original'],
      subtitle: ['any', 'zh', 'bilingual', 'none'],
    }
    const AI_PICK_PREF_DEFAULTS = { quality: 'balanced', language: 'any', subtitle: 'any' }

    /** Viewer preferences for the AI picker; unknown/missing values fall back. */
    function readAiPickPrefs() {
      const value = readStorage(AI_PICK_PREFS_STORAGE, null)
      const prefs = { ...AI_PICK_PREF_DEFAULTS }
      if (!value || typeof value !== 'object') return prefs
      Object.keys(AI_PICK_PREF_DEFAULTS).forEach(key => {
        if (typeof value[key] === 'string' && AI_PICK_PREF_VALUES[key].indexOf(value[key]) !== -1) prefs[key] = value[key]
      })
      return prefs
    }

    function writeAiPickPrefs(next) {
      writeStorage(AI_PICK_PREFS_STORAGE, next)
    }

    function readAiFreeMode() {
      return readStorage(AI_FREE_STORAGE, false) === true
    }

    function writeAiFreeMode(value) {
      writeStorage(AI_FREE_STORAGE, Boolean(value))
    }

    function readSourcePrefs() {
      const fallback = { tmdb: true, imdb: true, douban: true }
      const value = readStorage(SOURCES_STORAGE, null)
      if (!value || typeof value !== 'object') return fallback
      const next = {}
      PROVIDERS.forEach(provider => {
        next[provider] = value[provider] !== false
      })
      return next
    }

    function languageForSearch(locale) {
      const id = typeof locale === 'string' ? locale.toLowerCase() : ''
      return id.indexOf('zh') === 0 ? 'zh-CN' : 'en-US'
    }

    function searchKey(item) {
      return item.source + '|' + item.id
    }

    function posterUrl(url) {
      return url ? API_BASE + '/image?url=' + encodeURIComponent(url) : ''
    }

    const SIZE_UNITS = {
      b: 1,
      kb: 1000,
      mb: 1000 * 1000,
      gb: 1000 * 1000 * 1000,
      tb: 1000 * 1000 * 1000 * 1000,
      kib: 1024,
      mib: 1024 * 1024,
      gib: 1024 * 1024 * 1024,
      tib: 1024 * 1024 * 1024 * 1024,
    }

    /** "2.87 GB" / "65.95GB" -> bytes, or null when the string is unparseable. */
    function sizeToBytes(size) {
      if (typeof size !== 'string') return null
      const match = /^([\d.]+)\s*([kmgt]?i?b)$/i.exec(size.trim())
      if (!match) return null
      const value = Number(match[1])
      const unit = SIZE_UNITS[match[2].toLowerCase()]
      if (!Number.isFinite(value) || !unit) return null
      return value * unit
    }

    function kindLabel(t, kind) {
      if (kind === 'movie') return t('kind.movie')
      if (kind === 'tv') return t('kind.tv')
      if (kind === 'short') return t('kind.short')
      return t('kind.other')
    }

    function sourceLabel(t, source) {
      return t('source.' + source)
    }

    function failureText(t, code) {
      const known = t('error.' + code)
      return known === 'error.' + code ? t('error.internal_error') : known
    }

    /** One-to-one call to the bundle's local routes; throws `{ code }` failures. */
    async function callApi(path, options) {
      let response
      try {
        response = await fetch(API_BASE + path, options)
      } catch (error) {
        throw failure('network')
      }
      let body = null
      try {
        body = await response.json()
      } catch (error) {
        body = null
      }
      if (!response.ok || !body || body.ok !== true) {
        const code = body && typeof body.code === 'string' ? body.code : 'network'
        throw failure(code)
      }
      return body
    }

    function failure(code) {
      const error = new Error(code)
      error.code = code
      return error
    }

    /* Generated charts (year / hidden / genre) carry no catalog cover, so the
       first title's poster is fetched lazily and reused as the card cover.
       Requests are coalesced per chart id and limited so a long 片单 catalog
       does not burst the Host. */
    const chartCoverCache = new Map()
    const chartCoverPending = new Map()
    const CHART_COVER_CONCURRENCY = 4
    let chartCoverActive = 0
    const chartCoverQueue = []

    function runChartCoverTask(task) {
      chartCoverActive += 1
      Promise.resolve()
        .then(task)
        .catch(() => {})
        .finally(() => {
          chartCoverActive -= 1
          const next = chartCoverQueue.shift()
          if (next) runChartCoverTask(next)
        })
    }

    function chartCoverFor(chartId) {
      if (chartCoverCache.has(chartId)) return Promise.resolve(chartCoverCache.get(chartId))
      if (chartCoverPending.has(chartId)) return chartCoverPending.get(chartId)
      const promise = new Promise(resolve => {
        /* Ask for a few rows: genre charts prepend an announcement card that
           the Host filters out, so count=1 can come back empty. */
        const task = () => callApi(
          '/chart?source=douban&id=' + encodeURIComponent(chartId) + '&start=0&count=3',
        )
          .then(body => {
            const items = Array.isArray(body.items) ? body.items : []
            const first = items.find(item => item && typeof item.poster === 'string' && item.poster)
            const cover = first ? first.poster : ''
            chartCoverCache.set(chartId, cover)
            resolve(cover)
          })
          .catch(() => {
            /* A failed cover request should not retry on every render. */
            chartCoverCache.set(chartId, '')
            resolve('')
          })
          .finally(() => chartCoverPending.delete(chartId))
        const start = () => runChartCoverTask(task)
        if (chartCoverActive >= CHART_COVER_CONCURRENCY) chartCoverQueue.push(start)
        else start()
      })
      chartCoverPending.set(chartId, promise)
      return promise
    }

    /* ------------------------------------------------------------------ */
    /* Glyphs                                                              */
    /* ------------------------------------------------------------------ */

    const SVG = { display: 'block', flex: 'none' }

    function PanelIcon(props) {
      const size = props.size || 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          style: SVG,
          'aria-hidden': 'true',
        },
        h('rect', {
          x: 2.7, y: 8.1, width: 18.6, height: 11.4, rx: 2.2,
          stroke: 'currentColor', strokeWidth: 1.5,
        }),
        h('path', {
          d: 'M3.2 4.4 20.5 1.9l.55 3.5L3.75 7.9 3.2 4.4Z',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round',
        }),
        h('path', { d: 'm10.1 11.6 5.2 3.1-5.2 3.1v-6.2Z', fill: 'currentColor' }),
      )
    }

    function GlyphSearch(props) {
      const size = props.size || 16
      return h(
        'svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', style: SVG, 'aria-hidden': 'true' },
        h('circle', { cx: 10.5, cy: 10.5, r: 6.5, stroke: 'currentColor', strokeWidth: 1.8 }),
        h('path', { d: 'm15.6 15.6 4.4 4.4', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
      )
    }

    function GlyphKey(props) {
      const size = props.size || 17
      return h(
        'svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', style: SVG, 'aria-hidden': 'true' },
        h('circle', { cx: 8.1, cy: 9.2, r: 4.3, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('circle', { cx: 8.1, cy: 9.2, r: 1.5, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M12.4 9.2h7.9', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M16.4 9.2v3.1M19.9 9.2v2.4', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      )
    }

    function GlyphGear(props) {
      const size = props.size || 17
      return h(
        'svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', style: SVG, 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 12, r: 3.2, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', {
          d: 'M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.5-2.4 1a7.7 7.7 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.7 7.7 0 0 0 7 6.5l-2.4-1-2 3.5 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a7.7 7.7 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.7 7.7 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5Z',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round',
        }),
      )
    }

    function GlyphChevronLeft(props) {
      const size = props.size || 16
      return h(
        'svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', style: SVG, 'aria-hidden': 'true' },
        h('path', { d: 'M14.5 5.5 8 12l6.5 6.5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function GlyphChevronRight(props) {
      const size = props.size || 13
      return h(
        'svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', style: SVG, 'aria-hidden': 'true' },
        h('path', { d: 'm9.5 5.5 6.5 6.5-6.5 6.5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function GlyphChevronDown(props) {
      const size = props.size || 14
      return h(
        'svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', style: SVG, 'aria-hidden': 'true' },
        h('path', { d: 'm5.5 9.5 6.5 6.5 6.5-6.5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function GlyphClear(props) {
      const size = props.size || 14
      return h(
        'svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', style: SVG, 'aria-hidden': 'true' },
        h('path', { d: 'M7 7l10 10M17 7 7 17', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
      )
    }

    function GlyphSparkle(props) {
      const size = props.size || 14
      return h(
        'svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', style: SVG, 'aria-hidden': 'true' },
        h('path', { d: 'M11 3.5c.5 3.7 2.5 5.7 6.2 6.2-3.7.5-5.7 2.5-6.2 6.2-.5-3.7-2.5-5.7-6.2-6.2 3.7-.5 5.7-2.5 6.2-6.2Z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        h('path', { d: 'M18 14.5c.3 1.7 1.3 2.7 3 3-1.7.3-2.7 1.3-3 3-.3-1.7-1.3-2.7-3-3 1.7-.3 2.7-1.3 3-3Z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
      )
    }

    function GlyphRefresh(props) {
      const size = props.size || 16
      return h(
        'svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', style: SVG, 'aria-hidden': 'true' },
        h('path', { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M19.8 4.4v4.2h-4.2', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function GlyphWarning(props) {
      const size = props.size || 16
      return h(
        'svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', style: SVG, 'aria-hidden': 'true' },
        h('path', { d: 'M12 3.6 21.4 20H2.6L12 3.6Z', stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round' }),
        h('path', { d: 'M12 9.4v4.6', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('circle', { cx: 12, cy: 17, r: 1, fill: 'currentColor' }),
      )
    }

    function GlyphStar(props) {
      const size = props.size || 13
      return h(
        'svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'currentColor', style: SVG, 'aria-hidden': 'true' },
        h('path', { d: 'm12 2.6 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5L2.5 9.5l6.6-.9 2.9-6Z' }),
      )
    }

    function GlyphExternal(props) {
      const size = props.size || 14
      return h(
        'svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', style: SVG, 'aria-hidden': 'true' },
        h('path', { d: 'M13.5 4.5h6v6', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M19.5 4.5 11 13', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M19 13.8v4.7a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V6.6a1.8 1.8 0 0 1 1.8-1.8h4.8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      )
    }

    /** Large decorative mark for empty/placeholder surfaces. */
    function GlyphClapper(props) {
      const size = props.size || 48
      return h(
        'svg', { width: size, height: size, viewBox: '0 0 48 48', fill: 'none', style: SVG, 'aria-hidden': 'true' },
        h('rect', { x: 6, y: 18, width: 36, height: 22, rx: 4, stroke: 'currentColor', strokeWidth: 2.2 }),
        h('path', { d: 'M7 8.6 41.4 3.3l1.1 6.4L8.1 15 7 8.6Z', stroke: 'currentColor', strokeWidth: 2.2, strokeLinejoin: 'round' }),
        h('path', { d: 'm20.6 24.4 9.2 5.5-9.2 5.5v-11Z', fill: 'currentColor' }),
        h('circle', { cx: 12.4, cy: 24.6, r: 1.5, fill: 'currentColor', fillOpacity: 0.7 }),
        h('circle', { cx: 12.4, cy: 33.4, r: 1.5, fill: 'currentColor', fillOpacity: 0.7 }),
        h('circle', { cx: 35.6, cy: 24.6, r: 1.5, fill: 'currentColor', fillOpacity: 0.7 }),
        h('circle', { cx: 35.6, cy: 33.4, r: 1.5, fill: 'currentColor', fillOpacity: 0.7 }),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = [
      '.mw-page{display:flex;flex-direction:column;height:100%;flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.55;font-family:inherit;}',
      '.mw-page,.mw-page *{box-sizing:border-box;}',
      '.mw-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}',
      '.mw-page :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,transparent);outline-offset:2px;border-radius:6px;}',
      '.mw-head{flex:none;padding:calc(24px + var(--dsh-frame-top-clearance,0px)) clamp(20px,3vw,40px) 0;}',
      '.mw-head-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:0 auto;width:100%;}',
      '.mw-heading{min-width:0;}',
      '.mw-title{margin:0;font-size:19px;line-height:26px;font-weight:600;letter-spacing:-0.01em;}',
      '.mw-subtitle{margin:3px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.mw-head-actions{display:flex;align-items:center;gap:8px;flex:none;}',
      '.mw-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border-radius:10px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .15s ease,background-color .15s ease;}',
      '.mw-icon-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));}',
      '.mw-icon-btn[data-active="true"]{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);}',
      '.mw-toolbar{flex:none;padding:14px clamp(20px,3vw,40px) 0;}',
      '.mw-toolbar-inner{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 auto;}',
      '.mw-search{display:flex;align-items:center;gap:8px;flex:1 1 320px;min-width:220px;}',
      '.mw-search-field{position:relative;display:flex;align-items:center;flex:1;min-width:0;height:40px;padding:0 38px 0 38px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);transition:border-color .15s ease,box-shadow .15s ease;}',
      '.mw-search-field:hover{border-color:var(--dsw-alias-border-l2);}',
      '.mw-search-field:focus-within{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);}',
      '.mw-search-glyph{position:absolute;left:13px;display:flex;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));pointer-events:none;}',
      '.mw-search-clear{position:absolute;right:7px;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .15s ease,background-color .15s ease;}',
      '.mw-search-clear:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));}',
      '.mw-input{width:100%;height:100%;box-sizing:border-box;padding:0;border:0;border-radius:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;}',
      '.mw-input::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}',
      '.mw-input:hover{outline:none;}',
      '.mw-input:focus{outline:none;}',
      '.mw-input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none;display:none;}',
      '.mw-submit{display:inline-flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;padding:0;border:0;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);cursor:pointer;transition:background-color .15s ease,color .15s ease,opacity .15s ease;}',
      '.mw-submit:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent);}',
      '.mw-submit:disabled{opacity:.45;cursor:default;}',
      '.mw-refresh{display:inline-flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .15s ease,border-color .15s ease,background-color .15s ease,opacity .15s ease;}',
      '.mw-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);}',
      '.mw-refresh:disabled{opacity:.45;cursor:default;}',
      '.mw-spinner{width:15px;height:15px;border-radius:50%;border:1.8px solid currentColor;border-top-color:transparent;animation:mw-spin .7s linear infinite;}',
      '@keyframes mw-spin{to{transform:rotate(360deg);}}',
      '@media (prefers-reduced-motion:reduce){.mw-spinner{animation:none;opacity:.6;}}',
      '.mw-chip{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer;transition:color .15s ease,border-color .15s ease,background-color .15s ease;}',
      '.mw-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}',
      '.mw-source-select{display:inline-flex;align-items:center;gap:7px;flex:none;margin-left:2px;}',
      '.mw-source-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);}',
      '.mw-select-wrap{position:relative;display:inline-flex;align-items:center;}',
      '.mw-select{appearance:none;-webkit-appearance:none;height:40px;box-sizing:border-box;padding:0 34px 0 13px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:border-color .15s ease,background-color .15s ease;}',
      '.mw-select:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);}',
      '.mw-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
      '.mw-select option{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
      '.mw-select-chevron{position:absolute;right:11px;display:flex;color:var(--dsw-alias-label-secondary);pointer-events:none;}',
      '.mw-notices{flex:none;padding:12px clamp(20px,3vw,40px) 0;}',
      '.mw-notices-inner{display:flex;flex-direction:column;gap:6px;margin:0 auto;}',
      '.mw-notice{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:10px;border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);color:var(--dsw-alias-label-primary);font-size:13px;}',
      '.mw-notice-glyph{display:flex;color:var(--dsw-alias-state-warn-primary);}',
      '.mw-notice-text{flex:1;min-width:0;}',
      '.mw-notice-source{font-weight:500;margin-right:6px;}',
      '.mw-link-btn{padding:0;border:0;background:none;color:var(--dsw-alias-link,var(--dsw-alias-brand-primary));font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;}',
      '.mw-link-btn:hover{text-decoration:underline;}',
      '.mw-body{position:relative;display:flex;flex:1;min-height:0;gap:20px;width:100%;margin:0 auto;padding:18px clamp(20px,3vw,40px) 0;}',
      '.mw-results{flex:1;min-width:0;min-height:0;overflow:auto;padding-bottom:24px;scrollbar-width:none;-ms-overflow-style:none;}',
      '.mw-results::-webkit-scrollbar{display:none;width:0;height:0;}',
      '.mw-results-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px;color:var(--dsw-alias-label-secondary);font-size:12px;}',
      '.mw-group{margin-bottom:24px;}.mw-idle .mw-group{margin-bottom:0;}',
      '.mw-group:last-child{margin-bottom:0;}',
      '.mw-group-title{display:flex;align-items:center;gap:8px;margin:0 0 11px;font-size:14px;line-height:20px;font-weight:600;letter-spacing:-0.005em;color:var(--dsw-alias-label-primary);}',
      '.mw-group-meta{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary);opacity:.9;}',
      '.mw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:24px 16px;}',
      '.mw-card{display:flex;flex-direction:column;gap:7px;padding:0;border:0;border-radius:8px;background:none;color:inherit;text-align:left;cursor:pointer;}',
      '.mw-thumb{position:relative;width:100%;aspect-ratio:2/3;border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);transition:transform .18s ease,box-shadow .18s ease;}',
      '.mw-card:hover .mw-thumb{transform:translateY(-3px);box-shadow:0 10px 24px color-mix(in srgb,var(--dsw-alias-bg-overlay) 35%,transparent);}',
      '@media (prefers-reduced-motion:reduce){.mw-card:hover .mw-thumb{transform:none;}}',
      '.mw-thumb img{width:100%;height:100%;display:block;object-fit:cover;}',
      '.mw-thumb-empty{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));opacity:.7;}',
      '.mw-thumb-top{position:absolute;top:6px;left:6px;right:6px;display:flex;align-items:flex-start;justify-content:space-between;gap:6px;}',
      '.mw-rating{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 72%,transparent);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);color:var(--dsw-alias-label-primary-foreground);font-size:11.5px;font-weight:600;line-height:16px;letter-spacing:0.01em;}',
      '.mw-rating-star{display:inline-flex;color:var(--dsw-alias-state-warn-primary);}',
      '.mw-card-source{display:inline-flex;align-items:center;padding:2px 7px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 82%,transparent);color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;}',
      '.mw-card-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;line-height:18px;font-weight:500;transition:color .15s ease;}',
      '.mw-card:hover .mw-card-title{color:var(--dsw-alias-brand-primary);}',
      '.mw-card-meta{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);}',
      '.mw-tag{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}',
      '.mw-tag-rating{color:var(--dsw-alias-label-primary);}',
      '.mw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 14px;border-radius:17px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-decoration:none;cursor:pointer;}',
      '.mw-btn:hover{border-color:var(--dsw-alias-border-l2);}',
      '.mw-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-label-primary));}',
      '.mw-btn-primary:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary));}',
      '.mw-detail-page{flex:1;min-width:0;min-height:0;overflow:auto;padding-bottom:32px;scrollbar-width:none;-ms-overflow-style:none;}',
      '.mw-detail-page::-webkit-scrollbar{display:none;width:0;height:0;}',
      '.mw-page:not([data-view="list"]) .mw-toolbar,.mw-page:not([data-view="list"]) .mw-notices,.mw-page:not([data-view="list"]) .mw-results{display:none;}',
      '.mw-back{display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 12px 0 8px;border-radius:15px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;transition:color .15s ease,border-color .15s ease;}',
      '.mw-back:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}',
      '.mw-detail-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;align-items:start;margin-top:18px;}',
      '.mw-detail-layout[data-side="true"]{grid-template-columns:minmax(0,1fr) 260px;}',
      '.mw-detail-side{display:flex;flex-direction:column;gap:16px;min-width:0;}',
      '.mw-item{display:flex;align-items:flex-start;gap:28px;min-width:0;}',
      '.mw-item-poster{flex:none;width:230px;aspect-ratio:2/3;border-radius:12px;overflow:hidden;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}',
      '.mw-item-poster img{width:100%;height:100%;display:block;object-fit:cover;}',
      '.mw-item-body{flex:1;min-width:0;}',
      '.mw-item-eyebrow{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);}',
      '.mw-item-title{margin:4px 0;font-size:22px;line-height:30px;font-weight:500;}',
      '.mw-item-original{margin:0 0 14px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.mw-item-tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:18px;}',
      '.mw-item-section{margin-bottom:18px;}',
      '.mw-item-label{margin:0 0 6px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);}',
      '.mw-item-text{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);}',
      '.mw-item-tags-meta{margin:-10px 0 18px;}',
      '.mw-tag-meta{padding:1px 8px;background:transparent;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:17px;}',
      '.mw-item-text[data-empty="true"]{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}',
      '.mw-item-text[data-loading="true"]{animation:mw-pulse 1.4s ease-in-out infinite;}',
      '.mw-item-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px;}',
      '.mw-torrents{margin-top:26px;padding-top:20px;border-top:0.5px solid var(--dsw-alias-border-l1);}',
      '.mw-torrents-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px;margin-bottom:12px;}',
      '.mw-torrents-title{margin:0;font-size:15px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);}',
      '.mw-torrents-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.mw-torrents-tools{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-left:auto;}',
      '.mw-torrents-sort{display:flex;flex-wrap:wrap;align-items:center;gap:4px;}',
      '.mw-sort-chip{display:inline-flex;align-items:center;gap:3px;height:26px;padding:0 9px;border-radius:13px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:color .15s ease,border-color .15s ease,background-color .15s ease;}',
      '.mw-sort-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}',
      '.mw-sort-chip[data-selected="true"]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);}',
      '.mw-sort-arrow{font-size:11px;line-height:1;}',
      '.mw-torrent-list{display:flex;flex-direction:column;gap:8px;}',
      '.mw-torrent-row{display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border-radius:10px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
      '.mw-torrent-row-pick{border-color:var(--dsw-alias-brand-primary);}',
      '.mw-torrent-ai-badge{margin-left:6px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-size:10.5px;line-height:16px;display:inline-block;vertical-align:1px;white-space:nowrap;}',
      '.mw-ai-pick{display:flex;align-items:flex-start;gap:8px;margin:0 0 12px;padding:10px 12px;border-radius:10px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);}',
      '.mw-ai-pick[data-state="done"]{border-color:var(--dsw-alias-brand-primary);}',
      '.mw-ai-pick[data-state="error"]{color:var(--dsw-alias-label-secondary);}',
      '.mw-ai-pick[data-state="empty"]{color:var(--dsw-alias-label-tertiary);}',
      '.mw-ai-pick > svg{flex:none;margin-top:1px;color:var(--dsw-alias-brand-primary);}',
      '.mw-ai-pick-text{min-width:0;flex:1;}',
      '.mw-ai-pick-reason{color:var(--dsw-alias-label-secondary);}',
      '.mw-ai-pick-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary);margin-top:5px;flex:none;animation:mw-pulse 1.2s ease-in-out infinite;}',
      '.mw-ai-pick-btn{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-brand-primary);}',
      '.mw-ai-pick-btn[data-picking="true"]{opacity:.6;}',
      '.mw-torrent-main{flex:1;min-width:0;}',
      '.mw-torrent-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;margin:0 0 4px;font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);}',
      '.mw-torrent-meta{display:flex;flex-wrap:wrap;gap:4px 10px;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.mw-torrent-seed{color:var(--dsw-alias-state-success-primary);}',
      '.mw-torrent-actions{display:flex;flex:none;flex-wrap:wrap;gap:6px;}',
      '.mw-torrent-actions .mw-btn{height:28px;min-width:58px;justify-content:center;padding:0 12px;font-size:12px;border-radius:14px;}',
      '.mw-torrent-copy{cursor:pointer;}',
      '.mw-torrent-loading{display:flex;flex-direction:column;gap:8px;}',
      '.mw-torrent-skeleton{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:10px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
      '.mw-torrent-more{display:flex;justify-content:center;padding:10px 0 2px;}',
      '.mw-torrent-more-note{margin:10px 0 2px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary);}',
      '.mw-torrent-empty{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.mw-torrent-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}',
      '.mw-torrent-links .mw-btn{height:30px;padding:0 12px;font-size:12px;border-radius:15px;}',
      '@media (max-width:767px){.mw-grid,.mw-skeleton-grid{grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:16px 12px;}.mw-head-row{gap:10px;}.mw-item{flex-direction:column;gap:18px;}.mw-item-poster{width:170px;margin:0 auto;}}',
      '.mw-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:48px 20px;text-align:center;color:var(--dsw-alias-label-secondary);}',
      '.mw-placeholder-glyph{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));opacity:.75;}',
      '.mw-placeholder-title{margin:0;font-size:15px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);}',
      '.mw-placeholder-hint{margin:0;max-width:420px;font-size:13px;line-height:20px;}',
      '.mw-examples{display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin-top:6px;}',
      '.mw-idle{display:flex;flex-direction:column;gap:24px;}',
      '.mw-group-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;}',
      '.mw-group-head .mw-group-title{margin:0;}',
      '.mw-more{display:inline-flex;align-items:center;gap:1px;flex:none;font-size:12px;color:var(--dsw-alias-label-secondary);text-decoration:none;}',
      '.mw-more:hover{color:var(--dsw-alias-label-primary);text-decoration:none;}',
      '.mw-channel-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:16px 0 14px;}',
      '.mw-channel-title{margin:0;font-size:18px;line-height:26px;font-weight:600;letter-spacing:-0.01em;color:var(--dsw-alias-label-primary);}',
      '.mw-channel-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.mw-channel-head .mw-more{margin-left:auto;}',
      '.mw-tabs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin:0 0 16px;border-bottom:0.5px solid var(--dsw-alias-border-l1);}',
      '.mw-tab{position:relative;appearance:none;border:0;background:none;padding:8px 12px;border-radius:8px 8px 0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:18px;cursor:pointer;transition:color .15s ease,background-color .15s ease;}',
      '.mw-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.mw-tab[data-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:500;}',
      '.mw-tab[data-selected="true"]::after{content:"";position:absolute;left:10px;right:10px;bottom:-0.5px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary);}',
      '.mw-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
      '.mw-more-row{display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 0 8px;}',
      '.mw-more-sentinel{display:flex;justify-content:center;}',
      '.mw-related{display:flex;flex-direction:column;gap:8px;}',
      '.mw-related-label{font-size:11px;letter-spacing:0.04em;color:var(--dsw-alias-label-tertiary);}',
      '.mw-related-cards{display:flex;flex-direction:column;gap:10px;}',
      '.mw-related-card{display:flex;align-items:center;gap:10px;width:100%;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left;cursor:pointer;appearance:none;}',
      '.mw-related-card:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.mw-related-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.mw-related-cover{display:block;width:40px;height:60px;flex:none;overflow:hidden;border-radius:6px;background:var(--dsw-alias-bg-layer-2);}',
      '.mw-related-cover img{display:block;width:100%;height:100%;object-fit:cover;}',
      '.mw-related-text{min-width:0;display:flex;flex-direction:column;gap:2px;}',
      '.mw-related-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mw-related-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '@media (max-width:1023px){.mw-detail-layout[data-side="true"]{grid-template-columns:minmax(0,1fr);}.mw-related-cards{flex-direction:row;flex-wrap:wrap;}.mw-related-card{width:auto;max-width:300px;}}',
      '.mw-collection-note{margin:0 0 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.mw-chart-section{margin-bottom:24px;}',
      '.mw-chart-section:last-child{margin-bottom:8px;}',
      '.mw-chart-section-head{display:flex;align-items:center;gap:8px;width:100%;padding:0 0 12px;border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;font-weight:600;text-align:left;cursor:pointer;}',
      '.mw-chart-section-head:hover .mw-chart-section-title{color:var(--dsw-alias-brand-primary);}',
      '.mw-chart-section-title{flex:0 1 auto;margin:0;}',
      '.mw-chart-section-count{flex:0 0 auto;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);}',
      '.mw-chart-section-chevron{flex:0 0 auto;width:14px;height:14px;margin-left:auto;color:var(--dsw-alias-label-tertiary);transition:transform .18s ease;}',
      '.mw-chart-section[data-open="false"] .mw-chart-section-chevron{transform:rotate(-90deg);}',
      '.mw-chart-section-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px;}',
      '.mw-chart-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin:0 0 8px;}',
      '.mw-chart-card{display:flex;flex-direction:column;padding:0;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;cursor:pointer;text-align:left;transition:border-color .15s ease,background-color .15s ease,transform .15s ease;}',
      '.mw-chart-card:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);transform:translateY(-2px);}',
      '.mw-chart-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.mw-chart-cover{position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:16/7;overflow:hidden;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);}',
      '.mw-chart-cover img{width:100%;height:100%;object-fit:cover;}',
      '.mw-chart-cover-empty{aspect-ratio:auto;height:86px;background:linear-gradient(135deg,var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-1));border-bottom:1px solid var(--dsw-alias-bg-layer-2);}',
      '.mw-chart-body{display:flex;flex-direction:column;gap:4px;padding:10px 12px 12px;}',
      '.mw-chart-title{font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.mw-chart-desc{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '.mw-chart-meta{display:flex;flex-wrap:wrap;gap:6px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);}',
      '.mw-chart-note{margin:0 0 14px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);}',
      '.mw-card-rank{position:absolute;left:6px;top:6px;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 72%,transparent);color:var(--dsw-alias-label-primary-foreground);font-size:11px;line-height:16px;font-weight:600;backdrop-filter:blur(6px);}',
      '.mw-idle-extras{display:flex;flex-direction:column;gap:12px;margin-top:22px;padding-top:18px;border-top:0.5px solid var(--dsw-alias-border-l1);}',
      '.mw-toolbar-recent{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;}',
      '.mw-recent-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-right:2px;}',
      '.mw-toolbar-hint{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary);}',
      '.mw-rec-hint{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:10px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;}',



      '.mw-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:56px 20px;text-align:center;}',
      '.mw-empty-glyph{color:var(--dsw-alias-state-warn-primary);margin-bottom:2px;}',
      '.mw-empty-title{margin:0;font-size:15px;line-height:22px;font-weight:500;}',
      '.mw-empty-hint{margin:0;max-width:420px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.mw-error-actions{margin-top:6px;}',
      '.mw-skeleton-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:22px 16px;}',
      '.mw-skeleton{display:flex;flex-direction:column;gap:8px;}',
      '.mw-skeleton-thumb{width:100%;aspect-ratio:2/3;border-radius:10px;background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-bg-layer-2));}',
      '.mw-skeleton-line{height:10px;border-radius:5px;background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-bg-layer-2));}',
      '.mw-skeleton-line[data-short="true"]{width:60%;}',
      '@media (prefers-reduced-motion:no-preference){.mw-skeleton-thumb,.mw-skeleton-line{animation:mw-pulse 1.6s ease-in-out infinite;}@keyframes mw-pulse{0%,100%{opacity:.55;}50%{opacity:.9;}}}',





      '.mw-key-popover{position:absolute;top:calc(86px + var(--dsh-frame-top-clearance,0px));right:clamp(20px,3vw,40px);z-index:20;width:min(340px,calc(100vw - 48px));padding:16px;border-radius:14px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-bg-base) 45%,transparent);}',
      '.mw-key-title{margin:0 0 4px;font-size:14px;line-height:20px;font-weight:500;}',
      '.mw-key-hint{margin:0 0 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.mw-key-input{width:100%;height:34px;box-sizing:border-box;padding:0 10px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;margin-bottom:10px;}',
      '.mw-key-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
      '.mw-key-actions{display:flex;align-items:center;gap:8px;}',
      '.mw-key-state{margin-top:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.mw-key-link{margin-top:6px;font-size:12px;line-height:18px;}',
      '.mw-key-link a{color:var(--dsw-alias-link,var(--dsw-alias-brand-primary));text-decoration:none;}',
      '.mw-key-link a:hover{text-decoration:underline;}',
      '.mw-head{position:relative;}',
      '.mw-settings-popover{width:min(320px,calc(100vw - 48px));}',
      '.mw-settings-list{display:flex;flex-direction:column;gap:2px;margin-top:2px;}',
      '.mw-setting-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;}',
      '.mw-setting-row + .mw-setting-row{border-top:0.5px solid var(--dsw-alias-border-l1);}',
      '.mw-setting-text{display:flex;flex-direction:column;min-width:0;}',
      '.mw-setting-name{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);}',
      '.mw-setting-desc{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);}',
      '.mw-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border:0.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background-color .15s ease,border-color .15s ease;}',
      '.mw-switch[data-on="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent;}',
      '.mw-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.mw-switch-thumb{position:absolute;top:3px;left:3px;width:15px;height:15px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .15s ease;}',
      '.mw-switch[data-on="true"] .mw-switch-thumb{transform:translateX(16px);}',
      '.mw-settings-divider{height:0.5px;margin:12px 0;background:var(--dsw-alias-border-l1);}',
      '.mw-settings-subtitle{margin-top:0;font-size:12px;}',
      '.mw-setting-note{margin:6px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.mw-model-trigger[data-layout="stacked"]{width:100%;max-width:none;height:auto;min-height:38px;padding:6px 10px;align-items:flex-start;justify-content:space-between;text-align:left;}',
      '.mw-model-trigger-stack{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.mw-model-trigger-name{font-size:12.5px;line-height:17px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mw-model-trigger-sub{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mw-setting-table{margin-top:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;}',
      '.mw-setting-table-head{display:grid;grid-template-columns:84px minmax(0,1fr);gap:8px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:9px 9px 0 0;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);}',
      '.mw-setting-table-row{display:grid;grid-template-columns:84px minmax(0,1fr);gap:8px;align-items:center;padding:8px 10px;}',
      '.mw-setting-table-label{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);}',
      '.mw-setting-table-model{min-width:0;}',
      '.mw-setting-table-note{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.mw-setting-ai-model{align-items:flex-start;}',
      '.mw-setting-select{flex:none;max-width:150px;height:30px;padding:0 26px 0 8px;font-size:12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l1);cursor:pointer;appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-secondary) 50%),linear-gradient(135deg,var(--dsw-alias-label-secondary) 50%,transparent 50%);background-position:calc(100% - 13px) 13px,calc(100% - 9px) 13px;background-size:4px 4px,4px 4px;background-repeat:no-repeat;}',
      '.mw-setting-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.mw-modal-overlay{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:24px;padding-top:calc(28px + var(--dsh-frame-top-clearance,0px) + 16px);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 48%,transparent);-webkit-app-region:no-drag;}',
      '.mw-modal{display:flex;flex-direction:column;width:min(520px,100%);-webkit-app-region:no-drag;max-height:min(78vh,620px);border-radius:14px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-bg-overlay) 32%,transparent);overflow:hidden;}',
      '.mw-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px 10px;}',
      '.mw-modal-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.mw-modal-close{flex:none;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;cursor:pointer;}',
      '.mw-modal-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.mw-modal-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.mw-modal-body{flex:1;min-height:0;overflow:auto;padding:0 16px 4px;}',
      '.mw-modal-head-actions{display:flex;align-items:center;gap:10px;flex:none;}',
      '.mw-ai-dialog{width:min(760px,100%);max-height:min(76vh,720px);overflow:visible;}',
      '.mw-ai-mode{display:inline-flex;align-items:center;padding:2px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);}',
      '.mw-ai-mode-btn{appearance:none;height:26px;padding:0 12px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;}',
      '.mw-ai-mode-btn:hover{color:var(--dsw-alias-label-primary);}',
      '.mw-ai-mode-btn[data-selected="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-bg-overlay) 18%,transparent);}',
      '.mw-ai-mode-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.mw-ai-pref-summary{margin:0 0 10px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.mw-ai-dialog-item{margin:0 0 10px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.mw-ai-dialog-intro{margin:0 0 12px;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.mw-ai-prefs{display:flex;flex-direction:column;gap:8px;margin:0 0 12px;}',
      '.mw-ai-pref{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.mw-ai-pref-label{min-width:44px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.mw-ai-pref-chips{display:flex;gap:6px;flex-wrap:wrap;}',
      '.mw-ai-pref-chip{appearance:none;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;}',
      '.mw-ai-pref-chip:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.mw-ai-pref-chip[data-selected="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);}',
      '.mw-ai-free-hint{margin:0 0 10px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);}',
      '.mw-ai-prompt{margin:0 0 10px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}',
      '.mw-ai-prompt-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px;}',
      '.mw-ai-prompt-title{font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.mw-ai-prompt-input{box-sizing:border-box;width:100%;min-height:240px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;resize:vertical;}',
      '.mw-ai-prompt-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
      '.mw-ai-prompt-note{margin:6px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.mw-ai-running{margin:0 0 10px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.mw-ai-raw{margin:8px 0 0;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace, SFMono-Regular, Menlo, monospace;font-size:11.5px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;}',
      '.mw-ai-dialog-actions{justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;}',
      '.mw-ai-dialog-model-picker{display:flex;align-items:center;gap:8px;min-width:0;position:relative;}',
      '.mw-ai-dialog-model-label{font-size:12px;color:var(--dsw-alias-label-secondary);flex:none;}',
      '.mw-model-trigger{display:inline-flex;align-items:center;gap:8px;height:32px;max-width:300px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1;cursor:pointer;transition:background .15s ease,border-color .15s ease;}',
      '.mw-model-trigger:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);}',
      '.mw-model-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.mw-model-trigger-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mw-model-trigger-chevron{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease;}',
      '.mw-model-trigger[aria-expanded="true"] .mw-model-trigger-chevron{transform:rotate(180deg);}',
      '.mw-model-picker{position:relative;min-width:0;}',
      '.mw-model-panel{position:absolute;left:0;z-index:6;width:min(340px,calc(100vw - 48px));max-height:280px;overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 14px 34px color-mix(in srgb,var(--dsw-alias-bg-overlay) 22%,transparent);}',
      '.mw-model-panel[data-placement="up"]{bottom:calc(100% + 8px);top:auto;}',
      '.mw-model-panel[data-placement="down"]{top:calc(100% + 6px);bottom:auto;left:auto;right:0;width:min(320px,calc(100vw - 48px));}',
      '.mw-model-option{display:flex;align-items:center;gap:10px;width:100%;padding:7px 9px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;text-align:left;cursor:pointer;}',
      '.mw-model-option:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.mw-model-option[data-selected="true"]{color:var(--dsw-alias-brand-primary);font-weight:600;}',
      '.mw-model-option-check{flex:none;width:14px;font-size:12px;color:var(--dsw-alias-brand-primary);}',
      '.mw-model-option-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mw-model-option-provider{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-weight:400;}',
      '.mw-model-empty{margin:0;padding:8px 9px;font-size:12px;color:var(--dsw-alias-label-tertiary);}',
      '.mw-ai-dialog-buttons{display:flex;align-items:center;gap:8px;margin-left:auto;}',
      '.mw-ai-dialog-elapsed{margin-left:4px;color:var(--dsw-alias-label-tertiary);}',
      '.mw-ai-dialog-result{margin:4px 0 10px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);}',
      '.mw-ai-dialog-result[data-state="error"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);}',
      '.mw-ai-dialog-result-title{margin:0 0 6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);}',
      '.mw-ai-dialog-chosen{margin:0 0 4px;font-size:13px;line-height:19px;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
      '.mw-ai-dialog-chosen-meta{margin:0 0 6px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);}',
      '.mw-ai-dialog-reason{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
      '.mw-ai-dialog-reason strong{font-weight:600;}',
      '.mw-modal-actions{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px 16px;border-top:0.5px solid var(--dsw-alias-border-l1);}',
    ].join('\n')

    /* ------------------------------------------------------------------ */
    /* Result surfaces                                                     */
    /* ------------------------------------------------------------------ */

    function Poster(props) {
      const item = props.item
      const [broken, setBroken] = useState(false)
      const src = posterUrl(item.poster)
      useEffect(() => {
        setBroken(false)
      }, [src])
      if (!src || broken) {
        return h('div', { className: 'mw-thumb-empty' }, h(GlyphClapper, { size: 30 }))
      }
      return h('img', {
        src: src,
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        referrerPolicy: 'no-referrer',
        onError: () => setBroken(true),
      })
    }

    function ResultCard(props) {
      const t = props.t
      const item = props.item
      const showSource = props.showSource
      const meta = []
      if (item.year) meta.push(String(item.year))
      meta.push(kindLabel(t, item.kind))
      return h(
        'button',
        {
          type: 'button',
          className: 'mw-card',
          onClick: () => props.onSelect(item),
        },
        h(
          'div',
          { className: 'mw-thumb' },
          h(Poster, { item: item }),
          item.rank ? h('span', { className: 'mw-card-rank' }, '#' + item.rank) : null,
          h(
            'div',
            { className: 'mw-thumb-top' },
            item.rating !== null && item.rating !== undefined
              ? h('span', { className: 'mw-rating' },
                h('span', { className: 'mw-rating-star' }, h(GlyphStar, null)),
                h('span', { className: 'mw-sr-only' }, t('detail.rating')),
                String(item.rating))
              : h('span', null),
            showSource ? h('span', { className: 'mw-card-source' }, sourceLabel(t, item.source)) : h('span', null),
          ),
        ),
        h('div', { className: 'mw-card-title' }, item.title || item.originalTitle || item.id),
        h('div', { className: 'mw-card-meta' }, meta.join(' · ')),
      )
    }

    function ResultGroup(props) {
      const t = props.t
      return h(
        'section',
        { className: 'mw-group', 'data-source': props.source, 'aria-label': t('aria.group', { source: sourceLabel(t, props.source) }) },
        h(
          'h2',
          { className: 'mw-group-title' },
          sourceLabel(t, props.source),
          h('span', { className: 'mw-group-meta' }, t('results.count', { count: props.items.length })),
        ),
        h(
          'div',
          { className: 'mw-grid' },
          props.items.map(item => h(ResultCard, {
            key: searchKey(item),
            t: t,
            item: item,
            showSource: false,
            onSelect: props.onSelect,
          })),
        ),
      )
    }

    function Skeleton() {
      const cards = []
      for (let index = 0; index < 12; index += 1) {
        cards.push(
          h(
            'div',
            { className: 'mw-skeleton', key: 'skeleton-' + index },
            h('div', { className: 'mw-skeleton-thumb' }),
            h('div', { className: 'mw-skeleton-line' }),
            h('div', { className: 'mw-skeleton-line', 'data-short': 'true' }),
          ),
        )
      }
      return h('div', { className: 'mw-skeleton-grid', 'aria-hidden': 'true' }, cards)
    }

    /** One recommendation row: a channel header plus its poster cards. */
    function RecommendSection(props) {
      const t = props.t
      return h(
        'section',
        { className: 'mw-group', 'data-source': props.source, 'aria-label': t('aria.group', { source: sourceLabel(t, props.source) }) },
        h(
          'div',
          { className: 'mw-group-head' },
          h(
            'h2',
            { className: 'mw-group-title' },
            sourceLabel(t, props.source),
            h('span', { className: 'mw-group-meta' }, t('recommend.' + props.source)),
          ),
          props.onMore
            ? h(
              'button',
              {
                type: 'button',
                className: 'mw-link-btn mw-more',
                onClick: event => props.onMore(props.source, event.currentTarget),
              },
              t('recommend.more'),
              h(GlyphChevronRight, { size: 13 }),
            )
            : null,
        ),
        h(
          'div',
          { className: 'mw-grid' },
          props.items.map(item => h(ResultCard, {
            key: searchKey(item),
            t: t,
            item: item,
            showSource: false,
            onSelect: props.onSelect,
          })),
        ),
      )
    }

    /** Inline per-channel notice inside a recommendation row. */
    function RecommendHint(props) {
      return h(
        'div',
        { className: 'mw-rec-hint' },
        h('span', { className: 'mw-notice-glyph' }, h(GlyphWarning, null)),
        h('span', { className: 'mw-notice-text' }, props.text),
        props.actionLabel
          ? h('button', { type: 'button', className: 'mw-link-btn', onClick: props.onAction }, props.actionLabel)
          : null,
      )
    }

    /**
     * The idle surface: one recommendation row per channel. A failed or empty
     * channel keeps its own row with an inline explanation instead of hiding
     * which channels exist.
     */
    function Recommendations(props) {
      const t = props.t
      const state = props.state

      if (!state || state.status === 'loading') {
        return h(
          'div',
          null,
          h('span', { className: 'mw-sr-only', role: 'status' }, t('recommend.loading')),
          h(Skeleton, null),
        )
      }

      if (state.status === 'error') {
        return h(
          'div',
          { className: 'mw-idle' },
          h(
            'div',
            { className: 'mw-placeholder' },
            h('div', { className: 'mw-placeholder-glyph' }, h(GlyphClapper, { size: 56 })),
            h('p', { className: 'mw-placeholder-title' }, t('recommend.failed')),
            h('p', { className: 'mw-placeholder-hint' }, failureText(t, state.failure || 'network')),
            h(
              'div',
              { className: 'mw-examples' },
              h(
                'button',
                { type: 'button', className: 'mw-btn', onClick: props.onRetry },
                h(GlyphRefresh, null),
                t('recommend.retry'),
              ),
            ),
          ),
        )
      }

      const errorMap = {}
      ;(state.errors || []).forEach(entry => {
        if (entry && entry.source && !errorMap[entry.source]) errorMap[entry.source] = entry.code || 'upstream_error'
      })
      const enabled = props.enabled || { tmdb: true, imdb: true, douban: true }
      const visible = PROVIDERS.filter(provider => enabled[provider] && (props.source === 'all' || props.source === provider))
      const rows = visible.map(provider => {
        const group = (state.groups || []).find(candidate => candidate.source === provider)
        const items = group && Array.isArray(group.items) ? group.items : []
        if (items.length > 0) {
          return h(RecommendSection, {
            key: 'recommend-' + provider,
            t: t,
            source: provider,
            items: items,
            onSelect: props.onSelect,
            onMore: props.onMore,
          })
        }
        const errorCode = errorMap[provider]
        const needsKey = errorCode === 'tmdb_key_missing'
        return h(
          'section',
          { className: 'mw-group', key: 'recommend-' + provider, 'data-source': provider, 'aria-label': t('aria.group', { source: sourceLabel(t, provider) }) },
          h(
            'h2',
            { className: 'mw-group-title' },
            sourceLabel(t, provider),
            h('span', { className: 'mw-group-meta' }, t('recommend.' + provider)),
          ),
          h(RecommendHint, {
            t: t,
            text: errorCode ? failureText(t, errorCode) : t('recommend.empty'),
            actionLabel: needsKey ? t('notice.setKey') : (errorCode ? t('recommend.retry') : undefined),
            onAction: needsKey ? props.onOpenKey : props.onRetry,
          }),
        )
      })

      return h('div', null, rows)
    }

    function EmptyState(props) {
      const t = props.t
      return h(
        'div',
        { className: 'mw-empty' },
        h('div', { className: 'mw-empty-glyph' }, h(GlyphSearch, { size: 28 })),
        h('p', { className: 'mw-empty-title' }, t('results.empty.title')),
        h('p', { className: 'mw-empty-hint' }, t('results.empty.hint')),
      )
    }

    function ErrorState(props) {
      const t = props.t
      return h(
        'div',
        { className: 'mw-empty' },
        h('div', { className: 'mw-empty-glyph' }, h(GlyphWarning, { size: 28 })),
        h('p', { className: 'mw-empty-title' }, t('error.title')),
        h('p', { className: 'mw-empty-hint' }, failureText(t, props.code)),
        h(
          'div',
          { className: 'mw-error-actions' },
          h('button', { type: 'button', className: 'mw-btn', onClick: props.onRetry }, h(GlyphRefresh, null), t('error.retry')),
        ),
      )
    }

    /** One channel's longer list: category tabs, paged grid and infinite scroll. */
    function ChannelPage(props) {
      const t = props.t
      const state = props.state
      const source = state.source
      const categories =
        Array.isArray(state.categories) && state.categories.length > 0
          ? state.categories
          : channelCategories(source)
      const activeCategory = state.category || categories[0]
      const label = sourceLabel(t, source) + ' · ' + t('browse.' + activeCategory)
      const items = Array.isArray(state.items) ? state.items : []
      const loadingMore = Boolean(props.loadingMore)
      const hasMore = Boolean(state.hasMore)
      const listsKind = listsKindFor(activeCategory)
      const listsActive = Boolean(listsKind)
      const backRef = useRef(null)
      const sentinelRef = useRef(null)

      useEffect(() => {
        if (backRef.current) backRef.current.focus()
      }, [])

      useEffect(() => {
        if (listsActive || !hasMore || loadingMore) return undefined
        const node = sentinelRef.current
        if (!node || typeof IntersectionObserver !== 'function') return undefined
        const observer = new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) props.onLoadMore()
        }, { rootMargin: '280px 0px' })
        observer.observe(node)
        return () => observer.disconnect()
      }, [listsActive, hasMore, loadingMore, items.length, activeCategory])

      let body = null
      if (listsActive) {
        body = h(ChartGrid, {
          t: t,
          kind: listsKind,
          state: props.lists ? props.lists[listsKind] : null,
          onOpenChart: props.onOpenChart,
          onRetry: props.onRetryLists,
        })
      } else if (state.status === 'loading') {
        body = h(Skeleton, null)
      } else if (state.status === 'error') {
        body = h(ErrorState, { t: t, code: state.failure || 'network', onRetry: props.onRetry })
      } else if (items.length === 0) {
        const needsKey = state.failure === 'tmdb_key_missing'
        body = h(
          'div',
          { className: 'mw-idle' },
          h(RecommendHint, {
            t: t,
            text: state.failure ? failureText(t, state.failure) : t('recommend.empty'),
            actionLabel: needsKey ? t('notice.setKey') : (state.failure ? t('recommend.retry') : undefined),
            onAction: needsKey ? props.onOpenKey : props.onRetry,
          }),
        )
      } else {
        body = h(
          'div',
          null,
          h(
            'div',
            { className: 'mw-grid' },
            items.map((item, index) => h(ResultCard, {
              key: searchKey(item),
              t: t,
              item: item.rank ? item : { ...item, rank: index + 1 },
              showSource: false,
              onSelect: props.onSelect,
            })),
          ),
          state.failure
            ? h(
              'div',
              { className: 'mw-idle-extras' },
              h(RecommendHint, {
                t: t,
                text: failureText(t, state.failure),
                actionLabel: t('recommend.retry'),
                onAction: props.onRetry,
              }),
            )
            : null,
          h(
            'div',
            { className: 'mw-more-row' },
            loadingMore
              ? h('span', { className: 'mw-channel-meta' }, t('browse.loadingMore'))
              : props.moreFailure
                ? h(
                  'div',
                  { className: 'mw-more-sentinel' },
                  h('span', { className: 'mw-channel-meta' }, t('browse.moreFailed')),
                  h('button', { type: 'button', className: 'mw-link-btn', onClick: props.onLoadMore }, t('recommend.retry')),
                )
                : hasMore
                  ? h(
                    'div',
                    { className: 'mw-more-sentinel', ref: sentinelRef },
                    h('button', { type: 'button', className: 'mw-btn', onClick: props.onLoadMore }, t('browse.loadMore')),
                  )
                  : h('span', { className: 'mw-channel-meta' }, t('browse.end')),
          ),
        )
      }

      return h(
        'div',
        { className: 'mw-detail-page', role: 'region', 'aria-label': label },
        h(
          'button',
          { type: 'button', className: 'mw-back', ref: backRef, onClick: props.onBack },
          h(GlyphChevronLeft, { size: 15 }),
          t('recommend.back'),
        ),
        h(
          'div',
          { className: 'mw-channel-head' },
          h('h2', { className: 'mw-channel-title' }, label),
          h(
            'button',
            { type: 'button', className: 'mw-link-btn mw-more', onClick: props.onRefresh },
            h(GlyphRefresh, null),
            ' ',
            t('recommend.refresh'),
          ),
        ),
        categories.length > 1
          ? h(
            'div',
            { className: 'mw-tabs', role: 'tablist', 'aria-label': t('browse.tabs') },
            categories.map(category => h(
              'button',
              {
                key: category,
                type: 'button',
                role: 'tab',
                className: 'mw-tab',
                'aria-selected': category === activeCategory ? 'true' : 'false',
                'data-selected': category === activeCategory ? 'true' : 'false',
                onClick: () => {
                  if (category !== activeCategory) props.onSelectCategory(category)
                },
              },
              t('browse.' + category),
            )),
          )
          : null,
        body,
      )
    }

    /** One official Douban chart card (片单 tab). */
    function ChartCard(props) {
      const t = props.t
      const chart = props.chart
      const initialCover = chart.cover
        ? posterUrl(chart.cover)
        : posterUrl(chartCoverCache.get(chart.id) || '')
      const [cover, setCover] = useState(initialCover)
      const coverRef = useRef(null)
      const coverWanted = !chart.cover && !chartCoverCache.get(chart.id)
      useEffect(() => {
        if (!coverWanted) return undefined
        const node = coverRef.current
        let cancelled = false
        const load = () => {
          chartCoverFor(chart.id).then(url => {
            if (!cancelled && url) setCover(posterUrl(url))
          })
        }
        if (!node || typeof IntersectionObserver !== 'function') {
          load()
          return () => { cancelled = true }
        }
        const observer = new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) {
            observer.disconnect()
            load()
          }
        }, { rootMargin: '160px 0px' })
        observer.observe(node)
        return () => {
          cancelled = true
          observer.disconnect()
        }
      }, [chart.id, coverWanted])
      return h(
        'button',
        { type: 'button', className: 'mw-chart-card', onClick: () => props.onOpen(chart), ref: coverRef },
        h(
          'div',
          { className: cover ? 'mw-chart-cover' : 'mw-chart-cover mw-chart-cover-empty' },
          cover
            ? h('img', {
              src: cover,
              alt: '',
              loading: 'lazy',
              decoding: 'async',
              referrerPolicy: 'no-referrer',
            })
            : h(GlyphClapper, { size: 22 }),
        ),
        h(
          'div',
          { className: 'mw-chart-body' },
          h('div', { className: 'mw-chart-title' }, chart.title || chart.id),
          chart.description ? h('p', { className: 'mw-chart-desc' }, chart.description) : null,
          h(
            'div',
            { className: 'mw-chart-meta' },
            chart.subtitle ? h('span', null, chart.subtitle) : null,
            chart.total ? h('span', null, t('chart.count', { count: chart.total })) : null,
          ),
        ),
      )
    }

    const CHART_FAMILIES = ['official', 'annual', 'rating', 'heat', 'hidden']

    /**
     * Group the chart catalog into its display sections in display order:
     * 官方榜单, 年度榜单, 高分经典 (genre rating), 近期热门 (genre heat) and
     * 冷门佳作. A catalog without `family` falls back to one untitled grid.
     */
    function chartSections(t, charts) {
      const groups = new Map()
      for (const chart of charts) {
        const family = CHART_FAMILIES.indexOf(chart.family) === -1 ? 'all' : chart.family
        if (!groups.has(family)) groups.set(family, [])
        groups.get(family).push(chart)
      }
      if (groups.size === 1 && groups.has('all')) {
        return [{ key: 'all', title: '', charts: groups.get('all') }]
      }
      const sections = []
      for (const family of ['all', ...CHART_FAMILIES]) {
        const entries = groups.get(family)
        if (!entries || entries.length === 0) continue
        sections.push({
          key: family,
          title: family === 'all' ? '' : t('lists.' + family),
          charts: entries,
        })
      }
      return sections
    }

    /**
     * One collapsible chart section: its heading doubles as a toggle button so
     * long catalogs stay navigable. Expanded by default; collapsing keeps the
     * charts mounted nowhere (the cards are simply not rendered).
     */
    function ChartSection(props) {
      const t = props.t
      const section = props.section
      const [open, setOpen] = useState(true)
      const charts = section.charts
      return h(
        'section',
        { className: 'mw-chart-section', 'data-open': open ? 'true' : 'false' },
        h(
          'button',
          {
            type: 'button',
            className: 'mw-chart-section-head',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpen(value => !value),
          },
          section.title ? h('span', { className: 'mw-chart-section-title' }, section.title) : null,
          h('span', { className: 'mw-chart-section-count' }, charts.length),
          h('span', { className: 'mw-chart-section-chevron' }, h(GlyphChevronDown, null)),
        ),
        open
          ? h(
            'div',
            { className: 'mw-chart-grid' },
            charts.map(chart => h(ChartCard, {
              key: chart.id,
              t: t,
              chart: chart,
              onOpen: chart => props.onOpenChart(chart, props.kind),
            })),
          )
          : null,
      )
    }

    /** The 片单 tab: official charts as cards, with loading/error/empty states. */
    function ChartGrid(props) {
      const t = props.t
      const state = props.state
      if (!state || state.status === 'loading' || state.status === 'idle') return h(Skeleton, null)
      if (state.status === 'error') {
        return h(ErrorState, {
          t: t,
          code: state.failure || 'network',
          onRetry: props.onRetry,
        })
      }
      const charts = Array.isArray(state.charts) ? state.charts : []
      if (charts.length === 0) {
        return h(
          'div',
          { className: 'mw-idle' },
          h(RecommendHint, { t: t, text: t('chart.empty') }),
        )
      }
      const partialFailure = Array.isArray(state.errors) && state.errors.length > 0
      return h(
        'div',
        null,
        chartSections(t, charts).map(section => h(ChartSection, {
          key: section.key,
          t: t,
          section: section,
          onOpenChart: props.onOpenChart,
        })),
        partialFailure
          ? h(
            'div',
            { className: 'mw-idle-extras' },
            h(RecommendHint, {
              t: t,
              text: failureText(t, state.errors[0].code || 'upstream_error'),
              actionLabel: t('recommend.retry'),
              onAction: props.onRetry,
            }),
          )
          : null,
      )
    }

    /** One official chart: ranked titles with the same paged infinite scroll. */
    function ChartPage(props) {
      const t = props.t
      const view = props.view
      const chart = view.chart || {}
      const items = Array.isArray(view.items) ? view.items : []
      const loadingMore = Boolean(props.loadingMore)
      const backRef = useRef(null)
      const sentinelRef = useRef(null)

      useEffect(() => {
        if (backRef.current) backRef.current.focus()
      }, [])

      useEffect(() => {
        if (!view.hasMore || loadingMore) return undefined
        const node = sentinelRef.current
        if (!node || typeof IntersectionObserver !== 'function') return undefined
        const observer = new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) props.onLoadMore()
        }, { rootMargin: '280px 0px' })
        observer.observe(node)
        return () => observer.disconnect()
      }, [view.hasMore, loadingMore, items.length])

      const note = [chart.description, chart.total ? t('chart.count', { count: chart.total }) : '']
        .filter(Boolean)
        .join(' · ')

      let body = null
      if (view.status === 'loading') {
        body = h(Skeleton, null)
      } else if (view.status === 'error') {
        body = h(ErrorState, {
          t: t,
          code: view.failure || 'network',
          onRetry: props.onRetry,
        })
      } else if (items.length === 0) {
        body = h(
          'div',
          { className: 'mw-idle' },
          h(RecommendHint, {
            t: t,
            text: view.failure ? failureText(t, view.failure) : t('chart.empty'),
            actionLabel: view.failure ? t('recommend.retry') : undefined,
            onAction: props.onRetry,
          }),
        )
      } else {
        body = h(
          'div',
          null,
          h(
            'div',
            { className: 'mw-grid' },
            items.map(item => h(ResultCard, {
              key: searchKey(item),
              t: t,
              item: item,
              showSource: false,
              onSelect: props.onSelect,
            })),
          ),
          h(
            'div',
            { className: 'mw-more-row' },
            loadingMore
              ? h('span', { className: 'mw-channel-meta' }, t('browse.loadingMore'))
              : props.moreFailure
                ? h(
                  'div',
                  { className: 'mw-more-sentinel' },
                  h('span', { className: 'mw-channel-meta' }, t('browse.moreFailed')),
                  h('button', { type: 'button', className: 'mw-link-btn', onClick: props.onLoadMore }, t('recommend.retry')),
                )
                : view.hasMore
                  ? h(
                    'div',
                    { className: 'mw-more-sentinel', ref: sentinelRef },
                    h('button', { type: 'button', className: 'mw-btn', onClick: props.onLoadMore }, t('browse.loadMore')),
                  )
                  : h('span', { className: 'mw-channel-meta' }, t('browse.end')),
          ),
        )
      }

      return h(
        'div',
        { className: 'mw-detail-page', role: 'region', 'aria-label': chart.title || chart.id },
        h(
          'button',
          { type: 'button', className: 'mw-back', ref: backRef, onClick: props.onBack },
          h(GlyphChevronLeft, { size: 15 }),
          view.returnTo === 'detail' ? t('chart.backDetail') : t('chart.back'),
        ),
        h(
          'div',
          { className: 'mw-channel-head' },
          h('h2', { className: 'mw-channel-title' }, chart.title || chart.id),
          h(
            'button',
            { type: 'button', className: 'mw-link-btn mw-more', onClick: props.onRefresh },
            h(GlyphRefresh, null),
            ' ',
            t('recommend.refresh'),
          ),
        ),
        note ? h('p', { className: 'mw-chart-note' }, note) : null,
        body,
      )
    }

    const TORRENT_SITES = [
      { id: 'bt4g', label: 'BT4G', search: query => 'https://bt4gprx.com/search?q=' + encodeURIComponent(query) },
      { id: 'bitsearch', label: 'BitSearch', search: query => 'https://bitsearch.to/search?q=' + encodeURIComponent(query) },
    ]

    /** Two search spellings for one title: original title first, localized title second. */
    function torrentQuery(item) {
      const primary = (item.originalTitle || item.title || '').trim()
      const secondary = (item.title || '').trim()
      const year = item.year ? String(item.year) : ''
      const withYear = value => [value, year].filter(Boolean).join(' ').trim()
      const q = withYear(primary)
      const altValue = secondary && secondary !== primary ? withYear(secondary) : ''
      return { q: q, alt: altValue && altValue !== q ? altValue : '' }
    }

    /** Modal that shows the AI pick progress and its recommendation. */
    /** The AI resource-picker dialog: preferences, free mode and the result. */
    /** Shared model dropdown used by the AI pick dialog and the settings table. */
    function ModelPicker(props) {
      const t = props.t
      const catalog = props.catalog || null
      const models = catalog && Array.isArray(catalog.models) ? catalog.models : []
      const providers = catalog && Array.isArray(catalog.providers) ? catalog.providers : []
      const nameOfModel = (provider, model) => {
        const modelEntry = models.find(entry => entry && entry.provider === provider && entry.id === model)
        return modelEntry ? modelEntry.name || modelEntry.id : model
      }
      const providerNameOf = provider => {
        const providerEntry = providers.find(entry => entry && entry.id === provider)
        return providerEntry ? providerEntry.name : provider
      }
      const selection = catalog && catalog.selection ? catalog.selection : null
      const selected = props.value || (selection ? { provider: selection.provider, model: selection.model } : null)
      const stacked = props.layout === 'stacked'
      const emptyLabel = props.phase === 'loading' ? t('aiDialog.modelLoading') : t('aiDialog.modelEmpty')
      const [open, setOpen] = useState(false)
      const pickerRef = useRef(null)
      useEffect(() => {
        if (!open) return undefined
        function onPointerDown(event) {
          if (pickerRef.current && !pickerRef.current.contains(event.target)) setOpen(false)
        }
        function onKey(event) {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])
      const triggerBody = stacked
        ? h(
          'span',
          { className: 'mw-model-trigger-stack' },
          h('span', { className: 'mw-model-trigger-name' }, selected ? nameOfModel(selected.provider, selected.model) : emptyLabel),
          selected ? h('span', { className: 'mw-model-trigger-sub' }, providerNameOf(selected.provider)) : null,
        )
        : h(
          'span',
          { className: 'mw-model-trigger-label' },
          selected ? [providerNameOf(selected.provider), nameOfModel(selected.provider, selected.model)].join(' · ') : emptyLabel,
        )
      return h(
        'div',
        { className: 'mw-model-picker', ref: pickerRef },
        h(
          'button',
          {
            type: 'button',
            className: 'mw-model-trigger',
            'data-layout': stacked ? 'stacked' : 'inline',
            disabled: models.length === 0,
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            title: props.triggerTitle || '',
            onClick: () => setOpen(value => !value),
          },
          triggerBody,
          h('span', { className: 'mw-model-trigger-chevron' }, h(GlyphChevronDown, { size: 13 })),
        ),
        open
          ? h(
            'div',
            {
              className: 'mw-model-panel',
              'data-placement': props.placement || 'up',
              role: 'listbox',
              'aria-label': props.ariaLabel || t('aiDialog.modelLabel'),
            },
            models.length === 0
              ? h('p', { className: 'mw-model-empty' }, emptyLabel)
              : models.map(model => {
                const value = model.provider + '|' + model.id
                const isSelected = Boolean(selected && selected.provider === model.provider && selected.model === model.id)
                return h(
                  'button',
                  {
                    key: value,
                    type: 'button',
                    role: 'option',
                    'aria-selected': isSelected ? 'true' : 'false',
                    className: 'mw-model-option',
                    'data-selected': isSelected ? 'true' : 'false',
                    onClick: () => {
                      setOpen(false)
                      props.onChoose(value)
                    },
                  },
                  isSelected ? h('span', { className: 'mw-model-option-check', 'aria-hidden': 'true' }, '✓') : null,
                  h('span', { className: 'mw-model-option-name' }, model.name || model.id),
                  h('span', { className: 'mw-model-option-provider' }, providerNameOf(model.provider)),
                )
              }),
          )
          : null,
      )
    }

    function AiPickDialog(props) {
      const t = props.t
      const pick = props.aiPick || null
      const status = pick && pick.status ? pick.status : 'idle'
      const chosen = pick && pick.pick ? props.rows.find(row => row && row.id === pick.pick.id) : null
      const errorCode = pick && pick.code
        ? pick.code
        : pick && Array.isArray(pick.errors) && pick.errors[0]
          ? pick.errors[0].code
          : 'llm_error'
      const errorText = errorCode === 'llm_unavailable'
        ? t('aiDialog.unavailable')
        : errorCode === 'llm_no_model'
          ? t('aiDialog.noModel')
          : errorCode === 'interrupted'
            ? t('aiDialog.interrupted')
            : errorCode === 'bad_prompt' || errorCode === 'bad_preferences'
              ? t('torrent.aiFailed')
              : t('torrent.aiFailed')
      const modelPicker = h(
        'div',
        { className: 'mw-ai-dialog-model-picker' },
        h('span', { className: 'mw-ai-dialog-model-label' }, t('aiDialog.modelLabel')),
        h(ModelPicker, {
          t,
          catalog: props.models,
          phase: props.modelsPhase,
          value: props.model,
          onChoose: props.onChooseModel,
          placement: 'up',
          layout: 'inline',
          triggerTitle: t('aiDialog.modelHint'),
          ariaLabel: t('aiDialog.modelLabel'),
        }),
      )
      const prefs = props.prefs || AI_PICK_PREF_DEFAULTS
      useEffect(() => {
        function onKey(event) {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          props.onClose()
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [props.onClose])
      const prefRow = (dimension, label) => h(
        'div',
        { className: 'mw-ai-pref', key: dimension },
        h('span', { className: 'mw-ai-pref-label' }, label),
        h(
          'span',
          { className: 'mw-ai-pref-chips', role: 'group', 'aria-label': label },
          AI_PICK_PREF_VALUES[dimension].map(value => h(
            'button',
            {
              key: value,
              type: 'button',
              className: 'mw-ai-pref-chip',
              'data-selected': prefs[dimension] === value ? 'true' : 'false',
              'aria-pressed': prefs[dimension] === value ? 'true' : 'false',
              onClick: () => props.onPreferenceChange(dimension, value),
            },
            t('aiDialog.' + dimension + '.' + value),
          )),
        ),
      )
      const chosenMeta = chosen
        ? [
          chosen.size,
          typeof chosen.seeders === 'number' ? t('torrent.seeders', { count: chosen.seeders }) : '',
        ].filter(Boolean).join(' · ')
        : ''
      const modeSwitch = h(
        'div',
        { className: 'mw-ai-mode', role: 'group', 'aria-label': t('aiDialog.title') },
        h(
          'button',
          {
            type: 'button',
            className: 'mw-ai-mode-btn',
            'data-selected': props.free ? 'false' : 'true',
            'aria-pressed': props.free ? 'false' : 'true',
            onClick: () => props.onModeChange(false),
          },
          t('aiDialog.modeSimple'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'mw-ai-mode-btn',
            'data-selected': props.free ? 'true' : 'false',
            'aria-pressed': props.free ? 'true' : 'false',
            onClick: () => props.onModeChange(true),
          },
          t('aiDialog.modeFree'),
        ),
      )
      const prefSummary = [
        t('aiDialog.quality.' + prefs.quality),
        t('aiDialog.language.' + prefs.language),
        t('aiDialog.subtitle.' + prefs.subtitle),
      ].join(' · ')
      const prefBlock = props.free
        ? h('p', { className: 'mw-ai-pref-summary' }, t('aiDialog.prefSummary', { summary: prefSummary }))
        : h(
          'div',
          { className: 'mw-ai-prefs' },
          prefRow('quality', t('aiDialog.quality')),
          prefRow('language', t('aiDialog.language')),
          prefRow('subtitle', t('aiDialog.subtitle')),
        )
      let promptBlock = null
      if (props.free) {
        if (props.promptPhase === 'loading') {
          promptBlock = h('p', { className: 'mw-ai-prompt-note' }, t('aiDialog.promptLoading'))
        } else if (props.promptPhase === 'error') {
          promptBlock = h(
            'div',
            { className: 'mw-ai-prompt' },
            h('p', { className: 'mw-ai-prompt-note' }, t('aiDialog.promptFailed')),
            h(
              'button',
              { type: 'button', className: 'mw-btn', onClick: props.onResetPrompt },
              t('aiDialog.promptFailed'),
            ),
          )
        } else {
          promptBlock = h(
            'div',
            { className: 'mw-ai-prompt' },
            h(
              'div',
              { className: 'mw-ai-prompt-head' },
              h('span', { className: 'mw-ai-prompt-title' }, t('aiDialog.prompt')),
              h(
                'button',
                { type: 'button', className: 'mw-btn', onClick: props.onResetPrompt },
                t('aiDialog.resetPrompt'),
              ),
            ),
            h('textarea', {
              className: 'mw-ai-prompt-input',
              value: props.promptDraft,
              maxLength: 4000,
              spellCheck: false,
              placeholder: t('aiDialog.promptPlaceholder'),
              onChange: event => props.onPromptChange(event.target.value),
            }),
            h('p', { className: 'mw-ai-prompt-note' }, t('aiDialog.promptPlaceholder')),
          )
        }
      }
      const resultBlock = status === 'done' && pick && pick.pick
        ? h(
          'div',
          { className: 'mw-ai-dialog-result' },
          h('h3', { className: 'mw-ai-dialog-result-title' }, t('aiDialog.result')),
          h('p', { className: 'mw-ai-dialog-chosen' }, chosen ? chosen.title : pick.pick.id),
          chosenMeta ? h('p', { className: 'mw-ai-dialog-chosen-meta' }, chosenMeta) : null,
          pick.pick.reason
            ? h(
              'p',
              { className: 'mw-ai-dialog-reason' },
              h('strong', null, t('aiDialog.reason') + '：'),
              pick.pick.reason,
            )
            : null,
          props.free && pick.analysis
            ? h('h3', { className: 'mw-ai-dialog-result-title' }, t('aiDialog.raw'))
            : null,
          props.free && pick.analysis ? h('pre', { className: 'mw-ai-raw' }, pick.analysis) : null,
        )
        : status === 'error'
          ? h(
            'div',
            { className: 'mw-ai-dialog-result', 'data-state': 'error' },
            h('p', { className: 'mw-ai-dialog-reason' }, errorText),
          )
          : null
      return h(
        'div',
        {
          className: 'mw-modal-overlay',
          onMouseDown: event => {
            if (event.target === event.currentTarget) props.onClose()
          },
        },
        h(
          'div',
          {
            className: 'mw-modal mw-ai-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'mw-ai-dialog-title',
            onMouseDown: event => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'mw-modal-head' },
            h('h2', { className: 'mw-modal-title', id: 'mw-ai-dialog-title' }, t('aiDialog.title')),
            h(
              'div',
              { className: 'mw-modal-head-actions' },
              modeSwitch,
              h(
                'button',
                { type: 'button', className: 'mw-modal-close', onClick: props.onClose, 'aria-label': t('aiDialog.close') },
                '×',
              ),
            ),
          ),
          h(
            'div',
            { className: 'mw-modal-body' },
            h('p', { className: 'mw-ai-dialog-item' }, props.item.title || ''),
            props.free ? h('p', { className: 'mw-ai-free-hint' }, t('aiDialog.freeHint')) : null,
            prefBlock,
            promptBlock,
            status === 'loading'
              ? h(
                'p',
                { className: 'mw-ai-running' },
                t('aiDialog.running'),
                '· ' + t('aiDialog.elapsed', { seconds: props.elapsed }),
              )
              : null,
            resultBlock,
          ),
          h(
            'div',
            { className: 'mw-modal-actions mw-ai-dialog-actions' },
            modelPicker,
            h(
              'div',
              { className: 'mw-ai-dialog-buttons' },
              status === 'idle'
                ? h('button', { type: 'button', className: 'mw-btn mw-btn-primary', onClick: props.onStart }, t('aiDialog.start'))
                : status === 'done' || status === 'error'
                  ? h('button', { type: 'button', className: 'mw-btn mw-btn-primary', onClick: props.onStart }, t('aiDialog.reevaluate'))
                  : null,
              h('button', { type: 'button', className: 'mw-btn', onClick: props.onClose }, t('aiDialog.close')),
            ),
          ),
        ),
      )
    }

    /** "BT resources" block under one detail page; results are cached per title. */
    function TorrentSection(props) {
      const t = props.t
      const item = props.item
      const lang = props.lang || 'zh-CN'
      const cacheKey = searchKey(item)
      const cached = session.torrents && session.torrents[cacheKey]
      const [view, setView] = useState(() => (
        cached || { status: 'loading', results: [], errors: [], tookMs: 0, query: '' }
      ))
      const [attempt, setAttempt] = useState(0)
      const [copyState, setCopyState] = useState(null)
      const [sort, setSort] = useState({ key: 'default', direction: 'desc' })
      const [loadingMore, setLoadingMore] = useState(false)
      const [moreFailure, setMoreFailure] = useState(null)
      const copyTimerRef = useRef(null)
      const moreRef = useRef(null)
      const moreTimerRef = useRef(null)

      /** AI pick state lives on the cached view so a remount keeps the answer. */
      const aiPick = view.aiPick || null
      const aiPicking = Boolean(aiPick && aiPick.status === 'loading')
      const [aiDialogOpen, setAiDialogOpen] = useState(false)
      const [aiElapsed, setAiElapsed] = useState(0)
      const [aiModelPrefs, setAiModelPrefs] = useState(readAiModelPrefs)
      const aiModels = props.aiModels || null
      const aiModelsPhase = props.aiModelsPhase || 'idle'
      const [aiPrefs, setAiPrefs] = useState(readAiPickPrefs)
      const [aiFree, setAiFree] = useState(readAiFreeMode)
      const [aiPromptPhase, setAiPromptPhase] = useState('idle')
      const [aiPromptDraft, setAiPromptDraft] = useState('')
      const aiPromptAbortRef = useRef(null)
      const aiInFlightRef = useRef(false)
      const aiStartedAtRef = useRef(0)

      useEffect(() => {
        if (!aiDialogOpen || !aiPicking) return undefined
        const tick = () => setAiElapsed(Math.max(0, Math.round((Date.now() - aiStartedAtRef.current) / 1000)))
        tick()
        const timer = setInterval(tick, 1000)
        return () => clearInterval(timer)
      }, [aiDialogOpen, aiPicking])

      useEffect(() => () => {
        if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
        if (moreTimerRef.current) window.clearTimeout(moreTimerRef.current)
      }, [])
      const { q: primaryQuery, alt } = torrentQuery(item)

      /** Request one page of BT rows for this title (page 1 is the first page). */
      function requestTorrentsPage(page, signal) {
        const { q, alt: altQuery } = torrentQuery(item)
        const params = new URLSearchParams()
        params.set('q', q)
        params.set('source', 'all')
        params.set('limit', '20')
        params.set('page', String(page))
        if (altQuery) params.set('alt', altQuery)
        return callApi('/torrents?' + params.toString(), {
          headers: { accept: 'application/json' },
          signal: signal,
        }).then(body => ({
          rows: Array.isArray(body.results) ? body.results : [],
          errors: Array.isArray(body.errors) ? body.errors : [],
          tookMs: body.tookMs || 0,
          page: body.page || page,
          hasMore: Boolean(body.hasMore),
          query: body.query || q,
        }))
      }

      useEffect(() => {
        if (attempt === 0) {
          const hit = session.torrents && session.torrents[cacheKey]
          if (hit && hit.status !== 'loading') return undefined
        }
        const { q } = torrentQuery(item)
        if (!q) {
          setView({ status: 'done', results: [], errors: [], tookMs: 0, query: '' })
          return undefined
        }
        const controller = new AbortController()
        let live = true
        setMoreFailure(null)
        setLoadingMore(false)
        setView({ status: 'loading', results: [], errors: [], tookMs: 0, query: q })
        requestTorrentsPage(1, controller.signal)
          .then(page => {
            if (!live) return
            const done = {
              status: 'done',
              results: page.rows,
              errors: page.errors,
              tookMs: page.tookMs,
              page: page.page,
              hasMore: page.hasMore,
              query: page.query,
            }
            session.torrents = { ...(session.torrents || {}), [cacheKey]: done }
            setView(done)
          })
          .catch(error => {
            if (!live || controller.signal.aborted) return
            setView({
              status: 'error',
              results: [],
              errors: [],
              tookMs: 0,
              failure: error && error.code ? error.code : 'network',
              query: q,
            })
          })
        return () => {
          live = false
          controller.abort()
        }
      }, [cacheKey, attempt])

      /**
       * Append the next page of BT rows. Rows are deduped by info hash because
       * pages from different indexes can overlap, and the last failed page is
       * kept so the retry button can ask for it again.
       */
      function loadMore() {
        if (loadingMore || !view.hasMore || view.status !== 'done') return
        const nextPage = (view.page || 1) + 1
        setLoadingMore(true)
        setMoreFailure(null)
        const controller = new AbortController()
        requestTorrentsPage(nextPage, controller.signal)
          .then(page => {
            const seen = new Set((view.results || []).map(row => row && row.id))
            const extra = page.rows.filter(row => row && !seen.has(row.id))
            const merged = {
              ...view,
              results: (view.results || []).concat(extra),
              errors: page.errors,
              tookMs: page.tookMs,
              page: page.page,
              hasMore: page.hasMore,
            }
            session.torrents = { ...(session.torrents || {}), [cacheKey]: merged }
            setView(merged)
          })
          .catch(error => {
            if (controller.signal.aborted) return
            setMoreFailure(error && error.code ? error.code : 'network')
          })
          .finally(() => setLoadingMore(false))
      }

      /* Infinite scroll: the footer sentinel loads the next page when it comes
         near the viewport (with a button as the accessible fallback). */
      useEffect(() => {
        if (view.status !== 'done' || !view.hasMore || loadingMore) return undefined
        const node = moreRef.current
        if (!node || typeof IntersectionObserver !== 'function') return undefined
        const observer = new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) loadMore()
        }, { rootMargin: '240px 0px' })
        observer.observe(node)
        return () => observer.disconnect()
      }, [view.status, view.hasMore, view.page, loadingMore, view.results.length])

      const retry = () => {
        setMoreFailure(null)
        setLoadingMore(false)
        setView({ status: 'loading', results: [], errors: [], tookMs: 0, query: primaryQuery })
        setAttempt(value => value + 1)
      }

      const toggleSort = key => setSort(previous => (
        previous.key === key
          ? { key, direction: previous.direction === 'desc' ? 'asc' : 'desc' }
          : { key, direction: 'desc' }
      ))

      // Sorting is a view over the fetched rows: entries without the metric
      // (BT4G publishes no swarm counts) stay at the end in either direction.
      const sortedResults = useMemo(() => {
        const rows = Array.isArray(view.results) ? view.results : []
        if (sort.key === 'default' || rows.length < 2) return rows
        const direction = sort.direction === 'asc' ? 1 : -1
        const metric = row => {
          if (sort.key === 'size') return sizeToBytes(row.size)
          const value = row[sort.key]
          return value === null || value === undefined ? null : Number(value)
        }
        return rows.slice().sort((left, right) => {
          const a = metric(left)
          const b = metric(right)
          if (a === null && b === null) return 0
          if (a === null) return 1
          if (b === null) return -1
          return (a - b) * direction
        })
      }, [view.results, sort])

      /** Copy one magnet link and flash the row's button label for a moment. */
      const copyMagnet = (magnet, rowKey) => {
        const mark = ok => {
          if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
          setCopyState({ key: rowKey, ok })
          copyTimerRef.current = window.setTimeout(() => setCopyState(null), 1800)
        }
        const fallbackCopy = () => {
          let area = null
          try {
            area = document.createElement('textarea')
            area.value = magnet
            area.setAttribute('readonly', '')
            area.style.position = 'fixed'
            area.style.top = '-1000px'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
            document.body.removeChild(area)
            mark(Boolean(copied))
          } catch (error) {
            if (area && area.parentNode) area.parentNode.removeChild(area)
            mark(false)
          }
        }
        if (
          typeof navigator !== 'undefined'
          && navigator.clipboard
          && typeof navigator.clipboard.writeText === 'function'
        ) {
          navigator.clipboard.writeText(magnet).then(() => mark(true)).catch(fallbackCopy)
          return
        }
        fallbackCopy()
      }
      /**
       * Ask the Host to choose the best row. The browser never sees a model
       * credential: it sends the title plus the rows it is showing, and the
       * Host streams one model call through the DSH LLM service.
       */
      /** Open the dialog; the evaluation itself only starts on demand. */
      function openAiPick() {
        if (view.status !== 'done' || sortedResults.length === 0) return
        setAiDialogOpen(true)
        setAiElapsed(0)
        if (props.onLoadAiModels && aiModelsPhase !== 'done' && aiModelsPhase !== 'loading') props.onLoadAiModels()
        if (aiFree && aiPromptPhase !== 'done') loadAiPrompt(aiPrefs)
        if (aiPicking && !aiInFlightRef.current) {
          // A persisted "loading" state without a live request (page switched
          // away mid-call) can never finish on its own.
          setView({
            ...view,
            aiPick: { status: 'error', pick: null, picks: [], analysis: '', errors: [], code: 'interrupted' },
          })
        }
      }

      /** The explicit "start / evaluate again" action of the dialog. */
      function startAiPick() {
        if (view.status !== 'done' || sortedResults.length === 0) return
        setAiDialogOpen(true)
        if (aiPicking) return
        aiInFlightRef.current = true
        aiStartedAtRef.current = Date.now()
        setAiElapsed(0)
        const rows = sortedResults.slice(0, 20).map(row => ({
          id: row.id,
          title: row.title,
          size: row.size || '',
          source: row.source || '',
          seeders: row.seeders,
          leechers: row.leechers,
        }))
        const loadingView = { ...view, aiPick: { status: 'loading' } }
        setView(loadingView)
        session.torrents = { ...(session.torrents || {}), [cacheKey]: loadingView }
        callApi('/pick', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            item: { source: item.source, id: item.id, title: item.title, kind: item.kind, year: item.year },
            rows: rows,
            lang: lang,
            preferences: aiPrefs,
            ...(aiFree && aiPromptDraft.trim() ? { prompt: aiPromptDraft.trim() } : {}),
            ...(aiModelPrefs ? { model: aiModelPrefs } : {}),
          }),
        }).then(body => {
          const pick = body && body.pick && typeof body.pick.id === 'string' ? body.pick : null
          const errors = Array.isArray(body && body.errors) ? body.errors : []
          const done = {
            ...loadingView,
            aiPick: {
              status: pick ? 'done' : 'error',
              pick: pick,
              picks: Array.isArray(body && body.picks) ? body.picks : [],
              analysis: body && body.analysis ? String(body.analysis).slice(0, 2000) : '',
              provider: body && body.provider ? body.provider : null,
              model: body && body.model ? body.model : null,
              errors: errors,
              code: errors.length > 0 ? errors[0].code : (pick ? null : 'llm_error'),
              prompt: body && typeof body.prompt === 'string' ? body.prompt.slice(0, 4000) : '',
              preferences: aiPrefs,
              free: Boolean(aiFree),
            },
          }
          session.torrents = { ...(session.torrents || {}), [cacheKey]: done }
          setView(done)
        }).catch(error => {
          const failed = {
            ...loadingView,
            aiPick: {
              status: 'error',
              pick: null,
              picks: [],
              analysis: '',
              errors: [],
              code: error && error.code ? error.code : 'network',
            },
          }
          session.torrents = { ...(session.torrents || {}), [cacheKey]: failed }
          setView(failed)
        }).finally(() => {
          aiInFlightRef.current = false
        })
      }

      /** Mirror the settings model choice, so the next request uses it. */
      function chooseDialogModel(value) {
        if (props.onChooseAiModel) props.onChooseAiModel(value)
        setAiModelPrefs(readAiModelPrefs())
      }

      function retryAiPick() {
        setAiDialogOpen(true)
        startAiPick()
      }

      /** The same row subset that startAiPick sends to the Host. */
      function pickRowsPayload() {
        return sortedResults.slice(0, 20).map(row => ({
          id: row.id,
          title: row.title,
          size: row.size || '',
          source: row.source || '',
          seeders: row.seeders,
          leechers: row.leechers,
        }))
      }

      /** Ask the Host for the default prompt text (free mode editor). */
      function loadAiPrompt(prefs) {
        if (aiPromptAbortRef.current) aiPromptAbortRef.current.abort()
        const controller = new AbortController()
        aiPromptAbortRef.current = controller
        setAiPromptPhase('loading')
        callApi('/pick', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            item: { source: item.source, id: item.id, title: item.title, kind: item.kind, year: item.year },
            rows: pickRowsPayload(),
            lang: lang,
            preview: true,
            preferences: prefs || aiPrefs,
          }),
        }).then(body => {
          if (controller.signal.aborted) return
          setAiPromptDraft(body && typeof body.prompt === 'string' ? body.prompt : '')
          setAiPromptPhase('done')
        }).catch(() => {
          if (controller.signal.aborted) return
          setAiPromptPhase('error')
        })
      }

      function updateAiPref(dimension, value) {
        const next = { ...aiPrefs, [dimension]: value }
        setAiPrefs(next)
        writeAiPickPrefs(next)
        if (aiFree) loadAiPrompt(next)
      }

      function setAiFreeMode(next) {
        if (Boolean(next) === aiFree) return
        setAiFree(next)
        writeAiFreeMode(next)
        if (next && aiPromptPhase !== 'done') loadAiPrompt(aiPrefs)
      }

      /** One banner explains the AI result above the list. */
      let aiBanner = null
      if (view.status === 'done' && sortedResults.length > 0 && aiPick) {
        if (aiPick.status === 'loading') {
          aiBanner = h(
            'p',
            { className: 'mw-ai-pick', 'data-state': 'loading', role: 'status' },
            h('span', { className: 'mw-ai-pick-dot', 'aria-hidden': 'true' }),
            t('torrent.aiPicking'),
          )
        } else if (aiPick.status === 'error') {
          const code = aiPick.code || (Array.isArray(aiPick.errors) && aiPick.errors[0] && aiPick.errors[0].code) || 'llm_error'
          const message = code === 'llm_unavailable'
            ? t('torrent.aiUnavailable')
            : code === 'llm_no_model'
              ? t('torrent.aiNoModel')
              : t('torrent.aiFailed')
          aiBanner = h(
            'div',
            { className: 'mw-ai-pick', 'data-state': 'error' },
            h(GlyphWarning, null),
            h('span', { className: 'mw-ai-pick-text' }, message),
            h('button', { type: 'button', className: 'mw-link-btn mw-more', onClick: retryAiPick }, t('torrent.retry')),
          )
        } else if (aiPick.pick) {
          const chosen = sortedResults.find(row => row && row.id === aiPick.pick.id)
          aiBanner = h(
            'div',
            { className: 'mw-ai-pick', 'data-state': 'done' },
            h(GlyphSparkle, null),
            h(
              'span',
              { className: 'mw-ai-pick-text' },
              h('strong', null, t('torrent.aiRecommend') + '：'),
              chosen ? chosen.title : aiPick.pick.id,
              aiPick.pick.reason
                ? h('span', { className: 'mw-ai-pick-reason' }, ' — ' + aiPick.pick.reason)
                : null,
            ),
          )
        } else {
          aiBanner = h('div', { className: 'mw-ai-pick', 'data-state': 'empty' }, t('torrent.aiNoPick'))
        }
      }

      const fallbackQuery = alt || primaryQuery || item.title || ''

      /* Paged loading footer: sentinel + button while more pages exist, a
         failure hint that retries the same page, and an end note. */
      let moreFooter = null
      if (view.status === 'done' && sortedResults.length > 0) {
        if (moreFailure) {
          moreFooter = h(RecommendHint, {
            t: t,
            text: t('torrent.moreFailed'),
            actionLabel: t('torrent.retry'),
            onAction: loadMore,
          })
        } else if (loadingMore) {
          moreFooter = h(
            'p',
            { className: 'mw-torrent-more-note', role: 'status' },
            t('torrent.loadingMore'),
          )
        } else if (view.hasMore) {
          moreFooter = h(
            'div',
            { className: 'mw-torrent-more', ref: moreRef },
            h(
              'button',
              { type: 'button', className: 'mw-btn', onClick: loadMore },
              t('torrent.loadMore'),
            ),
          )
        } else {
          moreFooter = h('p', { className: 'mw-torrent-more-note' }, t('torrent.end'))
        }
      }

      let body = null
      if (view.status === 'loading') {
        const rows = []
        for (let index = 0; index < 4; index += 1) {
          rows.push(h(
            'div',
            { className: 'mw-torrent-skeleton', key: 'torrent-skeleton-' + index },
            h('div', { className: 'mw-skeleton-line' }),
            h('div', { className: 'mw-skeleton-line', 'data-short': 'true' }),
          ))
        }
        body = h(
          'div',
          { className: 'mw-torrent-loading', role: 'status' },
          h('span', { className: 'mw-sr-only' }, t('torrent.loading')),
          rows,
        )
      } else if (view.status === 'error') {
        body = h(RecommendHint, {
          t: t,
          text: t('torrent.failed'),
          actionLabel: t('torrent.retry'),
          onAction: retry,
        })
      } else if (!view.results || view.results.length === 0) {
        body = h(
          'div',
          null,
          h('p', { className: 'mw-torrent-empty' }, t('torrent.empty')),
          h(
            'div',
            { className: 'mw-torrent-links' },
            TORRENT_SITES.map(site => h(
              'a',
              {
                className: 'mw-btn',
                key: 'torrent-site-' + site.id,
                href: site.search(fallbackQuery),
                target: '_blank',
                rel: 'noreferrer noopener',
              },
              t('torrent.searchOn', { site: site.label }),
            )),
          ),
        )
      } else {
        body = h(
          'div',
          null,
          aiBanner,
          h(
          'div',
          { className: 'mw-torrent-list', role: 'list' },
          sortedResults.map((row, index) => {
            const rowKey = (row.source || 'source') + '-' + (row.id || index)
            const feedback = copyState && copyState.key === rowKey ? copyState : null
            const isAiPick = Boolean(aiPick && aiPick.pick && aiPick.pick.id === row.id)
            return h(
            'div',
            {
              className: 'mw-torrent-row' + (isAiPick ? ' mw-torrent-row-pick' : ''),
              role: 'listitem',
              key: rowKey,
            },
            h(
              'div',
              { className: 'mw-torrent-main' },
              h(
                'p',
                { className: 'mw-torrent-title', title: row.title },
                row.title,
                isAiPick ? h('span', { className: 'mw-torrent-ai-badge' }, t('torrent.aiRecommend')) : null,
              ),
              h(
                'p',
                { className: 'mw-torrent-meta' },
                row.size ? h('span', null, row.size) : null,
                row.seeders !== null && row.seeders !== undefined
                  ? h('span', { className: 'mw-torrent-seed' }, t('torrent.seeders', { count: row.seeders }))
                  : null,
                row.leechers !== null && row.leechers !== undefined
                  ? h('span', null, t('torrent.leechers', { count: row.leechers }))
                  : null,
              ),
            ),
            h(
              'div',
              { className: 'mw-torrent-actions' },
              row.magnet
                ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'mw-btn mw-btn-primary mw-torrent-copy',
                    onClick: () => copyMagnet(row.magnet, rowKey),
                    title: t('torrent.copy'),
                    'aria-label': t('torrent.copy'),
                  },
                  feedback ? (feedback.ok ? t('torrent.copied') : t('torrent.copyFailed')) : t('torrent.copy'),
                )
                : null,
              row.page
                ? h(
                  'a',
                  { className: 'mw-btn', href: row.page, target: '_blank', rel: 'noreferrer noopener' },
                  t('torrent.page'),
                )
                : null,
            ),
            )
          }),
          ),
          moreFooter,
        )
      }

      return h(
        'section',
        { className: 'mw-torrents', 'aria-label': t('torrent.title') },
        h(
          'div',
          { className: 'mw-torrents-head' },
          h('h2', { className: 'mw-torrents-title' }, t('torrent.title')),
          h('span', { className: 'mw-torrents-note' }, t('torrent.note')),
          h(
            'div',
            { className: 'mw-torrents-tools' },
            view.status === 'done' && sortedResults.length > 0
              ? h(
                'button',
                {
                  type: 'button',
                  className: 'mw-btn mw-ai-pick-btn',
                  'data-picking': aiPicking ? 'true' : 'false',
                  disabled: aiPicking,
                  onClick: openAiPick,
                  title: t('torrent.aiPick'),
                },
                h(GlyphSparkle, null),
                t('torrent.aiPick'),
              )
              : null,
            view.status === 'done' && sortedResults.length > 1
              ? h(
                'div',
                { className: 'mw-torrents-sort', role: 'group', 'aria-label': t('torrent.sort.label') },
                ['default', 'seeders', 'leechers', 'size'].map(key => {
                  const active = sort.key === key
                  const direction = sort.direction === 'desc' ? t('torrent.sort.desc') : t('torrent.sort.asc')
                  return h(
                    'button',
                    {
                      type: 'button',
                      className: 'mw-sort-chip',
                      key: 'torrent-sort-' + key,
                      'data-selected': active ? 'true' : 'false',
                      'aria-pressed': active ? 'true' : 'false',
                      title: active && key !== 'default' ? direction : t('torrent.sort.' + key),
                      onClick: () => {
                        if (key === 'default') setSort({ key: 'default', direction: 'desc' })
                        else toggleSort(key)
                      },
                    },
                    t('torrent.sort.' + key),
                    active && key !== 'default'
                      ? h('span', { className: 'mw-sort-arrow', 'aria-hidden': 'true' }, sort.direction === 'desc' ? '\u2193' : '\u2191')
                      : null,
                  )
                }),
              )
              : null,
            h(
              'button',
              { type: 'button', className: 'mw-link-btn mw-more', onClick: retry, title: t('recommend.refresh') },
              h(GlyphRefresh, null),
              ' ',
              t('recommend.refresh'),
            ),
          ),
        ),
        body,
        aiDialogOpen
          ? h(AiPickDialog, {
            t: t,
            item: item,
            rows: sortedResults,
            aiPick: aiPick,
            model: aiModelPrefs,
            models: aiModels,
            modelsPhase: aiModelsPhase,
            elapsed: aiElapsed,
            prefs: aiPrefs,
            free: aiFree,
            promptDraft: aiPromptDraft,
            promptPhase: aiPromptPhase,
            onPreferenceChange: updateAiPref,
            onChooseModel: chooseDialogModel,
            onModeChange: setAiFreeMode,
            onPromptChange: setAiPromptDraft,
            onResetPrompt: () => loadAiPrompt(aiPrefs),
            onStart: startAiPick,
            onClose: () => setAiDialogOpen(false),
          })
          : null,
      )
    }

    /** A TMDB collection page: every part of the franchise. */
    function CollectionPage(props) {
      const t = props.t
      const view = props.view || {}
      const collection = view.collection || {}
      const items = Array.isArray(view.items) ? view.items : []
      const backRef = useRef(null)

      useEffect(() => {
        if (backRef.current) backRef.current.focus()
      }, [])

      let body = null
      if (view.status === 'loading') {
        body = h(Skeleton, null)
      } else if (view.status === 'error') {
        body = h(ErrorState, {
          t: t,
          code: view.failure || 'network',
          onRetry: props.onRetry,
        })
      } else if (items.length === 0) {
        body = h(
          'div',
          { className: 'mw-idle' },
          h(RecommendHint, { t: t, text: t('collection.empty') }),
        )
      } else {
        body = h(
          'div',
          { className: 'mw-grid' },
          items.map(item => h(ResultCard, {
            key: searchKey(item),
            t: t,
            item: item,
            showSource: false,
            onSelect: props.onSelect,
          })),
        )
      }

      const note = [collection.overview, items.length > 0 ? t('collection.count', { count: items.length }) : '']
        .filter(Boolean)
        .join(' · ')

      return h(
        'div',
        { className: 'mw-detail-page', role: 'region', 'aria-label': collection.name || String(collection.id || '') },
        h(
          'button',
          { type: 'button', className: 'mw-back', ref: backRef, onClick: props.onBack },
          h(GlyphChevronLeft, { size: 15 }),
          t('collection.back'),
        ),
        h(
          'div',
          { className: 'mw-channel-head' },
          h('h2', { className: 'mw-channel-title' }, collection.name || String(collection.id || '')),
          h(
            'button',
            { type: 'button', className: 'mw-link-btn mw-more', onClick: props.onRetry },
            h(GlyphRefresh, null),
            ' ',
            t('recommend.refresh'),
          ),
        ),
        note ? h('p', { className: 'mw-collection-note' }, note) : null,
        body,
      )
    }

    /** The IMDb connection chain of one title: every related part. */
    function SeriesPage(props) {
      const t = props.t
      const view = props.view || {}
      const series = view.series || {}
      const items = Array.isArray(view.items) ? view.items : []
      const backRef = useRef(null)

      useEffect(() => {
        if (backRef.current) backRef.current.focus()
      }, [])

      let body = null
      if (view.status === 'loading') {
        body = h(Skeleton, null)
      } else if (view.status === 'error') {
        body = h(ErrorState, {
          t: t,
          code: view.failure || 'network',
          onRetry: props.onRetry,
        })
      } else if (items.length === 0) {
        body = h(
          'div',
          { className: 'mw-idle' },
          h(RecommendHint, { t: t, text: t('series.empty') }),
        )
      } else {
        body = h(
          'div',
          { className: 'mw-grid' },
          items.map(item => h(ResultCard, {
            key: searchKey(item),
            t: t,
            item: item,
            showSource: false,
            onSelect: props.onSelect,
          })),
        )
      }

      const note = items.length > 0
        ? t('series.count', { count: items.length }) + (series.truncated ? ' · ' + t('series.truncated', { count: series.items.length }) : '')
        : ''

      return h(
        'div',
        { className: 'mw-detail-page', role: 'region', 'aria-label': series.title || t('series.label') },
        h(
          'button',
          { type: 'button', className: 'mw-back', ref: backRef, onClick: props.onBack },
          h(GlyphChevronLeft, { size: 15 }),
          t('series.back'),
        ),
        h(
          'div',
          { className: 'mw-channel-head' },
          h('h2', { className: 'mw-channel-title' }, series.title || t('series.label')),
          h(
            'button',
            { type: 'button', className: 'mw-link-btn mw-more', onClick: props.onRetry },
            h(GlyphRefresh, null),
            ' ',
            t('recommend.refresh'),
          ),
        ),
        note ? h('p', { className: 'mw-collection-note' }, note) : null,
        body,
      )
    }

    /** One related collection / series / chart, shown inline on the detail page. */
    function RelatedCard(props) {
      return h(
        'button',
        { type: 'button', className: 'mw-related-card', onClick: props.onOpen, 'aria-label': props.name },
        props.cover
          ? h(
            'span',
            { className: 'mw-related-cover' },
            h('img', { src: posterUrl(props.cover), alt: '', loading: 'lazy' }),
          )
          : null,
        h(
          'span',
          { className: 'mw-related-text' },
          h('span', { className: 'mw-related-name' }, props.name),
          props.meta ? h('span', { className: 'mw-related-meta' }, props.meta) : null,
        ),
      )
    }

    /** A labelled row of related cards, shared by TMDB, IMDb and DouBan. */
    function RelatedSection(props) {
      return h(
        'div',
        { className: 'mw-related' },
        h('p', { className: 'mw-related-label' }, props.label),
        h('div', { className: 'mw-related-cards' }, props.children),
      )
    }

    function detailMeta(detail) {
      if (!detail || typeof detail !== 'object') return null
      const genres = Array.isArray(detail.genres) ? detail.genres.filter(Boolean) : []
      const region = typeof detail.region === 'string' ? detail.region.trim() : ''
      const runtime = detail.runtime || ''
      if (!region && genres.length === 0 && !runtime) return null
      return { region, genres, runtime }
    }

    function DetailPage(props) {
      const t = props.t
      const item = props.item
      const backRef = useRef(null)
      // The detail is its own page: start focus on its back control rather than
      // leaving keyboard focus on a card that has just been replaced.
      useEffect(() => {
        if (backRef.current) backRef.current.focus()
      }, [])
      const cacheKey = String(item.source) + '|' + String(item.id)
      const cachedDetail = session.details ? session.details[cacheKey] : null
      const [overview, setOverview] = useState(
        item.overview || (cachedDetail && cachedDetail.overview) || '',
      )
      const [collection, setCollection] = useState(
        (cachedDetail && cachedDetail.collection) || null,
      )
      const [rankings, setRankings] = useState(
        (cachedDetail && Array.isArray(cachedDetail.collections)) ? cachedDetail.collections : [],
      )
      const [series, setSeries] = useState(
        (cachedDetail && cachedDetail.series) || null,
      )
      const [meta, setMeta] = useState(
        (cachedDetail && cachedDetail.meta) || null,
      )
      const [detailYear, setDetailYear] = useState(
        (cachedDetail && cachedDetail.year) || null,
      )
      const [overviewPhase, setOverviewPhase] = useState(() => {
        if (item.overview) return 'done'
        if (cachedDetail) return cachedDetail.overview ? 'done' : 'missing'
        return item.source === 'douban' ? 'loading' : 'missing'
      })
      // The 豆瓣 suggestion/search payloads carry no synopsis, so it is loaded
      // lazily from the subject detail route when the page opens for a title.
      useEffect(() => {
        if (item.overview || item.source !== 'douban') return undefined
        const cached = session.details && session.details[cacheKey]
        if (cached && 'meta' in cached) return undefined
        let cancelled = false
        setOverviewPhase('loading')
        callApi('/detail?source=douban&id=' + encodeURIComponent(String(item.id)))
          .then((body) => {
            if (cancelled) return
            const detail = body && body.detail && typeof body.detail === 'object' ? body.detail : null
            const text = detail && typeof detail.overview === 'string' ? detail.overview.trim() : ''
            const collections = detail && Array.isArray(detail.collections) ? detail.collections : []
            const foundMeta = detail ? detailMeta(detail) : null
            const foundYear = detail && Number.isInteger(detail.year) ? detail.year : null
            if (!session.details) session.details = {}
            session.details[cacheKey] = {
              ...(session.details[cacheKey] || {}),
              overview: text,
              collections: collections,
              meta: foundMeta,
              year: foundYear,
            }
            setOverview(text)
            setRankings(collections)
            setMeta(foundMeta)
            setDetailYear(foundYear)
            setOverviewPhase(text ? 'done' : 'missing')
          })
          .catch(() => {
            if (cancelled) return
            if (!session.details) session.details = {}
            session.details[cacheKey] = { ...(session.details[cacheKey] || {}), overview: '' }
            setOverviewPhase('missing')
          })
        return () => {
          cancelled = true
        }
      }, [cacheKey, item.overview, item.source, item.id])
      // TMDB movie details carry `belongs_to_collection`; load it lazily once
      // per title so the page can offer the whole franchise.
      useEffect(() => {
        if (item.source !== 'tmdb' || item.kind !== 'movie') return undefined
        const hit = session.details && session.details[cacheKey]
        if (hit && 'collection' in hit && 'meta' in hit) return undefined
        let cancelled = false
        const headers = { accept: 'application/json' }
        const storedKey = readTmdbKey()
        if (storedKey) headers['x-mw-tmdb-key'] = storedKey
        callApi('/detail?source=tmdb&id=' + encodeURIComponent(String(item.id)), { headers })
          .then((body) => {
            if (cancelled) return
            const detail = body && body.detail && typeof body.detail === 'object' ? body.detail : null
            const found = detail && detail.collection && typeof detail.collection === 'object'
              ? detail.collection
              : null
            // A missing credential is recoverable: do not cache "no collection",
            // so saving a key and reopening the title fetches again.
            const errors = body && Array.isArray(body.errors) ? body.errors : []
            const keyMissing = errors.some(error => error && error.code === 'tmdb_key_missing')
            const foundMeta = detail ? detailMeta(detail) : null
            const foundYear = detail && Number.isInteger(detail.year) ? detail.year : null
            if (!session.details) session.details = {}
            if (!keyMissing) {
              session.details[cacheKey] = {
                ...(session.details[cacheKey] || {}),
                collection: found,
                meta: foundMeta,
                year: foundYear,
              }
            }
            setCollection(found)
            setMeta(foundMeta)
            setDetailYear(foundYear)
          })
          .catch(() => {
            if (cancelled) return
            if (!session.details) session.details = {}
            session.details[cacheKey] = { ...(session.details[cacheKey] || {}), collection: null }
          })
        return () => {
          cancelled = true
        }
      }, [cacheKey, item.source, item.kind, item.id])
      // IMDb has no collection entity; its "series" is the connection chain
      // (follows / followed by / spin-off), fetched lazily for the card.
      useEffect(() => {
        if (item.source !== 'imdb') return undefined
        const cached = session.details && session.details[cacheKey]
        if (cached && cached.series !== undefined) {
          setSeries(cached.series)
          return undefined
        }
        let cancelled = false
        callApi('/series?source=imdb&id=' + encodeURIComponent(String(item.id)))
          .then((body) => {
            if (cancelled) return
            const found = body && body.series && typeof body.series === 'object' ? body.series : null
            setSeries(found)
            if (!session.details) session.details = {}
            session.details[cacheKey] = { ...(session.details[cacheKey] || {}), series: found }
          })
          .catch(() => {
            if (cancelled) return
            setSeries(null)
          })
        return () => {
          cancelled = true
        }
      }, [cacheKey, item.source, item.id])

      // IMDb detail metadata (origin countries, genres, runtime and the real
      // plot) comes from the same browser GraphQL endpoint as the search feed.
      useEffect(() => {
        if (item.source !== 'imdb') return undefined
        const hit = session.details && session.details[cacheKey]
        if (hit && hit.meta !== undefined) {
          setMeta(hit.meta || null)
          return undefined
        }
        let cancelled = false
        callApi('/detail?source=imdb&id=' + encodeURIComponent(String(item.id)))
          .then((body) => {
            if (cancelled) return
            const detail = body && body.detail && typeof body.detail === 'object' ? body.detail : null
            const foundMeta = detail ? detailMeta(detail) : null
            const foundYear = detail && Number.isInteger(detail.year) ? detail.year : null
            if (!session.details) session.details = {}
            session.details[cacheKey] = { ...(session.details[cacheKey] || {}), meta: foundMeta, year: foundYear }
            setMeta(foundMeta)
            setDetailYear(foundYear)
            const plot = detail && typeof detail.overview === 'string' ? detail.overview.trim() : ''
            if (plot) {
              setOverview(plot)
              setOverviewPhase('done')
            }
          })
          .catch(() => {
            if (cancelled) return
            setMeta(null)
          })
        return () => {
          cancelled = true
        }
      }, [cacheKey, item.source, item.id])

      const tags = []
      const shownYear = item.year || detailYear || null
      if (shownYear) tags.push(h('span', { className: 'mw-tag', key: 'year' }, String(shownYear)))
      tags.push(h('span', { className: 'mw-tag', key: 'kind' }, kindLabel(t, item.kind)))
      if (item.rating !== null && item.rating !== undefined) {
        tags.push(h(
          'span',
          { className: 'mw-tag mw-tag-rating', key: 'rating' },
          h('span', { className: 'mw-rating-star' }, h(GlyphStar, null)),
          h('span', { className: 'mw-sr-only' }, t('detail.rating')),
          String(item.rating),
          item.votes ? ' · ' + t('detail.votes', { count: item.votes }) : '',
        ))
      }
      const factTags = []
      if (meta && meta.region) {
        factTags.push(h('span', { className: 'mw-tag mw-tag-meta', key: 'region' }, meta.region))
      }
      if (meta && Array.isArray(meta.genres)) {
        meta.genres.forEach((genre, index) => {
          factTags.push(h('span', { className: 'mw-tag mw-tag-meta', key: 'genre-' + index }, genre))
        })
      }
      if (meta && meta.runtime) {
        const runtimeText = typeof meta.runtime === 'number' ? `${meta.runtime} 分钟` : String(meta.runtime)
        factTags.push(h('span', { className: 'mw-tag mw-tag-meta', key: 'runtime' }, runtimeText))
      }
      const original = item.originalTitle && item.originalTitle !== item.title ? item.originalTitle : ''
      const relatedSections = []
      if (collection) {
        relatedSections.push(h(
          RelatedSection,
          { key: 'collection', label: t('collection.label') },
          h(RelatedCard, {
            key: 'collection-card',
            cover: collection.poster,
            name: collection.name,
            onOpen: () => props.onOpenCollection(collection),
          }),
        ))
      }
      if (series && Array.isArray(series.items) && series.items.length > 1) {
        relatedSections.push(h(
          RelatedSection,
          { key: 'series', label: t('series.label') },
          h(RelatedCard, {
            key: 'series-card',
            cover: series.cover,
            name: series.title || item.title || t('series.label'),
            meta: t('series.count', { count: series.items.length }),
            onOpen: () => props.onOpenSeries(series),
          }),
        ))
      }
      if (rankings.length > 0) {
        relatedSections.push(h(
          RelatedSection,
          { key: 'rankings', label: t('rankings.label') },
          rankings.map(ranking => h(RelatedCard, {
            key: String(ranking.id),
            cover: ranking.cover,
            name: ranking.title,
            meta: Number.isInteger(ranking.total) ? t('chart.count', { count: ranking.total }) : '',
            onOpen: () => props.onOpenRanking(ranking),
          })),
        ))
      }
      return h(
        'div',
        { className: 'mw-detail-page', role: 'region', 'aria-label': item.title },
        h(
          'button',
          { type: 'button', className: 'mw-back', ref: backRef, onClick: props.onBack },
          h(GlyphChevronLeft, { size: 15 }),
          t('detail.back'),
        ),
        h(
          'div',
          { className: 'mw-detail-layout', 'data-side': relatedSections.length > 0 ? 'true' : 'false' },
          h(
            'div',
            { className: 'mw-item' },
            h('div', { className: 'mw-item-poster' }, h(Poster, { item: item })),
            h(
              'div',
              { className: 'mw-item-body' },
            h('span', { className: 'mw-item-eyebrow' }, sourceLabel(t, item.source)),
            h('h2', { className: 'mw-item-title' }, item.title || item.originalTitle || item.id),
            original ? h('p', { className: 'mw-item-original' }, original) : null,
            h('div', { className: 'mw-item-tags' }, tags),
            factTags.length > 0
              ? h('div', { className: 'mw-item-tags mw-item-tags-meta' }, factTags)
              : null,
            h(
              'div',
              { className: 'mw-item-section' },
              h('p', { className: 'mw-item-label' }, t('detail.overview')),
              h(
                'p',
                {
                  className: 'mw-item-text',
                  'data-empty': overview ? 'false' : 'true',
                  'data-loading': overviewPhase === 'loading' ? 'true' : 'false',
                },
                overview ||
                  (overviewPhase === 'loading' ? t('detail.overviewLoading') : t('detail.noOverview')),
              ),
            ),
            h(
              'div',
              { className: 'mw-item-actions' },
              h(
                'a',
                {
                  className: 'mw-btn mw-btn-primary',
                  href: item.url,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                },
                h(GlyphExternal, null),
                t('detail.open', { source: sourceLabel(t, item.source) }),
              ),
            ),
            ),
          ),
          relatedSections.length > 0
            ? h('aside', { className: 'mw-detail-side' }, relatedSections)
            : null,
        ),
        h(TorrentSection, {
          t: t,
          item: item,
          lang: props.lang,
          aiModel: props.aiModel,
          aiModels: props.aiModels,
          aiModelsPhase: props.aiModelsPhase,
          onChooseAiModel: props.onChooseAiModel,
          onLoadAiModels: props.onLoadAiModels,
        }),
      )
    }

    function KeyPopover(props) {
      const t = props.t
      return h(
        'div',
        { className: 'mw-key-popover', id: 'movies-workbench-key-panel', role: 'dialog', 'aria-label': t('key.title'), ref: props.panelRef },
        h('h2', { className: 'mw-key-title' }, t('key.title')),
        h('p', { className: 'mw-key-hint' }, t('key.hint')),
        h('input', {
          className: 'mw-key-input',
          type: 'password',
          value: props.draft,
          placeholder: t('key.placeholder'),
          spellCheck: false,
          autoComplete: 'off',
          autoFocus: true,
          'aria-label': t('key.placeholder'),
          onChange: event => props.onDraft(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter') props.onSave()
          },
        }),
        h(
          'div',
          { className: 'mw-key-actions' },
          h('button', { type: 'button', className: 'mw-btn mw-btn-primary', onClick: props.onSave }, t('key.save')),
          props.stored ? h('button', { type: 'button', className: 'mw-btn', onClick: props.onClear }, t('key.clear')) : null,
        ),
        props.serverConfigured ? h('p', { className: 'mw-key-state' }, t('key.server')) : null,
        props.stored ? h('p', { className: 'mw-key-state' }, t('key.local')) : null,
        h(
          'p',
          { className: 'mw-key-link' },
          h('a', { href: TMDB_SETTINGS_URL, target: '_blank', rel: 'noreferrer noopener' }, t('key.open')),
        ),
      )
    }

    /** Data-source switches; a disabled source vanishes from every view. */
    function SettingsPopover(props) {
      const t = props.t
      return h(
        'div',
        {
          className: 'mw-key-popover mw-settings-popover',
          id: 'movies-workbench-settings-panel',
          role: 'dialog',
          'aria-label': t('settings.title'),
          ref: props.panelRef,
        },
        h('h2', { className: 'mw-key-title' }, t('settings.title')),
        h('p', { className: 'mw-key-hint' }, t('settings.sourcesHint')),
        h(
          'div',
          { className: 'mw-settings-list' },
          PROVIDERS.map(provider => h(
            'div',
            { className: 'mw-setting-row', key: 'setting-' + provider },
            h(
              'span',
              { className: 'mw-setting-text' },
              h('span', { className: 'mw-setting-name' }, sourceLabel(t, provider)),
              h('span', { className: 'mw-setting-desc' }, t('recommend.' + provider)),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                className: 'mw-switch',
                'data-on': props.sources[provider] ? 'true' : 'false',
                'aria-checked': props.sources[provider] ? 'true' : 'false',
                'aria-label': t('settings.toggle', { source: sourceLabel(t, provider) }),
                onClick: () => props.onToggle(provider),
              },
              h('span', { className: 'mw-switch-thumb' }),
            ),
          )),
        ),
        h('div', { className: 'mw-settings-divider', 'aria-hidden': 'true' }),
        h('h2', { className: 'mw-key-title mw-settings-subtitle' }, t('settings.defaultModel')),
        (() => {
          const catalog = props.aiModels || null
          const models = catalog && Array.isArray(catalog.models) ? catalog.models : []
          if (props.aiModelsPhase === 'loading') {
            return h('p', { className: 'mw-setting-note' }, t('settings.aiModelLoading'))
          }
          if (props.aiModelsPhase === 'error') {
            return h(
              'div',
              { className: 'mw-setting-table-note' },
              h('span', {}, t('settings.aiModelFailed')),
              h('button', { type: 'button', className: 'mw-link-btn mw-more', onClick: props.onReloadAiModels }, t('settings.aiModelRetry')),
            )
          }
          if (models.length === 0) {
            return h('p', { className: 'mw-setting-note' }, t('settings.aiModelEmpty'))
          }
          return h(
            'div',
            { className: 'mw-setting-table', role: 'table', 'aria-label': t('settings.defaultModel') },
            h(
              'div',
              { className: 'mw-setting-table-head', role: 'row' },
              h('span', { role: 'columnheader' }, t('settings.usage')),
              h('span', { role: 'columnheader' }, t('settings.modelColumn')),
            ),
            h(
              'div',
              { className: 'mw-setting-table-row', role: 'row' },
              h('span', { className: 'mw-setting-table-label', role: 'cell' }, t('settings.aiPickUsage')),
              h(
                'div',
                { className: 'mw-setting-table-model', role: 'cell' },
                h(ModelPicker, {
                  t,
                  catalog,
                  phase: props.aiModelsPhase,
                  value: props.aiModel,
                  onChoose: props.onChooseAiModel,
                  placement: 'down',
                  layout: 'stacked',
                  ariaLabel: t('settings.aiPickUsage'),
                }),
              ),
            ),
          )
        })(),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Page                                                                */
    /* ------------------------------------------------------------------ */

    /** Survives panel switches: the workbench returns to the last search. */
    const session = {
      source: 'all',
      draft: '',
      data: null,
      phase: 'idle',
      failure: null,
      selectedItem: null,
      suggestions: null,
      channel: null,
      channels: {},
      lists: { movie: null, tv: null },
      chartView: null,
      collectionView: null,
      seriesView: null,
      torrents: {},
      details: {},
      sources: readSourcePrefs(),
    }

    function Workbench(props) {
      const t = props.t
      const getLocale = props.getLocale
      const [source, setSource] = useState(session.source)
      const [sources, setSources] = useState(session.sources || { tmdb: true, imdb: true, douban: true })
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [aiModel, setAiModel] = useState(readAiModelPrefs)
      const [aiModels, setAiModels] = useState(null)
      const [aiModelsPhase, setAiModelsPhase] = useState('idle')
      const [recommendationLimit, setRecommendationLimit] = useState(12)
      const [draft, setDraft] = useState(session.draft)
      const [data, setData] = useState(session.data)
      const [phase, setPhase] = useState(session.phase)
      const [failureCode, setFailureCode] = useState(session.failure)
      const [selectedItem, setSelectedItem] = useState(session.selectedItem)
      const [suggestions, setSuggestions] = useState(session.suggestions)
      const [channel, setChannel] = useState(session.channel)
      const [lists, setLists] = useState(session.lists || { movie: null, tv: null })
      const [chartView, setChartView] = useState(session.chartView)
      const [collectionView, setCollectionView] = useState(session.collectionView)
      const [seriesView, setSeriesView] = useState(session.seriesView)
      const [loadingMore, setLoadingMore] = useState(false)
      const [moreFailure, setMoreFailure] = useState(null)
      const [chartLoadingMore, setChartLoadingMore] = useState(false)
      const [chartMoreFailure, setChartMoreFailure] = useState(null)
      const [recent, setRecent] = useState(readRecent)
      const [storedKey, setStoredKey] = useState(readTmdbKey)
      const [keyOpen, setKeyOpen] = useState(false)
      const [keyDraft, setKeyDraft] = useState(readTmdbKey)
      const [serverConfigured, setServerConfigured] = useState(false)
      const [hint, setHint] = useState(null)
      const inputRef = useRef(null)
      const popoverRef = useRef(null)
      const keyTriggerRef = useRef(null)
      const settingsTriggerRef = useRef(null)
      const settingsPanelRef = useRef(null)
      const aiModelsAbortRef = useRef(null)
      const abortRef = useRef(null)
      const suggestionsAbortRef = useRef(null)
      const channelAbortRef = useRef(null)
      const channelTriggerRef = useRef(null)
      const channelRef = useRef(channel)
      const chartRef = useRef(chartView)
      const chartAbortRef = useRef(null)
      const chartMoreRef = useRef(false)
      const chartDetailRef = useRef(null)
      const collectionRef = useRef(collectionView)
      const collectionAbortRef = useRef(null)
      const collectionReturnRef = useRef(null)
      const seriesRef = useRef(seriesView)
      const seriesAbortRef = useRef(null)
      const seriesReturnRef = useRef(null)
      const bodyRef = useRef(null)
      const recommendationLimitRef = useRef(12)
      const suggestionsLimitRef = useRef(0)
      const moreRef = useRef(false)
      const requestRef = useRef(0)
      const keyRef = useRef(storedKey)
      const sourceRef = useRef(source)
      const draftRef = useRef(draft)

      const enabledProviders = PROVIDERS.filter(provider => sources[provider])
      const activeSource = enabledProviders.length === 1
        ? enabledProviders[0]
        : (source === 'all' || enabledProviders.indexOf(source) !== -1 ? source : 'all')

      useEffect(() => {
        session.sources = sources
      }, [sources])
      useEffect(() => {
        session.source = activeSource
        sourceRef.current = activeSource
      }, [activeSource])
      useEffect(() => {
        session.draft = draft
        draftRef.current = draft
      }, [draft])
      useEffect(() => {
        session.data = data
        // A panel switch aborts the running request, so a restored 'loading'
        // phase would show a skeleton nothing can clear.
        session.phase = phase === 'loading' ? 'idle' : phase
        session.failure = failureCode
        session.selectedItem = selectedItem
        session.suggestions = suggestions
        session.channel = channel
        channelRef.current = channel
        session.lists = lists
        session.chartView = chartView
        chartRef.current = chartView
        session.collectionView = collectionView
        collectionRef.current = collectionView
        session.seriesView = seriesView
        seriesRef.current = seriesView
      }, [data, phase, failureCode, selectedItem, suggestions, channel, lists, chartView, collectionView, seriesView])
      useEffect(() => {
        keyRef.current = storedKey
      }, [storedKey])

      useEffect(() => {
        if (!hint) return undefined
        const timer = window.setTimeout(() => setHint(null), 5000)
        return () => {
          window.clearTimeout(timer)
        }
      }, [hint])

      useEffect(() => {
        let live = true
        callApi('/status', { headers: { accept: 'application/json' } })
          .then(body => {
            if (!live) return
            setServerConfigured(Boolean(body && body.sources && body.sources.tmdb && body.sources.tmdb.configured))
          })
          .catch(() => {
            /* The page reports route failures when a search runs; status is a nicety. */
          })
        return () => {
          live = false
        }
      }, [])

      useEffect(() => {
        // A 'loading' cache cannot survive an unmount (its request was aborted),
        // so a restore in that state must start a fresh load.
        if (!session.suggestions || session.suggestions.status === 'loading') void loadSuggestions()
      }, [])

      // Recommendation rows fill exactly two grid rows: measure the list column,
      // request columns * 2 titles, and refetch when the panel is resized.
      useEffect(() => {
        const node = bodyRef.current
        if (!node) return undefined
        const read = () => {
          try {
            const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(node) : null
            const left = style ? parseFloat(style.paddingLeft) || 0 : 0
            const right = style ? parseFloat(style.paddingRight) || 0 : 0
            const width = (node.clientWidth || 0) - left - right
            setRecommendationLimit(current => {
              const next = recommendationLimitForWidth(width)
              return next === current ? current : next
            })
          } catch (error) {
            /* A DOM shim without layout keeps the default 12. */
          }
        }
        read()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(read)
        observer.observe(node)
        return () => observer.disconnect()
      }, [])

      useEffect(() => {
        recommendationLimitRef.current = recommendationLimit
        if (phase !== 'idle' || !suggestions || suggestions.status === 'loading') return
        if (suggestionsLimitRef.current === recommendationLimit) return
        void loadSuggestions()
      }, [recommendationLimit, phase, suggestions])

      useEffect(() => {
        const node = inputRef.current
        if (node && typeof node.focus === 'function') node.focus()
        return () => {
          if (abortRef.current) abortRef.current.abort()
          if (suggestionsAbortRef.current) suggestionsAbortRef.current.abort()
          if (channelAbortRef.current) channelAbortRef.current.abort()
        }
      }, [])

      useEffect(() => {
        if (!keyOpen) return undefined
        const onPointerDown = event => {
          if (keyTriggerRef.current && keyTriggerRef.current.contains(event.target)) return
          if (popoverRef.current && !popoverRef.current.contains(event.target)) setKeyOpen(false)
        }
        const onKeyDown = event => {
          if (event.key === 'Escape') setKeyOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [keyOpen])

      // A restored view can point at a source the user has since disabled.
      useEffect(() => {
        if (selectedItem && !sources[selectedItem.source]) backToResults()
      }, [selectedItem, sources])
      useEffect(() => {
        if (channel && !sources[channel.source]) closeChannel()
      }, [channel, sources])

      useEffect(() => {
        if (!settingsOpen) return undefined
        const onPointerDown = event => {
          if (settingsTriggerRef.current && settingsTriggerRef.current.contains(event.target)) return
          if (settingsPanelRef.current && !settingsPanelRef.current.contains(event.target)) setSettingsOpen(false)
        }
        const onKeyDown = event => {
          if (event.key === 'Escape') setSettingsOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [settingsOpen])

      function loadAiModels() {
        if (aiModelsAbortRef.current) aiModelsAbortRef.current.abort()
        const controller = new AbortController()
        aiModelsAbortRef.current = controller
        setAiModelsPhase('loading')
        callApi('/models', { signal: controller.signal })
          .then(body => {
            setAiModels(body)
            setAiModelsPhase('done')
          })
          .catch(() => {
            if (controller.signal.aborted) return
            setAiModelsPhase('error')
          })
      }

      function chooseAiModel(value) {
        if (!value) {
          setAiModel(null)
          writeStorage(AI_MODEL_STORAGE, null)
          return
        }
        const separator = value.indexOf('|')
        if (separator === -1) return
        const next = { provider: value.slice(0, separator), model: value.slice(separator + 1) }
        if (!next.provider || !next.model) return
        setAiModel(next)
        writeStorage(AI_MODEL_STORAGE, next)
      }

      useEffect(() => {
        if (!settingsOpen) return undefined
        if (aiModelsPhase === 'done' || aiModelsPhase === 'loading') return undefined
        loadAiModels()
        return () => {
          if (aiModelsAbortRef.current) aiModelsAbortRef.current.abort()
        }
      }, [settingsOpen])

      async function runSearch(rawQuery, rawSource) {
        const query = String(rawQuery === undefined ? draftRef.current : rawQuery).trim()
        const nextSource = rawSource || sourceRef.current
        // Supersede the in-flight request before the empty-query shortcut, so a
        // cleared input can never be overwritten by the previous response.
        if (abortRef.current) abortRef.current.abort()
        const requestId = requestRef.current + 1
        requestRef.current = requestId
        if (query === '') {
          setPhase('idle')
          setData(null)
          setFailureCode(null)
          return
        }
        const controller = new AbortController()
        abortRef.current = controller
        setPhase('loading')
        setFailureCode(null)
        setSelectedItem(null)
        const params = new URLSearchParams()
        params.set('q', query)
        params.set('source', nextSource)
        params.set('lang', languageForSearch(getLocale()))
        const headers = { accept: 'application/json' }
        if (keyRef.current) headers['x-mw-tmdb-key'] = keyRef.current
        try {
          const body = await callApi('/search?' + params.toString(), { headers, signal: controller.signal })
          if (requestRef.current !== requestId) return
          setData(body)
          setPhase('done')
          setRecent(previous => {
            const next = [query].concat(previous.filter(entry => entry !== query)).slice(0, 6)
            writeStorage(RECENT_STORAGE, next)
            return next
          })
        } catch (error) {
          if (controller.signal.aborted || requestRef.current !== requestId) return
          setData(null)
          setFailureCode(error && error.code ? error.code : 'network')
          setPhase('error')
        }
      }

      async function loadSuggestions() {
        if (suggestionsAbortRef.current) suggestionsAbortRef.current.abort()
        const controller = new AbortController()
        suggestionsAbortRef.current = controller
        const loading = { status: 'loading', groups: [], errors: [], failure: null, tookMs: 0 }
        setSuggestions(loading)
        session.suggestions = loading
        const params = new URLSearchParams()
        params.set('source', 'all')
        params.set('lang', languageForSearch(getLocale()))
        const limit = recommendationLimitRef.current
        params.set('limit', String(limit))
        const headers = { accept: 'application/json' }
        if (keyRef.current) headers['x-mw-tmdb-key'] = keyRef.current
        try {
          const body = await callApi('/trending?' + params.toString(), { headers, signal: controller.signal })
          if (controller.signal.aborted) return
          suggestionsLimitRef.current = limit
          const items = Array.isArray(body.results) ? body.results : []
          const done = {
            status: 'done',
            groups: PROVIDERS.map(provider => ({
              source: provider,
              items: items.filter(item => item.source === provider),
            })),
            errors: Array.isArray(body.errors) ? body.errors : [],
            failure: null,
            tookMs: body.tookMs || 0,
          }
          setSuggestions(done)
          session.suggestions = done
        } catch (error) {
          if (controller.signal.aborted) return
          const failed = {
            status: 'error',
            groups: [],
            errors: [],
            failure: error && error.code ? error.code : 'network',
            tookMs: 0,
          }
          setSuggestions(failed)
          session.suggestions = failed
        }
      }

      /** Open one channel's first browse category (its "see all" entry point). */
      function openChannel(channelSource) {
        switchChannel(channelSource, channelCategoryTabs(channelSource)[0])
      }

      /** Show one channel category, reusing that category's cache when present. */
      function switchChannel(channelSource, category) {
        if (channelAbortRef.current) channelAbortRef.current.abort()
        moreRef.current = false
        setLoadingMore(false)
        setMoreFailure(null)
        const listsKind = listsKindFor(category)
        if (listsKind) {
          const view = {
            source: channelSource,
            category: category,
            categories: channelCategoryTabs(channelSource),
            status: 'done',
            items: [],
            failure: null,
            page: 1,
            hasMore: false,
            cursor: null,
          }
          setChannel(view)
          session.channel = view
          setChartView(null)
          session.chartView = null
          void loadCharts(listsKind, false)
          return
        }
        const key = channelCacheKey(channelSource, category)
        const cached = session.channels && session.channels[key]
        if (cached && cached.status === 'done') {
          const view = {
            source: channelSource,
            category: category,
            categories: channelCategoryTabs(channelSource),
            status: 'done',
            items: cached.items,
            failure: cached.failure || null,
            page: cached.page || 1,
            hasMore: Boolean(cached.hasMore),
            cursor: cached.cursor || null,
          }
          setChannel(view)
          session.channel = view
          return
        }
        void loadChannel(channelSource, category, 1)
      }

      /** Load one page of a channel category; pages above 1 append to the grid. */
      async function loadChannel(channelSource, category, page) {
        const categories = channelCategoryTabs(channelSource)
        const activeCategory = category || categories[0]
        const append = page > 1
        if (append) {
          if (moreRef.current) return
          moreRef.current = true
          setLoadingMore(true)
          setMoreFailure(null)
        }
        if (channelAbortRef.current) channelAbortRef.current.abort()
        const controller = new AbortController()
        channelAbortRef.current = controller
        if (!append) {
          const loading = {
            source: channelSource,
            category: activeCategory,
            categories: categories,
            status: 'loading',
            items: [],
            failure: null,
            page: 0,
            hasMore: false,
            cursor: null,
          }
          setChannel(loading)
          session.channel = loading
        }
        const params = new URLSearchParams()
        params.set('source', channelSource)
        params.set('category', activeCategory)
        params.set('page', String(page))
        const cursor = append && channelRef.current ? String(channelRef.current.cursor || '') : ''
        if (cursor) params.set('cursor', cursor)
        params.set('lang', languageForSearch(getLocale()))
        const headers = { accept: 'application/json' }
        if (keyRef.current) headers['x-mw-tmdb-key'] = keyRef.current
        try {
          const body = await callApi('/browse?' + params.toString(), {
            headers: headers,
            signal: controller.signal,
          })
          if (controller.signal.aborted) return
          const items = Array.isArray(body.items) ? body.items : []
          const errors = Array.isArray(body.errors) ? body.errors : []
          const failure = errors.length > 0 ? (errors[0].code || 'upstream_error') : null
          const returnedPage = Number.isInteger(body.page) && body.page > 0 ? body.page : page
          const hasMore = Boolean(body.hasMore)
          const next = typeof body.next === 'string' && body.next ? body.next : null
          const key = channelCacheKey(channelSource, activeCategory)
          if (append) {
            const current = channelRef.current
            if (!current || current.source !== channelSource || current.category !== activeCategory) return
            const seen = new Set(
              (current.items || []).map(entry => String(entry.source) + '|' + String(entry.id)),
            )
            const fresh = items.filter(
              entry => !seen.has(String(entry.source) + '|' + String(entry.id)),
            )
            const view = {
              ...current,
              status: 'done',
              items: (current.items || []).concat(fresh),
              failure: current.failure || failure,
              page: returnedPage,
              hasMore: hasMore,
              cursor: next,
              categories: categories,
            }
            session.channels = {
              ...(session.channels || {}),
              [key]: {
                status: 'done',
                items: view.items,
                failure: view.failure,
                page: view.page,
                hasMore: view.hasMore,
                cursor: view.cursor,
              },
            }
            setChannel(view)
            session.channel = view
          } else {
            const view = {
              source: channelSource,
              category: activeCategory,
              categories: categories,
              status: 'done',
              items: items,
              failure: failure,
              page: returnedPage,
              hasMore: hasMore,
              cursor: next,
            }
            session.channels = {
              ...(session.channels || {}),
              [key]: {
                status: 'done',
                items: items,
                failure: failure,
                page: returnedPage,
                hasMore: hasMore,
                cursor: next,
              },
            }
            setChannel(view)
            session.channel = view
          }
        } catch (error) {
          if (controller.signal.aborted) return
          const code = error && error.code ? error.code : 'network'
          if (append) {
            setMoreFailure(code)
          } else {
            const failed = {
              source: channelSource,
              category: activeCategory,
              categories: categories,
              status: 'error',
              items: [],
              failure: code,
              page: 0,
              hasMore: false,
              cursor: null,
            }
            setChannel(failed)
            session.channel = failed
          }
        } finally {
          if (append) {
            moreRef.current = false
            setLoadingMore(false)
          }
        }
      }

      /** Store one lists tab's state in the session cache and React state. */
      function storeLists(kind, value) {
        const next = Object.assign({ movie: null, tv: null }, session.lists || {}, { [kind]: value })
        session.lists = next
        setLists(next)
      }

      /** Load the chart catalog of one kind (movie or TV lists). */
      async function loadCharts(kind, force) {
        const cached = session.lists ? session.lists[kind] : null
        if (!force && cached && cached.status === 'done') {
          setLists(Object.assign({ movie: null, tv: null }, session.lists))
          return
        }
        const loading = { status: 'loading', kind: kind, charts: [], errors: [], failure: null }
        storeLists(kind, loading)
        try {
          const body = await callApi('/charts?source=douban&kind=' + kind)
          const charts = Array.isArray(body.charts) ? body.charts : []
          const errors = Array.isArray(body.errors) ? body.errors : []
          const done = {
            status: 'done',
            kind: kind,
            charts: charts,
            errors: errors,
            failure: errors.length > 0 ? (errors[0].code || 'upstream_error') : null,
          }
          storeLists(kind, done)
        } catch (error) {
          const failed = {
            status: 'error',
            kind: kind,
            charts: [],
            errors: [],
            failure: error && error.code ? error.code : 'network',
          }
          storeLists(kind, failed)
        }
      }

      /** Open one chart and load its first page of ranked titles. */
      function openChart(chart, kind) {
        if (!chart || !chart.id) return
        void loadChartItems(chart, kind || 'movie', 0, false, 'lists')
      }

      /** Load one range of a chart; `append` merges the next page in place. */
      async function loadChartItems(chart, kind, start, append, returnTo) {
        if (append) {
          if (chartMoreRef.current) return
          chartMoreRef.current = true
          setChartLoadingMore(true)
          setChartMoreFailure(null)
        }
        if (chartAbortRef.current) chartAbortRef.current.abort()
        const controller = new AbortController()
        chartAbortRef.current = controller
        if (!append) {
          const loading = {
            chart: chart,
            kind: kind,
            status: 'loading',
            items: [],
            failure: null,
            total: chart.total || null,
            hasMore: false,
            returnTo: returnTo || null,
          }
          setChartView(loading)
          session.chartView = loading
        }
        const params = new URLSearchParams()
        params.set('source', 'douban')
        params.set('id', chart.id)
        params.set('start', String(start))
        params.set('count', String(CHART_PAGE_SIZE))
        try {
          const body = await callApi('/chart?' + params.toString(), { signal: controller.signal })
          if (controller.signal.aborted) return
          const items = Array.isArray(body.items) ? body.items : []
          const errors = Array.isArray(body.errors) ? body.errors : []
          const failure = errors.length > 0 ? (errors[0].code || 'upstream_error') : null
          const total = Number.isInteger(body.total) ? body.total : (chart.total || null)
          const mergedChart = body.chart && typeof body.chart === 'object' ? { ...chart, ...body.chart } : chart
          const current = chartRef.current
          if (append) {
            if (!current || !current.chart || current.chart.id !== chart.id) return
            const seen = new Set((current.items || []).map(searchKey))
            const fresh = items.filter(item => !seen.has(searchKey(item)))
            const view = {
              ...current,
              status: 'done',
              items: (current.items || []).concat(fresh),
              failure: current.failure || failure,
              total: total,
              hasMore: Boolean(body.hasMore),
            }
            setChartView(view)
            session.chartView = view
          } else {
            const view = {
              chart: mergedChart,
              kind: kind,
              status: 'done',
              items: items,
              failure: failure,
              total: total,
              hasMore: Boolean(body.hasMore),
              returnTo: returnTo || null,
            }
            setChartView(view)
            session.chartView = view
          }
        } catch (error) {
          if (controller.signal.aborted) return
          const code = error && error.code ? error.code : 'network'
          if (append) {
            setChartMoreFailure(code)
          } else {
            const failed = {
              chart: chart,
              kind: kind,
              status: 'error',
              items: [],
              failure: code,
              total: chart.total || null,
              hasMore: false,
              returnTo: returnTo || null,
            }
            setChartView(failed)
            session.chartView = failed
          }
        } finally {
          if (append) {
            chartMoreRef.current = false
            setChartLoadingMore(false)
          }
        }
      }

      /** Append the next page of the open chart. */
      function loadMoreChart() {
        const view = chartRef.current
        if (!view || !view.hasMore || chartMoreRef.current) return
        void loadChartItems(view.chart, view.kind || 'movie', (view.items || []).length, true)
      }

      /** Reload the open chart from its first row. */
      function retryChart() {
        const view = chartRef.current
        if (!view || !view.chart) return
        void loadChartItems(view.chart, view.kind || 'movie', 0, false, view.returnTo || null)
      }

      /** Return from a chart to the channel's 片单 tab. */
      function closeChart() {
        const closed = chartRef.current
        if (chartAbortRef.current) chartAbortRef.current.abort()
        chartMoreRef.current = false
        setChartLoadingMore(false)
        setChartMoreFailure(null)
        setChartView(null)
        session.chartView = null
        let restoredDetail = false
        if (closed && closed.returnTo === 'detail' && chartDetailRef.current) {
          const saved = chartDetailRef.current
          chartDetailRef.current = null
          setSelectedItem(saved)
          restoredDetail = true
        }
        if (restoredDetail) return
        const focusTrigger = () => {
          const node = channelTriggerRef.current
          if (node && typeof node.focus === 'function') node.focus()
        }
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(focusTrigger)
        else focusTrigger()
      }

      /** Open a TMDB collection and load every part of it. */
      function openCollection(collection) {
        collectionReturnRef.current = null
        void loadCollection(collection)
      }

      async function loadCollection(collection) {
        if (!collection || collection.id === null || typeof collection.id === 'undefined') return
        if (collectionAbortRef.current) collectionAbortRef.current.abort()
        const controller = new AbortController()
        collectionAbortRef.current = controller
        const loading = { collection: collection, status: 'loading', items: [], failure: null }
        setCollectionView(loading)
        session.collectionView = loading
        const params = new URLSearchParams()
        params.set('source', 'tmdb')
        params.set('id', String(collection.id))
        params.set('lang', languageForSearch(getLocale()))
        const headers = { accept: 'application/json' }
        if (keyRef.current) headers['x-mw-tmdb-key'] = keyRef.current
        try {
          const body = await callApi('/collection?' + params.toString(), { headers, signal: controller.signal })
          if (controller.signal.aborted) return
          const items = Array.isArray(body.items) ? body.items : []
          const errors = Array.isArray(body.errors) ? body.errors : []
          const view = {
            collection: body.collection || collection,
            status: 'done',
            items: items,
            failure: errors.length > 0 ? (errors[0].code || 'upstream_error') : null,
          }
          setCollectionView(view)
          session.collectionView = view
        } catch (error) {
          if (controller.signal.aborted) return
          const failed = {
            collection: collection,
            status: 'error',
            items: [],
            failure: error && error.code ? error.code : 'network',
          }
          setCollectionView(failed)
          session.collectionView = failed
        }
      }

      /** Reload the open collection. */
      function retryCollection() {
        const view = collectionRef.current
        if (!view || !view.collection) return
        void loadCollection(view.collection)
      }

      /** Return from a collection to the title detail page. */
      function closeCollection() {
        if (collectionAbortRef.current) collectionAbortRef.current.abort()
        setCollectionView(null)
        session.collectionView = null
      }

      /** Open one collection part, remembering to come back to the collection. */
      function openCollectionItem(item) {
        if (!item) return
        collectionReturnRef.current = collectionRef.current
        setSelectedItem(item)
        setCollectionView(null)
        session.collectionView = null
      }

      /** Open an IMDb related-series chain (the chain already arrived in the detail payload). */
      function openSeries(series) {
        if (!series || !series.id) return
        const view = {
          status: 'done',
          series: series,
          items: Array.isArray(series.items) ? series.items : [],
          failure: null,
        }
        setSeriesView(view)
        session.seriesView = view
      }

      async function loadSeries(id) {
        if (!id) return
        if (seriesAbortRef.current) seriesAbortRef.current.abort()
        const controller = new AbortController()
        seriesAbortRef.current = controller
        const previous = seriesRef.current
        const loading = {
          status: 'loading',
          series: (previous && previous.series) || null,
          items: [],
          failure: null,
        }
        setSeriesView(loading)
        session.seriesView = loading
        try {
          const body = await callApi('/series?source=imdb&id=' + encodeURIComponent(String(id)), { signal: controller.signal })
          if (controller.signal.aborted) return
          const found = body && body.series && typeof body.series === 'object' ? body.series : {}
          const view = {
            status: 'done',
            series: found,
            items: Array.isArray(found.items) ? found.items : [],
            failure: null,
          }
          setSeriesView(view)
          session.seriesView = view
        } catch (error) {
          if (controller.signal.aborted) return
          const view = {
            status: 'error',
            series: (previous && previous.series) || null,
            items: [],
            failure: error && error.code ? error.code : 'network',
          }
          setSeriesView(view)
          session.seriesView = view
        }
      }

      /** Reload the open related-series page. */
      function retrySeries() {
        const view = seriesRef.current
        if (!view || !view.series) return
        void loadSeries(view.series.id)
      }

      /** Return from the related-series page to the detail page. */
      function closeSeries() {
        if (seriesAbortRef.current) seriesAbortRef.current.abort()
        setSeriesView(null)
        session.seriesView = null
      }

      /** Open one related title, remembering to come back to the series page. */
      function openSeriesItem(item) {
        if (!item) return
        seriesReturnRef.current = seriesRef.current
        setSelectedItem(item)
        setSeriesView(null)
        session.seriesView = null
      }

      /** Open one of the Douban charts a title is listed in, straight from the detail. */
      function openRanking(ranking) {
        if (!ranking || !ranking.id) return
        const saved = selectedItem
        if (saved) chartDetailRef.current = saved
        setSelectedItem(null)
        void loadChartItems({
          id: 'collection:' + String(ranking.id),
          title: ranking.title,
          subtitle: ranking.subtitle || '',
          description: ranking.description || '',
          total: Number.isInteger(ranking.total) ? ranking.total : null,
          cover: ranking.cover || null,
        }, 'movie', 0, false, 'detail')
      }

      /** Clear the open channel's cache and reload its first page. */
      function reloadChannel() {
        if (!channel) return
        const listsKind = listsKindFor(channel.category)
        if (listsKind) {
          void loadCharts(listsKind, true)
          return
        }
        const key = channelCacheKey(channel.source, channel.category)
        if (session.channels) delete session.channels[key]
        setMoreFailure(null)
        void loadChannel(channel.source, channel.category, 1)
      }

      /** Append the next page of the open channel. */
      function loadMoreChannel() {
        if (!channel || listsKindFor(channel.category) || !channel.hasMore || moreRef.current) return
        void loadChannel(channel.source, channel.category, (channel.page || 1) + 1)
      }

      function closeChannel() {
        if (channelAbortRef.current) channelAbortRef.current.abort()
        moreRef.current = false
        setLoadingMore(false)
        setMoreFailure(null)
        setChannel(null)
        session.channel = null
        setChartView(null)
        session.chartView = null
        const focusTrigger = () => {
          const node = channelTriggerRef.current
          if (node && typeof node.focus === 'function') node.focus()
        }
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(focusTrigger)
        else focusTrigger()
      }

      /** Refresh whatever the page currently shows: recommendations or the search. */
      function refreshView() {
        if (phase === 'idle') {
          session.suggestions = null
          setSuggestions(null)
          void loadSuggestions()
          return
        }
        void runSearch(draftRef.current, sourceRef.current)
      }

      function chooseSource(nextSource) {
        if (nextSource !== 'all' && !sources[nextSource]) return
        if (nextSource === 'all' && enabledProviders.length < 2) return
        if (nextSource === activeSource) return
        setSource(nextSource)
        sourceRef.current = nextSource
        session.source = nextSource
        const query = draftRef.current.trim()
        if (query !== '' && (phase === 'done' || phase === 'error' || phase === 'loading')) {
          void runSearch(query, nextSource)
        }
      }

      function submit() {
        void runSearch(draftRef.current, sourceRef.current)
      }

      function searchFromChip(value) {
        setDraft(value)
        draftRef.current = value
        void runSearch(value, sourceRef.current)
      }

      function saveKey() {
        const value = keyDraft.trim()
        if (value === '') {
          // Saving an empty field means "stop using a browser key"; the footer
          // must not claim a key was saved.
          clearKey()
          return
        }
        writeStorage(KEY_STORAGE, value)
        keyRef.current = value
        setStoredKey(value)
        setHint('key.saved')
        setKeyOpen(false)
        session.suggestions = null
        setSuggestions(null)
        session.channels = {}
        if (channel) reloadChannel()
        void loadSuggestions()
        if (data && data.query) void runSearch(data.query, sourceRef.current)
      }

      function clearKey() {
        writeStorage(KEY_STORAGE, '')
        keyRef.current = ''
        setStoredKey('')
        setKeyDraft('')
        setHint(null)
        setKeyOpen(false)
        session.suggestions = null
        setSuggestions(null)
        session.channels = {}
        if (channel) reloadChannel()
        void loadSuggestions()
        if (data && data.query) void runSearch(data.query, sourceRef.current)
      }

      function clearRecent() {
        writeStorage(RECENT_STORAGE, [])
        setRecent([])
      }

      /**
       * Toggle one data source. The choice is persisted, every view filters on
       * it, and open pages belonging to a disabled source are closed.
       */
      function toggleSource(provider) {
        const next = { ...sources, [provider]: !sources[provider] }
        const remaining = PROVIDERS.filter(candidate => next[candidate])
        if (remaining.length === 0) {
          setHint('settings.lastSource')
          return
        }
        setSources(next)
        session.sources = next
        writeStorage(SOURCES_STORAGE, next)
        if (!next[provider] && selectedItem && selectedItem.source === provider) backToResults()
        if (!next[provider] && channel && channel.source === provider) closeChannel()
        let nextSource = source
        if (remaining.length === 1) nextSource = remaining[0]
        else if (!next[provider] && source === provider) nextSource = 'all'
        if (nextSource !== source) {
          setSource(nextSource)
          sourceRef.current = nextSource
          session.source = nextSource
        }
        session.channels = {}
        if (channel && next[channel.source] !== false) reloadChannel()
        if (phase === 'idle') {
          session.suggestions = null
          setSuggestions(null)
          void loadSuggestions()
          return
        }
        void runSearch(draftRef.current, nextSource)
      }

      /**
       * Abort any running search, clear the query and fall back to a freshly
       * loaded recommendation screen. The detail page keeps its own back control,
       * so this is only reachable from the list view's search field.
       */
      function cancelSearch() {
        if (abortRef.current) abortRef.current.abort()
        requestRef.current += 1
        setDraft('')
        draftRef.current = ''
        session.draft = ''
        setPhase('idle')
        setData(null)
        setFailureCode(null)
        session.data = null
        session.phase = 'idle'
        setSelectedItem(null)
        session.selectedItem = null
        setSuggestions(null)
        session.suggestions = null
        void loadSuggestions()
        const focusInput = () => {
          const node = inputRef.current
          if (node && typeof node.focus === 'function') node.focus()
        }
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(focusInput)
        else focusInput()
      }

      function backToResults() {
        setSelectedItem(null)
        if (seriesReturnRef.current) {
          const saved = seriesReturnRef.current
          seriesReturnRef.current = null
          setSeriesView(saved)
          session.seriesView = saved
          return
        }
        if (collectionReturnRef.current) {
          const saved = collectionReturnRef.current
          collectionReturnRef.current = null
          setCollectionView(saved)
          session.collectionView = saved
          return
        }
        const focusBack = () => {
          const node = inputRef.current
          if (node && typeof node.focus === 'function') node.focus()
        }
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(focusBack)
        else focusBack()
      }

      const results = (data && Array.isArray(data.results)) ? data.results : []
      const errors = (data && Array.isArray(data.errors)) ? data.errors : []
      const visibleResults = useMemo(
        () => results.filter(item => sources[item.source]),
        [results, sources],
      )
      const groups = useMemo(() => {
        if (activeSource === 'all') {
          return enabledProviders
            .map(provider => ({ source: provider, items: visibleResults.filter(item => item.source === provider) }))
            .filter(group => group.items.length > 0)
        }
        return visibleResults.length > 0 ? [{ source: activeSource, items: visibleResults }] : []
      }, [activeSource, visibleResults, sources])

      const errorBySource = useMemo(() => {
        const map = {}
        errors.forEach(entry => {
          if (entry && entry.source && !map[entry.source]) map[entry.source] = entry.code || 'upstream_error'
        })
        return map
      }, [errors])

      const counts = useMemo(() => {
        const next = {}
        PROVIDERS.forEach(provider => {
          next[provider] = visibleResults.filter(item => item.source === provider).length
        })
        return next
      }, [visibleResults])

      // Stale results stay mounted only while the next search loads; their
      // notices and footer counts must not describe the query being replaced.
      const showResultMeta = phase === 'done' && data !== null
      const canClearSearch = phase !== 'idle' || draft.trim() !== ''
      const refreshLabel = phase === 'idle' ? t('recommend.refresh') : t('refresh.action')
      const refreshing = phase === 'loading'
        || (phase === 'idle' && suggestions !== null && suggestions.status === 'loading')
      const notices = showResultMeta
        ? errors.filter(entry => entry && entry.source && sources[entry.source] && (activeSource === 'all' || entry.source === activeSource))
        : []

      return h(
        'div',
        {
          className: 'mw-page',
          'data-view': collectionView ? 'collection' : seriesView ? 'series' : chartView ? 'chart' : selectedItem ? 'detail' : channel ? 'channel' : 'list',
          onKeyDown: event => {
            if (event.key === 'Escape' && !keyOpen && !settingsOpen) {
              if (collectionView) closeCollection()
              else if (seriesView) closeSeries()
              else if (chartView) closeChart()
              else if (selectedItem) backToResults()
              else if (channel) closeChannel()
              else if (phase !== 'idle') cancelSearch()
              else setSelectedItem(null)
            }
          },
        },
        h('style', null, CSS),
        h(
          'div',
          { className: 'mw-head', 'data-window-drag': '' },
          h(
            'div',
            { className: 'mw-head-row' },
            h(
              'div',
              { className: 'mw-heading' },
              h('h1', { className: 'mw-title' }, t('title')),
              h('p', { className: 'mw-subtitle' }, t('subtitle')),
            ),
            h(
              'div',
              { className: 'mw-head-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mw-icon-btn',
                  ref: keyTriggerRef,
                  'data-active': keyOpen ? 'true' : 'false',
                  'aria-controls': 'movies-workbench-key-panel',
                  'aria-haspopup': 'dialog',
                  onClick: () => {
                    setKeyOpen(open => !open)
                    setSettingsOpen(false)
                  },
                  title: t('key.button'),
                  'aria-label': t('key.button'),
                  'aria-expanded': keyOpen ? 'true' : 'false',
                },
                h(GlyphKey, null),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mw-icon-btn',
                  ref: settingsTriggerRef,
                  'data-active': settingsOpen ? 'true' : 'false',
                  'aria-controls': 'movies-workbench-settings-panel',
                  'aria-haspopup': 'dialog',
                  onClick: () => {
                    setSettingsOpen(open => !open)
                    setKeyOpen(false)
                  },
                  title: t('settings.button'),
                  'aria-label': t('settings.button'),
                  'aria-expanded': settingsOpen ? 'true' : 'false',
                },
                h(GlyphGear, null),
              ),
            ),
          ),
          keyOpen
            ? h(KeyPopover, {
              t: t,
              panelRef: popoverRef,
              draft: keyDraft,
              stored: Boolean(storedKey),
              serverConfigured: serverConfigured,
              onDraft: value => {
                setKeyDraft(value)
              },
              onSave: saveKey,
              onClear: clearKey,
            })
            : null,
          settingsOpen
            ? h(SettingsPopover, {
              t: t,
              panelRef: settingsPanelRef,
              sources: sources,
              onToggle: toggleSource,
              aiModel: aiModel,
              aiModels: aiModels,
              aiModelsPhase: aiModelsPhase,
              onChooseAiModel: chooseAiModel,
              onReloadAiModels: loadAiModels,
            })
            : null,
        ),
        h(
          'div',
          { className: 'mw-toolbar' },
          h(
            'div',
            { className: 'mw-toolbar-inner', role: 'search', 'aria-label': t('search.aria') },
            h(
              'div',
              { className: 'mw-search' },
              h(
                'div',
                { className: 'mw-search-field' },
                h('span', { className: 'mw-search-glyph' }, h(GlyphSearch, { size: 16 })),
                h('input', {
                  ref: inputRef,
                  className: 'mw-input',
                  type: 'search',
                  value: draft,
                  placeholder: t('search.placeholder'),
                  'aria-label': t('search.aria'),
                  spellCheck: false,
                  autoComplete: 'off',
                  onChange: event => setDraft(event.target.value),
                  onKeyDown: event => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      submit()
                    }
                  },
                }),
                canClearSearch
                  ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'mw-search-clear',
                      onClick: cancelSearch,
                      title: t('search.clear'),
                      'aria-label': t('search.clear'),
                    },
                    h(GlyphClear, { size: 14 }),
                  )
                  : null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mw-submit',
                  onClick: submit,
                  disabled: phase === 'loading' || draft.trim() === '',
                  title: t('search.action'),
                  'aria-label': t('search.action'),
                },
                phase === 'loading' ? h('span', { className: 'mw-spinner' }) : h(GlyphSearch, { size: 15 }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mw-refresh',
                  onClick: refreshView,
                  disabled: refreshing,
                  title: refreshLabel,
                  'aria-label': refreshLabel,
                },
                h(GlyphRefresh, { size: 16 }),
              ),
            ),
            enabledProviders.length > 1
              ? h(
                'div',
                { className: 'mw-source-select' },
                h('span', { className: 'mw-source-label' }, t('source')),
                h(
                  'div',
                  { className: 'mw-select-wrap' },
                  h(
                    'select',
                    {
                      className: 'mw-select',
                      value: activeSource,
                      'aria-label': t('source'),
                      onChange: event => chooseSource(event.target.value),
                    },
                    SOURCES.filter(candidate => (
                      candidate === 'all' ? enabledProviders.length > 1 : Boolean(sources[candidate])
                    )).map(candidate => h(
                      'option',
                      { key: candidate, value: candidate },
                      sourceLabel(t, candidate),
                    )),
                  ),
                  h('span', { className: 'mw-select-chevron', 'aria-hidden': 'true' }, h(GlyphChevronDown, { size: 14 })),
                ),
              )
              : null,
          ),
          recent.length > 0
            ? h(
              'div',
              { className: 'mw-toolbar-recent' },
              h('span', { className: 'mw-recent-label' }, t('recent.title')),
              recent.map(entry => h(
                'button',
                {
                  type: 'button',
                  className: 'mw-chip',
                  key: 'recent-' + entry,
                  onClick: () => searchFromChip(entry),
                },
                entry,
              )),
              h('button', { type: 'button', className: 'mw-link-btn', onClick: clearRecent }, t('recent.clear')),
            )
            : null,
          hint ? h('div', { className: 'mw-toolbar-hint', role: 'status' }, t(hint)) : null,
        ),
        notices.length > 0
          ? h(
            'div',
            { className: 'mw-notices' },
            h(
              'div',
              { className: 'mw-notices-inner' },
              notices.map(entry => h(
                'div',
                { className: 'mw-notice', key: 'notice-' + entry.source + '-' + entry.code },
                h('span', { className: 'mw-notice-glyph' }, h(GlyphWarning, null)),
                h(
                  'span',
                  { className: 'mw-notice-text' },
                  h('span', { className: 'mw-notice-source' }, sourceLabel(t, entry.source)),
                  failureText(t, entry.code),
                ),
                entry.code === 'tmdb_key_missing'
                  ? h('button', { type: 'button', className: 'mw-link-btn', onClick: () => setKeyOpen(true) }, t('notice.setKey'))
                  : null,
              )),
            ),
          )
          : null,
        h(
          'div',
          { className: 'mw-body', ref: bodyRef },
          collectionView
            ? h(CollectionPage, {
              t: t,
              view: collectionView,
              onBack: closeCollection,
              onRetry: retryCollection,
              onSelect: openCollectionItem,
            })
            : seriesView
            ? h(SeriesPage, {
              t: t,
              view: seriesView,
              onBack: closeSeries,
              onRetry: retrySeries,
              onSelect: openSeriesItem,
            })
            : selectedItem
            ? h(DetailPage, {
              key: String(selectedItem.source) + '|' + String(selectedItem.id),
              t: t,
              item: selectedItem,
              onBack: backToResults,
              onOpenCollection: openCollection,
              onOpenSeries: openSeries,
              onOpenRanking: openRanking,
              lang: languageForSearch(getLocale()),
              aiModel: aiModel,
              aiModels: aiModels,
              aiModelsPhase: aiModelsPhase,
              onChooseAiModel: chooseAiModel,
              onLoadAiModels: loadAiModels,
            })
            : chartView
              ? h(ChartPage, {
                t: t,
                view: chartView,
                loadingMore: chartLoadingMore,
                moreFailure: chartMoreFailure,
                onBack: closeChart,
                onRetry: retryChart,
                onRefresh: retryChart,
                onLoadMore: loadMoreChart,
                onSelect: item => setSelectedItem(item),
              })
              : channel
                ? h(ChannelPage, {
                t: t,
                state: channel,
                lists: lists,
                onOpenChart: openChart,
                onRetryLists: () => {
                  void loadCharts(true)
                },
                loadingMore: loadingMore,
                moreFailure: moreFailure,
                onBack: closeChannel,
                onRetry: reloadChannel,
                onRefresh: reloadChannel,
                onLoadMore: loadMoreChannel,
                onSelectCategory: category => switchChannel(channel.source, category),
                onOpenKey: () => setKeyOpen(true),
                onSelect: item => setSelectedItem(item),
              })
              : null,
          h(
            'div',
            {
              className: 'mw-results',
              role: 'region',
              'aria-label': t('aria.results'),
              'aria-live': 'polite',
            },
            phase === 'loading'
              ? h(
                'div',
                null,
                h('span', { className: 'mw-sr-only', role: 'status' }, t('loading')),
                h(Skeleton, null),
              )
              : phase === 'error'
                ? h(ErrorState, {
                  t: t,
                  code: failureCode,
                  onRetry: () => {
                    void runSearch(draftRef.current, sourceRef.current)
                  },
                })
                : phase === 'idle'
                  ? h(Recommendations, {
                    t: t,
                    state: suggestions,
                    source: activeSource,
                    enabled: sources,
                    onSelect: item => setSelectedItem(item),
                    onRetry: () => {
                      void loadSuggestions()
                    },
                    onMore: (channelSource, trigger) => {
                      channelTriggerRef.current = trigger
                      openChannel(channelSource)
                    },
                    onOpenKey: () => setKeyOpen(true),
                  })
                  : groups.length === 0
                    ? (activeSource !== 'all' && errorBySource[activeSource]
                      ? h(ErrorState, {
                        t: t,
                        code: errorBySource[activeSource],
                        onRetry: () => {
                          void runSearch(draftRef.current, sourceRef.current)
                        },
                      })
                      : h(EmptyState, { t: t }))
                    : h(
                      'div',
                      null,
                      activeSource === 'all'
                        ? h(
                          'div',
                          { className: 'mw-results-head' },
                          h('span', { role: 'status' }, t('results.count', { count: visibleResults.length })),
                          data && data.tookMs ? h('span', null, t('results.took', { ms: data.tookMs })) : null,
                        )
                        : null,
                      groups.map(group => h(ResultGroup, {
                        key: 'group-' + group.source,
                        t: t,
                        source: group.source,
                        items: group.items,
                        onSelect: item => setSelectedItem(item),
                      })),
                    ),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Registration                                                        */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = []
          disposers.push(ctx.locale.register(NS, 'zh', ZH))
          disposers.push(ctx.locale.register(NS, 'en', EN))
          const t = ctx.locale.bind(NS)
          disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            locale: NS,
            label: () => t('panel'),
          }, PanelIcon)))
          disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({
              t: t,
              getLocale: () => ctx.locale.getSnapshot().active,
            }),
          }, Workbench)))
          return () => {
            disposers.forEach(dispose => {
              try {
                dispose()
              } catch (error) {
                /* Disposal must continue for the remaining registrations. */
              }
            })
          }
        }, 'movies-workbench: panel and page')
      },
    }
  },
})
