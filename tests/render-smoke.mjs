/**
 * Dev-only render smoke test for the browser half.
 *
 * Evaluates client.js against a tiny React-compatible shim (hooks + a tree
 * renderer) and renders the registered Workbench page in four states: idle,
 * results, detail page and error. It cannot replace a browser check, but it
 * exercises every render branch and catches crashes, missing props and missing
 * markup that a syntax check cannot see.
 *
 * Run: node NOTES/render-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

const ITEMS = [
  {
    source: 'tmdb', id: '157336', title: '星际穿越', originalTitle: 'Interstellar', year: 2014,
    kind: 'movie', rating: 8.5, votes: 34000,
    overview: '一队探险家利用他们对虫洞的发现，超越人类对太空旅行的极限。',
    poster: 'https://image.tmdb.org/t/p/w342/x.jpg', url: 'https://www.themoviedb.org/movie/157336',
  },
  {
    source: 'imdb', id: 'tt0816692', title: 'Interstellar', originalTitle: 'Interstellar', year: 2014,
    kind: 'movie', rating: null, votes: null, overview: 'Matthew McConaughey, Anne Hathaway',
    poster: 'https://m.media-amazon.com/images/M/abc@@._V1_QL75_UX164_.jpg',
    url: 'https://www.imdb.com/title/tt0816692/',
  },
  {
    source: 'douban', id: '1889243', title: '星际穿越', originalTitle: 'Interstellar', year: 2014,
    kind: 'movie', rating: null, votes: null, overview: '', poster: null,
    url: 'https://movie.douban.com/subject/1889243/',
  },
]

const DATA = {
  ok: true, query: '星际穿越', source: 'all', lang: 'zh-CN', tookMs: 421,
  results: ITEMS, errors: [{ source: 'tmdb', code: 'tmdb_key_missing', message: 'no key' }],
}

/* ------------------------------------------------------------------ */
/* Minimal React shim: createElement, hooks, and a string renderer.    */
/* ------------------------------------------------------------------ */

function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity).filter(child => child !== undefined) }
}

function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(renderNode).join('')
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(String(node))
  if (typeof node.type === 'function') {
    const rendered = node.type({ ...node.props, children: node.children })
    return renderNode(rendered)
  }
  const attrs = []
  for (const [name, value] of Object.entries(node.props)) {
    if (name === 'children' || value === undefined || value === null) continue
    if (name === 'style' || typeof value === 'function' || typeof value === 'object') continue
    attrs.push(` ${name === 'className' ? 'class' : name}="${escapeHtml(String(value))}"`)
  }
  if (node.type === 'input' || node.type === 'img' || node.type === 'br') return `<${node.type}${attrs.join('')}>`
  return `<${node.type}${attrs.join('')}>${renderNode(node.children)}</${node.type}>`
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const React = {
  createElement,
  Fragment: 'fragment',
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useMemo(factory) { return factory() },
  useRef(value) { return { current: value === undefined ? null : value } },
}

/* ------------------------------------------------------------------ */
/* Evaluate the module once, with a patchable session block.           */
/* ------------------------------------------------------------------ */

const SESSION_PATTERN = /    const session = \{[\s\S]*?\n    \}/

function loadWorkbench(sessionLiteral, seedStorage) {
  const patched = source.replace(SESSION_PATTERN, `    const session = ${sessionLiteral}`)
  assert.notEqual(patched, source, 'session block was patched')
  let definition = null
  const seeded = new Map(Object.entries(seedStorage || {}))
  const windowStub = {
    localStorage: {
      store: seeded,
      getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
      setItem(key, value) { this.store.set(key, String(value)) },
      removeItem(key) { this.store.delete(key) },
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame(callback) { callback() },
    __ModuleLoader__: { load(next) { definition = next } },
  }
  const requireStub = specifier => {
    if (specifier === 'react') return React
    throw new Error('unexpected require: ' + specifier)
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', 'fetch', patched)(windowStub, requireStub, mockFetch)
  assert.ok(definition, 'module registered a loader definition')

  const plugin = definition.factory(requireStub)
  let workbench = null
  const ctx = {
    locale: {
      register() { return () => {} },
      bind() {
        return (key, params) => {
          const dict = ZH_KEYS
          let template = dict[key]
          if (template === undefined) return key
          if (params) template = template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
          return template
        }
      },
      getSnapshot() { return { active: 'zh', locales: [], revision: 0 } },
    },
    slots: {
      inject(key, callback) { callback(); return () => {} },
      register(options, component) {
        if (options.name === 'main') workbench = component
        return () => {}
      },
    },
    effect(callback) { const cleanup = callback(); return () => { cleanup() } },
  }
  plugin.apply(ctx)
  assert.ok(workbench, 'main panel component registered')
  return workbench
}

/** Pull the zh dictionary out of the source so t() returns real zh copy. */
function readZhDictionary(sourceText) {
  const match = /const ZH = \{([\s\S]*?)\n    \}/.exec(sourceText)
  assert.ok(match, 'ZH dictionary found')
  const dict = {}
  for (const entry of match[1].matchAll(/(?:'([a-zA-Z0-9_.]+)'|([a-zA-Z0-9_]+)):\s*'([^']*)'/g)) {
    dict[entry[1] || entry[2]] = entry[3]
  }
  return dict
}
const ZH_KEYS = readZhDictionary(source)

const BASE_T = (key, params) => {
  let template = ZH_KEYS[key]
  if (template === undefined) return key
  if (params) template = template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  return template
}

/* ------------------------------------------------------------------ */

let fetchCalls = 0
function mockFetch() {
  fetchCalls += 1
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, sources: { tmdb: { configured: false } } }) })
}

function renderState(name, sessionLiteral, checks, seedStorage) {
  const Page = loadWorkbench(sessionLiteral, seedStorage)
  const html = renderNode(createElement(Page, { t: BASE_T, getLocale: () => 'zh' }))
  assert.ok(html.length > 0, `${name}: rendered output is not empty`)
  for (const [needle, label] of checks) {
    assert.ok(html.includes(needle), `${name}: expected ${label} (${needle}) in output`)
  }
  return html
}

const idleLoadingHtml = renderState('idle (loading)', "{ source: 'all', draft: '', data: null, phase: 'idle', failure: null, selectedItem: null, suggestions: null, channel: null, channels: {} }", [
  ['mw-page', 'page root'],
  ['data-view="list"', 'list view'],
  ['影视工作台', 'zh title'],
  ['mw-toolbar', 'search toolbar'],
  ['mw-search-field', 'search field wrapper'],
  ['mw-submit', 'search button'],
  ['mw-refresh', 'toolbar refresh control'],
  ['正在加载推荐', 'loading copy'],
  ['mw-skeleton-grid', 'loading skeleton'],
])
assert.ok(!idleLoadingHtml.includes('class="mw-detail-page"'), 'idle loading: no detail page')
assert.ok(!idleLoadingHtml.includes('为你推荐'), 'idle loading: no recommendation heading row')
assert.ok(!idleLoadingHtml.includes('class="mw-search-clear"'), 'idle loading: no clear-search control')

const SUGGESTIONS = {
  status: 'done',
  tookMs: 380,
  errors: [],
  groups: [
    { source: 'tmdb', items: [ITEMS[0]] },
    { source: 'imdb', items: [ITEMS[1]] },
    { source: 'douban', items: [ITEMS[2]] },
  ],
}

const idleHtml = renderState('idle (recommendations)', `{ source: 'all', draft: '', data: null, phase: 'idle', failure: null, selectedItem: null, suggestions: ${JSON.stringify(SUGGESTIONS)}, channel: null, channels: {} }`, [
  ['data-view="list"', 'list view'],
  ['mw-refresh', 'toolbar refresh control'],
  ['本周趋势', 'TMDB recommendation label'],
  ['精选作品', 'IMDb recommendation label'],
  ['热门推荐', 'Douban recommendation label'],
  ['mw-group-title', 'per-channel rows'],
  ['mw-card-title', 'recommendation cards'],
  ['星际穿越', 'recommendation title'],
  ['mw-results::-webkit-scrollbar', 'hidden-scrollbar rule'],
  ['mw-link-btn mw-more', 'see-all control per channel'],
  ['查看全部', 'see-all label'],
  ['数据源设置', 'data-source settings button'],
  ['movies-workbench-settings-panel', 'settings popover anchor'],
  ['class="mw-select"', 'source dropdown'],
  ['value="all"', 'all-sources option'],
  ['value="imdb"', 'IMDb option'],
  ['value="douban"', 'douban option'],
])
assert.ok(!idleHtml.includes('class="mw-rec-hint"'), 'idle: no per-channel hint when all channels have rows')
assert.ok(!idleHtml.includes('为你推荐'), 'idle: recommendation heading row removed')
assert.ok(!idleHtml.includes('试试这些'), 'idle: example shortcuts removed')
assert.ok(!idleHtml.includes('class="mw-foot"'), 'idle: bottom status bar removed')
assert.ok(!idleLoadingHtml.includes('试试这些'), 'idle loading: example shortcuts removed')
assert.ok(!idleHtml.includes('class="mw-detail-page"'), 'idle: no detail page')

const PARTIAL = {
  status: 'done',
  tookMs: 210,
  errors: [{ source: 'tmdb', code: 'tmdb_key_missing', message: 'no key' }],
  groups: [
    { source: 'tmdb', items: [] },
    { source: 'imdb', items: [ITEMS[1]] },
    { source: 'douban', items: [ITEMS[2]] },
  ],
}
const partialHtml = renderState('idle (partial)', `{ source: 'all', draft: '', data: null, phase: 'idle', failure: null, selectedItem: null, suggestions: ${JSON.stringify(PARTIAL)}, channel: null, channels: {} }`, [
  ['mw-rec-hint', 'inline channel hint'],
  ['TMDB 需要 API Key', 'localized key hint'],
  ['设置 Key', 'key action'],
  ['精选作品', 'IMDb row still rendered'],
])
assert.ok(partialHtml.includes('class="mw-grid"'), 'partial: channels that loaded still show cards')

const FAILED = { status: 'error', tookMs: 0, errors: [], failure: 'network', groups: [] }
const failedHtml = renderState('idle (failed)', `{ source: 'all', draft: '', data: null, phase: 'idle', failure: null, selectedItem: null, suggestions: ${JSON.stringify(FAILED)}, channel: null, channels: {} }`, [
  ['推荐加载失败', 'failure headline'],
  ['重试', 'retry control'],
])

const resultsHtml = renderState('results', `{ source: 'all', draft: '星际穿越', data: ${JSON.stringify(DATA)}, phase: 'done', failure: null, selectedItem: null, suggestions: ${JSON.stringify(SUGGESTIONS)}, channel: null, channels: {} }`, [
  ['data-view="list"', 'list view'],
  ['mw-card-title', 'result cards'],
  ['星际穿越', 'result title'],
  ['显示 9 部作品'.replace('9', '3'), 'result count copy'],
  ['mw-rating', 'tmdb rating badge'],
  ['class="mw-search-clear"', 'clear-search control'],
  ['mw-refresh', 'toolbar refresh control'],
  ['取消搜索，回到推荐', 'clear-search label'],
  ['mw-notice', 'per-source notice'],
  ['mw-group', 'grouped results'],
  ['IMDb', 'IMDb group label'],
  ['豆瓣', '豆瓣 group label'],
  ['class="mw-select"', 'source dropdown on results'],
])
assert.ok(!resultsHtml.includes('class="mw-detail-page"'), 'results: detail page hidden')
assert.ok(!resultsHtml.includes('class="mw-foot"'), 'results: bottom status bar removed')

const disabledIdleHtml = renderState('idle (source disabled)', `{ source: 'all', draft: '', data: null, phase: 'idle', failure: null, selectedItem: null, suggestions: ${JSON.stringify(SUGGESTIONS)}, channel: null, channels: {}, sources: { tmdb: true, imdb: false, douban: true } }`, [
  ['data-source="douban"', 'enabled source row'],
  ['热门推荐', 'enabled channel row'],
  ['mw-card-title', 'enabled channel cards'],
])
assert.ok(!disabledIdleHtml.includes('data-source="imdb"'), 'source disabled: no IMDb recommendation row')
assert.ok(!disabledIdleHtml.includes('value="imdb"'), 'source disabled: no IMDb dropdown option')
assert.ok(disabledIdleHtml.includes('value="douban"'), 'source disabled: douban option still offered')
assert.ok(!disabledIdleHtml.includes('精选作品'), 'source disabled: no IMDb recommendation label')

const disabledResultsHtml = renderState('results (source disabled)', `{ source: 'all', draft: '星际穿越', data: ${JSON.stringify(DATA)}, phase: 'done', failure: null, selectedItem: null, suggestions: null, channel: null, channels: {}, sources: { tmdb: true, imdb: false, douban: true } }`, [
  ['data-source="douban"', 'enabled source group'],
  ['豆瓣', 'douban group label'],
  ['显示 2 部作品', 'count excludes the disabled source'],
])
assert.ok(!disabledResultsHtml.includes('data-source="imdb"'), 'source disabled: no IMDb result group')
assert.ok(!disabledResultsHtml.includes('value="imdb"'), 'source disabled: no IMDb dropdown option')

const singleSourceHtml = renderState('idle (single source)', `{ source: 'all', draft: '', data: null, phase: 'idle', failure: null, selectedItem: null, suggestions: ${JSON.stringify(SUGGESTIONS)}, channel: null, channels: {}, sources: { tmdb: true, imdb: false, douban: false } }`, [
  ['data-source="tmdb"', 'the only enabled row'],
  ['本周趋势', 'enabled channel row'],
])
assert.ok(!singleSourceHtml.includes('class="mw-select"'), 'single source: source dropdown collapsed away')
assert.ok(!singleSourceHtml.includes('value="all"'), 'single source: no all-sources option')
assert.ok(!singleSourceHtml.includes('value="imdb"'), 'single source: IMDb option hidden')
assert.ok(!singleSourceHtml.includes('value="douban"'), 'single source: douban option hidden')
assert.ok(!singleSourceHtml.includes('精选作品'), 'single source: IMDb row hidden')
assert.ok(!singleSourceHtml.includes('热门推荐'), 'single source: 豆瓣 row hidden')

const CHANNEL = { source: 'douban', status: 'done', items: [ITEMS[2], ITEMS[1], ITEMS[0]], failure: null }
const channelHtml = renderState('channel', `{ source: 'all', draft: '', data: null, phase: 'idle', failure: null, selectedItem: null, suggestions: ${JSON.stringify(SUGGESTIONS)}, channel: ${JSON.stringify(CHANNEL)}, channels: {} }`, [
  ['data-view="channel"', 'channel view'],
  ['返回推荐', 'channel back label'],
  ['mw-channel-title', 'channel heading'],
  ['豆瓣 · 热门推荐', 'channel heading text'],
  ['mw-channel-meta', 'channel row count'],
  ['class="mw-grid"', 'channel poster grid'],
  ['mw-card-title', 'channel cards'],
  ['刷新', 'channel refresh control'],
])
assert.ok(!channelHtml.includes('class="mw-detail-page"') === false, 'channel page uses the page container')
assert.ok(channelHtml.includes('class="mw-back"'), 'channel page has a back control')

const detailHtml = renderState('detail', `{ source: 'all', draft: '星际穿越', data: ${JSON.stringify(DATA)}, phase: 'done', failure: null, selectedItem: ${JSON.stringify(ITEMS[0])}, suggestions: ${JSON.stringify(SUGGESTIONS)}, channel: null, channels: {} }`, [
  ['data-view="detail"', 'detail view'],
  ['mw-detail-page', 'detail page'],
  ['mw-back', 'back control'],
  ['返回结果', 'back label'],
  ['mw-item-poster', 'detail poster'],
  ['mw-item-title', 'detail title'],
  ['mw-item-tags', 'detail tags'],
  ['在 TMDB 查看', 'source link label'],
  ['Interstellar', 'original title'],
  ['www.themoviedb.org/movie/157336', 'source link'],
  ['mw-item-text', 'overview'],
  ['mw-torrents', 'BT resources block'],
  ['BT 资源', 'BT resources heading'],
  ['正在搜索 BT 资源', 'BT resources loading state'],
])
// The toolbar stays mounted in the detail view but the page's data-view rule
// hides it; assert the rule that does that is present in the shipped CSS.
assert.ok(detailHtml.includes('.mw-page:not([data-view=&quot;list&quot;]) .mw-toolbar'), 'detail: non-list view rule hides the search toolbar')

// 豆瓣 titles carry no synopsis from the search payload, so the detail page
// opens in a loading state and fetches `/detail?source=douban&id=` lazily.
const doubanDetailHtml = renderState('detail (douban synopsis loading)', `{ source: 'all', draft: '星际穿越', data: ${JSON.stringify(DATA)}, phase: 'done', failure: null, selectedItem: ${JSON.stringify(ITEMS[2])}, suggestions: ${JSON.stringify(SUGGESTIONS)}, channel: null, channels: {} }`, [
  ['data-view="detail"', 'detail view'],
  ['豆瓣', '豆瓣 source label'],
  ['mw-item-text', 'overview slot'],
  ['简介加载中', 'synopsis loading copy'],
  ['data-loading="true"', 'loading marker'],
])
assert.ok(doubanDetailHtml.includes('data-empty="true"'), 'douban detail: overview slot is empty while loading')
assert.ok(!doubanDetailHtml.includes('该渠道没有提供简介'), 'douban detail: no missing-overview copy while loading')

const TORRENT_VIEW = {
  status: 'done',
  tookMs: 640,
  query: 'Inception 2010',
  errors: [],
  results: [
    {
      source: 'bitsearch',
      id: '1c6b2179bcd73efd07fb8018268598c062cf95af',
      title: 'Inception.2010.1080p.BluRay.DDP5.1.x265.10bit-GalaxyRG265[TGx]',
      size: '2.87 GB',
      seeders: 399,
      leechers: 285,
      category: 'Movies/BluRay',
      magnet: 'magnet:?xt=urn:btih:1C6B2179BCD73EFD07FB8018268598C062CF95AF&dn=Inception',
      page: 'https://bitsearch.to/torrent/661e55db7a868426ce2bc522',
      publishedAt: '2024-04-16',
    },
    {
      source: 'bt4g',
      id: 'b84185b1927abad4a4fded884534ce8cb45970c7',
      title: 'Inception (2010) 2160p UHD BluRay REMUX',
      size: '65.95 GB',
      seeders: null,
      leechers: null,
      category: 'Movie',
      magnet: 'magnet:?xt=urn:btih:B84185B1927ABAD4A4FDED884534CE8CB45970C7&dn=Inception',
      page: 'https://bt4gprx.com/magnet/abcdef',
      publishedAt: '2026-11-19',
    },
  ],
}
const torrentSession = `{ source: 'all', draft: '', data: ${JSON.stringify(DATA)}, phase: 'done', failure: null, selectedItem: ${JSON.stringify(ITEMS[0])}, suggestions: ${JSON.stringify(SUGGESTIONS)}, channel: null, channels: {}, torrents: { "tmdb|157336": ${JSON.stringify(TORRENT_VIEW)} } }`
const torrentHtml = renderState('detail (torrents)', torrentSession, [
  ['data-view="detail"', 'detail view'],
  ['mw-torrents', 'BT resources block'],
  ['mw-torrent-row', 'torrent rows'],
  ['Inception.2010.1080p', 'bitsearch row title'],
  ['2.87 GB', 'row size'],
  ['做种 399', 'seeder count'],
  ['mw-torrents-sort', 'sort group'],
  ['mw-sort-chip', 'sort chips'],
  ['mw-torrent-copy', 'copy-magnet button'],
  ['复制', 'copy label'],
  ['详情', 'details link'],
  ['65.95 GB', 'null-seeders row still rendered'],
])
assert.ok(!torrentHtml.includes('href="magnet:'), 'torrent rows no longer link the magnet directly')
assert.ok((torrentHtml.match(/mw-sort-chip/g) || []).length >= 4, 'four sort chips (default/seeders/leechers/size)')
assert.ok(/mw-sort-chip[^>]*data-selected=&quot;true&quot;/.test(torrentHtml), 'one sort chip is selected by default')
assert.ok(!/>\s*(BT4G|BitSearch)\s*</.test(torrentHtml), 'torrent rows do not print the source label')
assert.ok(torrentHtml.includes('class="mw-btn mw-btn-primary mw-torrent-copy"'), 'copy is a button, not an anchor')
assert.ok(torrentHtml.indexOf('mw-torrents') > torrentHtml.indexOf('mw-item'), 'BT resources render below the title metadata')

const errorHtml = renderState('error', "{ source: 'tmdb', draft: 'Inception', data: null, phase: 'error', failure: 'tmdb_key_missing', selectedItem: null, suggestions: null, channel: null, channels: {} }", [
  ['data-view="list"', 'list view'],
  ['mw-empty-title', 'error state'],
  ['TMDB 需要 API Key', 'localized failure text'],
])

const RECENT_IDLE = "{ source: 'all', draft: '', data: null, phase: 'idle', failure: null, selectedItem: null, suggestions: " + JSON.stringify(SUGGESTIONS) + ", channel: null, channels: {} }"
const recentHtml = renderState('idle (recent)', RECENT_IDLE, [
  ['mw-toolbar-recent', 'recent search row under the search field'],
  ['你好', 'recent search chip'],
  ['清除记录', 'clear recent action'],
  ['mw-card-title', 'recommendation rows still render'],
], { 'dsh-movie-workbench.recent-searches': JSON.stringify(['你好', 'Inception']) })
assert.ok(recentHtml.indexOf('mw-toolbar-recent') < recentHtml.indexOf('class="mw-group"'), 'recent row comes before the recommendation rows')

assert.ok(!recentHtml.includes('class="mw-foot"'), 'recent: bottom status bar removed')

const legacyRecentHtml = renderState('idle (legacy recent)', RECENT_IDLE, [
  ['mw-toolbar-recent', 'legacy recent row still renders'],
  ['旧记录', 'legacy recent chip survives the rename'],
], { 'movies-workbench.recent-searches': JSON.stringify(['旧记录']) })
assert.ok(legacyRecentHtml.includes('旧记录'), 'legacy storage key is migrated on read')

console.log('PASS render smoke:')
console.log('  idle loading :', idleLoadingHtml.length, 'chars')
console.log('  idle recs    :', idleHtml.length, 'chars')
console.log('  idle recent  :', recentHtml.length, 'chars')
console.log('  idle partial :', partialHtml.length, 'chars')
console.log('  idle failed  :', failedHtml.length, 'chars')
console.log('  channel      :', channelHtml.length, 'chars')
console.log('  results      :', resultsHtml.length, 'chars')
console.log('  detail       :', detailHtml.length, 'chars')
console.log('  detail+torr  :', torrentHtml.length, 'chars')
console.log('  error        :', errorHtml.length, 'chars')
