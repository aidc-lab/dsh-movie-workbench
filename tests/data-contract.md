# dsh-movie-workbench — Host ⇄ Client data contract (v1)

Authoritative contract between the Host half (`index.js` + `lib/`) and the browser half
(`client.js`) of this DSH bundle. Both halves are plain ESM / plain JavaScript, no
dependencies, no build step.

Bundle directory: `/Users/4paradigm/Documents/idsh/dsh-movie-workbench`
Package name: `dsh-movie-workbench`

## Host half

`index.js` exports exactly two named bindings (this is the DSH Host plugin form):

```js
export const inject = ['webServer']

export function apply(ctx, config) { /* registers ONE prefix route */ }
```

Route base: `/movie-workbench/api` (single `kind: 'prefix'` registration on
`ctx.webServer.register`, disposed through `ctx.effect`). The handler receives
Node `IncomingMessage` / `ServerResponse`. Supported routes:

### `GET /movie-workbench/api/status`

```json
{
  "ok": true,
  "version": "1.0.0",
  "sources": {
    "tmdb": { "configured": false },
    "imdb": { "configured": true },
    "douban": { "configured": true }
  },
  "limits": { "maxResults": 10, "requestTimeoutMs": 8000 }
}
```

`tmdb.configured` = a TMDB credential is available from plugin config or
`process.env.TMDB_API_KEY` (the client may still supply its own key per request).

### `GET /movie-workbench/api/search?q=<query>&source=all|tmdb|imdb|douban&lang=zh-CN`

Optional request header `x-mw-tmdb-key` carries a user-supplied TMDB credential:
either a v3 API key (32 hex chars) or a v4 bearer token (starts with `eyJ`).
It overrides the Host config/env credential for that request.

Success (HTTP 200):

```json
{
  "ok": true,
  "query": "星际穿越",
  "source": "all",
  "lang": "zh-CN",
  "tookMs": 412,
  "results": [
    {
      "source": "douban",
      "id": "1889243",
      "title": "星际穿越",
      "originalTitle": "Interstellar",
      "year": 2014,
      "kind": "movie",
      "rating": null,
      "votes": null,
      "overview": "",
      "poster": "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2614988097.jpg",
      "url": "https://movie.douban.com/subject/1889243/"
    }
  ],
  "errors": [
    { "source": "tmdb", "code": "tmdb_key_missing", "message": "No TMDB API key is configured." }
  ]
}
```

Rules:

- `source=all` fans out to the three providers in parallel and returns each
  provider's successes merged in the order `tmdb`, `imdb`, `douban`; a failing
  provider contributes only an entry to `errors` and never fails the request.
- A single-source request still uses the same envelope; failures go to `errors`.
- `results[i]` fields are always present (use `null` / `""` where a provider has no
  value). `kind` is one of `movie`, `tv`, `short`, `other`. `rating` is a number
  0–10 or `null`; `votes` an integer or `null`. `poster` is an absolute https URL
  on one of the allowed image hosts or `null`. `url` is the provider page.
- Upstream order is preserved; results are truncated per provider to `maxResults`
  (config, default 10). Providers may return fewer.
- Trim the query; reject empty queries (`400`). Cap the query at 120 chars.
- Every upstream request uses a per-request timeout from config (`requestTimeoutMs`,
  default 8000) and a normal browser-like `user-agent`.

Error envelope for bad requests (HTTP 400) and unexpected failures (HTTP 500):

```json
{ "ok": false, "code": "empty_query", "message": "..." }
```

Stable `code` values the client localizes:
`empty_query`, `bad_source`, `empty_id`, `bad_id`, `tmdb_key_missing`,
`tmdb_unauthorized`, `upstream_error`, `timeout`, `internal_error`.

### `GET /movie-workbench/api/image?url=<encoded absolute https URL>`

Streams one poster back to the page. Needed because Douban images answer `418`
unless the request carries a Douban `Referer`, which a browser `<img>` cannot set.

- Only `https:`, only these hosts: `image.tmdb.org`, `m.media-amazon.com`,
  `*.doubanio.com` (e.g. `img3.doubanio.com`), `*.douban.com`. Reject IP literals,
  other hosts, unparsable URLs and non-`https` schemes with `400`.
- `fetch(..., { redirect: 'manual' })`; reject 3xx with `502` rather than following.
- Send `user-agent` and, for Douban hosts, `referer: https://movie.douban.com/`.
- Response must be `content-type: image/*`; otherwise `502`. Cap the body at 8 MiB.
- Success headers: the image content type, `cache-control: public, max-age=86400`,
  `access-control-allow-origin: *`, `x-content-type-options: nosniff`.
- Upstream failure → `502 { ok:false, code:'upstream_error' }`-style plain JSON body
  is fine; the client's `<img onerror>` handles it.

All JSON/other responses also carry `access-control-allow-origin: *`. Answer
`OPTIONS` with `204` + `access-control-allow-headers: x-mw-tmdb-key` so the routes
also work if the page is loaded from a non-http origin later.

## Providers

### TMDB (needs a credential)

`GET https://api.themoviedb.org/3/search/multi?query=<q>&language=<lang>&include_adult=false&page=1`
— v3 key as `api_key` query parameter, or v4 token as `Authorization: Bearer <token>`.
Keep only `media_type` `movie` / `tv` (drop `person`). Poster:
`https://image.tmdb.org/t/p/w342<poster_path>` when `poster_path` is set; page:
`https://www.themoviedb.org/movie/<id>` or `/tv/<id>`. `originalTitle` =
`original_title` (movie) / `original_name` (tv) / `name`; `title` =
`title` / `name`; `rating` = `vote_average` (rounded to 1 decimal) when > 0 else
null; `votes` = `vote_count`; `overview` = `overview`; `kind` = media type.
HTTP 401 from TMDB → `tmdb_unauthorized`; missing credential → `tmdb_key_missing`
without any upstream call.

### IMDb (keyless)

`GET https://v2.sg.media-imdb.com/suggestion/x/<encodeURIComponent(q)>.json`
→ `{ "d": [ { "id": "tt1375666", "l": "Inception", "y": 2010, "q": "feature",
"qid": "movie", "s": "Leonardo DiCaprio, ...", "i": { "imageUrl": "https://..." } } ] }`.
Keep `qid` values `movie`, `tvMovie`, `tvSeries`, `tvMiniSeries`, `short`; drop
`person`/`name`-like entries (`qid` starting with `name`). `kind`: `movie` for
`movie`/`short`/`video`, `tv` for the TV kinds. `poster` = `i.imageUrl` else null;
`rating` = null; `votes` = null; `overview` = `s` (cast line) or `""`; page
`https://www.imdb.com/title/<id>/`; `originalTitle` = `l`.

### Douban (keyless, needs the browser-like UA)

`GET https://movie.douban.com/j/subject_suggest?q=<encoded q>`
→ array of
`{ "id": "1889243", "title": "星际穿越", "sub_title": "Interstellar",
"year": "2014", "type": "movie", "img": "https://img3.doubanio.com/...",
"url": "https://movie.douban.com/subject/1889243/?suggest=..", "episode": "" }`.
`originalTitle` = `sub_title`; `kind` = `tv` when `type` is `tv` or `episode` is
non-empty, else `movie`; `poster` = `img` else null; `rating` = null; `votes` =
null; `overview` = `""`; strip the query string from `url`.

## Config (plugin row config in `cordis.patch.yml`)

| key | type | default | meaning |
|---|---|---|---|
| `tmdbApiKey` | string | `''` | server-side TMDB credential (fallback to `process.env.TMDB_API_KEY`) |
| `maxResults` | number | `10` | per-provider result cap |
| `requestTimeoutMs` | number | `8000` | per-upstream timeout |
| `userAgent` | string | browser-like | upstream UA override |

## Browser half constraints (for reference)

- Module loader format: `window.__ModuleLoader__.load({ id: 'dsh-movie-workbench', factory(require) { ... } })`.
- Only `require('react')`; no other imports, no JSX, no build step.
- Fetches go to the same-origin relative base `/movie-workbench/api/...`.
- Sidebar entry: register `sidebar.panellist` with `id: 'movies-workbench'` and
  `main` with `key: 'movies-workbench'`; the page is the `main` component.

## Idle recommendations: `GET /movie-workbench/api/trending` (v1.1)

The page loads a recommendation set when it has no active search. Same envelope
family as `/search`:

`GET /movie-workbench/api/trending?source=all|tmdb|imdb|douban&lang=zh-CN`

Optional request header `x-mw-tmdb-key` behaves exactly as on `/search`.

Success (HTTP 200):

```json
{
  "ok": true,
  "source": "all",
  "lang": "zh-CN",
  "tookMs": 512,
  "results": [ /* same normalized item shape as /search */ ],
  "errors": [ { "source": "tmdb", "code": "tmdb_key_missing", "message": "..." } ]
}
```

Rules:

- Provider order for `source=all` is `tmdb`, `imdb`, `douban`; each provider's
  rows keep their provider order and are truncated to `maxResults` (config,
  default 10). A failing provider contributes only an `errors` entry.
- Bad requests answer `400 { ok: false, code }` with the same stable codes
  (`bad_source`, `internal_error`); unexpected failures use the same guard.
- No new config keys.

### Provider sources

- **tmdb** — `GET https://api.themoviedb.org/3/trending/all/week?language=<lang>`
  with the same v3-key / v4-bearer credential handling as `/search`. Keep
  `media_type` `movie`/`tv` rows and run them through the existing TMDB
  normalizer. Missing credential → `tmdb_key_missing` with no upstream call;
  401 → `tmdb_unauthorized`.
- **douban** — keyless. Two calls, movie and TV, each
  `GET https://movie.douban.com/j/search_subjects?type=<movie|tv>&tag=热门&page_limit=8&page_start=0`
  with the browser `user-agent` and `referer: https://movie.douban.com/`.
  Response rows: `{ id, title, rate: "8.6", cover, url, episodes_info, is_new }`.
  Map `rate` to a number 0–10 (empty string → null); `kind` is `movie`/`tv` from
  the request type; `poster` = `cover`; `url` = `url`; `originalTitle` = title;
  `overview` = `""`; `votes` = null. Interleave movie and TV rows
  (movie[0], tv[0], movie[1], tv[1], …) and truncate to `maxResults`.
- **imdb** — keyless; there is no unauthenticated IMDb popularity endpoint
  (chart pages answer HTTP 202 to non-browser clients), so the recommendation
  set is a curated pick list resolved live against IMDb's suggestion API:
  for each seed `{ id, query }`, `GET https://v2.sg.media-imdb.com/suggestion/x/<encoded query>.json`
  and select the row whose `id` equals the seed id (otherwise the first row
  with a kept `qid`); normalize it with the existing IMDb normalizer. Seeds are
  ordered: `tt1375666` Inception 2010, `tt0816692` Interstellar 2014,
  `tt0468569` The Dark Knight 2008, `tt1160419` Dune 2021,
  `tt15398776` Oppenheimer 2023, `tt6751668` Parasite 2019,
  `tt0245429` Spirited Away 2001, `tt0111161` The Shawshank Redemption 1994,
  `tt0068646` The Godfather 1972, `tt0133093` The Matrix 1999.
  Run seed lookups with a small concurrency limit, keep the seeds' order, cache
  the resolved list in Host memory for 3 hours (a static pick list must not hit
  IMDb on every page load), and report `upstream_error` only when no seed
  resolves. `rating`/`votes` stay null.

### `limit` for "see all" channel pages (v1.2)

The idle recommendation rows show each channel's default set, and a per-channel
"see all" page asks for a longer list:

`GET /movie-workbench/api/trending?source=tmdb&lang=zh-CN&limit=24`

- `limit` is optional, an integer 1–30. When present it overrides the row config
  `maxResults` for this request; invalid values (non-numeric, 0, negative) are
  ignored and fall back to `maxResults`. Values above 30 clamp to 30.
- The response envelope is unchanged; a single-source request returns up to
  `limit` normalized rows for that provider (fewer when the provider has fewer).
- Provider behavior for larger limits:
  - **tmdb** — page through `trending/all/week` (`page` 1…N, 20 rows each,
    filtered to movie/tv) until `limit` rows are collected or 3 pages were read.
  - **douban** — request `page_limit=<limit>` for both the movie and TV
    `j/search_subjects` calls and interleave as before.
  - **imdb** — the curated seed list is extended to 30 entries appended after
    the original ten, in this order: `tt0110912` Pulp Fiction 1994,
    `tt0109830` Forrest Gump 1994, `tt0137523` Fight Club 1999,
    `tt0120737` The Lord of the Rings: The Fellowship of the Ring 2001,
    `tt0167260` The Lord of the Rings: The Return of the King 2003,
    `tt4154796` Avengers: Endgame 2019, `tt7286456` Joker 2019,
    `tt1745960` Top Gun: Maverick 2022, `tt2582802` Whiplash 2014,
    `tt5013056` Dunkirk 2017, `tt2267998` Gone Girl 2014,
    `tt2015381` Guardians of the Galaxy 2014, `tt1630029` Avatar: The Way of Water 2022,
    `tt0325980` Pirates of the Caribbean: The Curse of the Black Pearl 2003.
    The 3-hour Host cache stores the resolved full list; `limit` slices it.
  - A provider that cannot fill `limit` returns what it has without an error.

## Subject detail (synopsis enrichment): `GET /movie-workbench/api/detail?source=douban&id=<id>` (v1.4)

Douban's `subject_suggest` and `j/search_subjects` payloads carry no synopsis, so a
Douban title's detail page asks for it when it opens.

- `source` is required and currently only `douban` is supported; a missing or
  unsupported value is `400 bad_source`.
- `id` is required and must be 1–12 digits: `400 empty_id` when absent,
  `400 bad_id` otherwise.
- A well-formed request is always HTTP 200 with `ok: true`:

```json
{
  "ok": true,
  "source": "douban",
  "id": "1889243",
  "tookMs": 212,
  "detail": {
    "id": "1889243",
    "title": "星际穿越",
    "originalTitle": "Interstellar",
    "year": 2014,
    "kind": "movie",
    "rating": 9.4,
    "votes": 1234567,
    "overview": "…full synopsis…",
    "genres": ["剧情", "科幻", "冒险"],
    "runtime": "169分钟",
    "region": "美国 / 英国 / 加拿大"
  },
  "errors": []
}
```

- An upstream failure keeps HTTP 200 and `ok: true` but sets `detail: null` and adds
  `errors: [{ source: 'douban', code: 'upstream_error' | 'timeout', message }]`; the
  page keeps its "no synopsis" empty state.
- Host fetches `https://m.douban.com/rexxar/api/v2/movie/<id>?for_mobile=1` with the
  browser-like UA and `Referer: https://m.douban.com/`; `fetch` follows a TV subject's
  redirect to `/tv/<id>`. Results are cached in Host memory for 30 minutes (100
  entries), so reopening a title does not hit Douban again.
- `overview` is the trimmed `intro`; `runtime` is the first `durations` entry;
  `region` joins `countries` with ` / `; `kind` is `tv` when `is_tv` is true.

## BT resources for one title: `GET /movie-workbench/api/torrents` (v1.3)

The detail page searches public torrent indexes for the opened title and lists the
results below the metadata.

`GET /movie-workbench/api/torrents?q=<title>&alt=<other title>&source=bt4g|bitsearch|all&limit=20`

- `q` is required (trimmed, max 160 chars). `alt` is optional: when the title and
  its original title differ, the client passes both so each site can be queried
  with both spellings. `limit` is optional, 1–30, default 20 (total across
  providers).
- `source` defaults to `all`; providers are `bt4g` and `bitsearch`. Any other
  value answers `400 bad_source`; an empty `q` answers `400 empty_query`.
- Each provider runs one search per supplied query (`q`, and `alt` when present
  and different), merges its own rows, removes duplicates by info hash and sorts
  by `seeders` descending (unknown seeders last).
- For `source=all` the providers must stay visible together: each provider
  contributes its top rows up to a quota (`max(4, ceil(limit / providers))`), the
  provider groups are interleaved one row at a time, duplicates are dropped and
  the merged list is capped at `limit`. Without this, an index that publishes
  seeders would push the other index past the cap entirely.
- A single-source request keeps that provider's sorted order capped at `limit`.
- A provider failure contributes only to `errors`; the request stays `200 ok:true`
  when `q` is valid.

Success:

```json
{
  "ok": true,
  "query": "Inception 2010",
  "alt": "星际穿越 2014",
  "tookMs": 640,
  "results": [
    {
      "source": "bitsearch",
      "id": "1c6b2179bcd73efd07fb8018268598c062cf95af",
      "title": "Inception.2010.1080p.BluRay.DDP5.1.x265.10bit-GalaxyRG265[TGx]",
      "size": "2.87 GB",
      "seeders": 399,
      "leechers": 285,
      "category": "Movies/BluRay",
      "magnet": "magnet:?xt=urn:btih:...",
      "page": "https://bitsearch.to/torrent/661e55db7a868426ce2bc522",
      "publishedAt": "2024-04-16"
    }
  ],
  "errors": [ { "source": "bt4g", "code": "upstream_error", "message": "..." } ]
}
```

Field rules: every field present; `seeders`/`leechers` integers or `null`;
`size` a human-readable string or `null`; `category` a string or `null`;
`publishedAt` an ISO date (`YYYY-MM-DD`) or `null`; `magnet` must start with
`magnet:?xt=urn:btih:` (drop rows without one); `page` the source's detail page or
the site search page. `id` is the lowercased info hash when known, else a stable
site id. Stable error codes: `empty_query`, `bad_source`, `upstream_error`,
`timeout`, `internal_error`.

### Provider sources

- **bt4g** — keyless RSS: `https://bt4gprx.com/search?q=<query>&page=rss`
  (the HTML search page is Cloudflare-challenged; the RSS endpoint is not).
  Each `<item>` has `<title>`, `<link>` = magnet, `<pubDate>`, `<guid>` = the
  detail page under `https://bt4gprx.com/magnet/…`, and a `<description>` CDATA
  with `title<br>size<br>category<br>hash`. Keep categories matching
  `movie|tv|video|anime|archive` and drop the rest (application, audio, game,
  document, other). No seeders are published: `seeders`/`leechers` stay `null`.
  Use the CDATA title (HTML-unescape it) and keep `size`/`category` from the
  description; `publishedAt` from `pubDate`.
- **bitsearch** — keyless HTML: `https://bitsearch.to/search?q=<query>` (follows
  to `bitsearch.eu`; follow redirects). Parse the
  `<div class="torrent-result-card …">` blocks: the `/torrent/<24-hex>` anchor
  gives the id/page, the `<h3>` anchor text is the title, the first
  `torrent-result-meta` block holds category (after `fa-file`), size (after
  `fa-download`) and date (`M/D/YYYY` after `fa-calendar`), and the swarm block
  holds `seeders`/`leechers` numbers. The magnet is in
  `href="magnet:…"` (HTML-escaped: `&amp;` and `&#x3D;`); unescape it and drop
  rows whose magnet is missing. Keep categories matching `movie|tv|anime|video`
  and drop music/games/apps/other.
- Both providers: normal browser `user-agent`, no cookies, per-request timeout
  from config but at least 15 s (the scraped pages are slower than the JSON APIs),
  at most 2 pages worth of rows (the first page is enough), no console output. Cache successful provider responses in Host memory for 10
  minutes keyed by `(provider, query)`, capped at a small number of entries.

## Channel browse: `GET /movie-workbench/api/browse` (v1.7)

One page of a single channel's browse categories, for channel pages with category
tabs and infinite scroll.

### Request

| Parameter | Required | Rules |
|---|---|---|
| `source` | yes | exactly one of `tmdb`, `imdb`, `douban`; `all` and unknown values are rejected |
| `category` | no | must belong to that source's list (below); defaults to the first category |
| `page` | no | integer `1`–`10`, defaults to `1` |
| `lang` | no | `zh`/`en`; TMDB maps it to `language`, other providers ignore it |

Category lists:

```json
{ "tmdb": ["trending", "movie", "tv"],
  "imdb": ["featured", "movie", "tv"],
  "douban": ["popular", "movie", "tv"] }
```

### Response

Always HTTP 200 for a valid request; a provider failure returns an empty page with
an `errors` entry instead of a 5xx:

```json
{
  "ok": true,
  "source": "douban",
  "category": "movie",
  "categories": ["movie", "tv"],
  "page": 1,
  "pageSize": 20,
  "tookMs": 240,
  "items": [ /* same normalized row shape as /search */ ],
  "hasMore": true,
  "next": null,
  "errors": []
}
```

Field rules: `items` normalized rows for the requested channel; `page` echoes the
served page (integer); `pageSize` is always `20`; `hasMore` is `true` when a later
page may contain rows; `next` is an opaque cursor for IMDb (null for TMDB,
DouBan and the last IMDb page), sent back as `&cursor=`; `errors` is empty on
success, otherwise one
`{source, code, message}` provider failure and `items: []`.

Stable error codes: `bad_source`, `bad_category`, `bad_page`, `bad_cursor` (HTTP 400), plus the
provider codes surfaced through `errors` (`tmdb_key_missing`, `tmdb_unauthorized`,
`upstream_error`, `timeout`, …).

### Provider paging

- **TMDB** — `trending` uses `/3/trending/all/week` with `page`; `movie` and `tv`
  use `/3/movie/popular` and `/3/tv/popular` with `page`; `hasMore` comes from
  `total_pages`.
- **IMDb** — keyless, cursor paged through the browser GraphQL endpoint
  `POST https://api.graphql.imdb.com/` (`advancedTitleSearch`, `sortBy: POPULARITY`).
  Every category returns 20 rows per page: `movie` searches title kind `movie`,
  `tv` searches `tvSeries` + `tvMiniSeries`, and `featured` searches all three
  kinds in one popularity-ordered list (so movies and series appear mixed). The
  response carries an opaque `next` token (base64url of the GraphQL page cursor)
  that the client sends back as `cursor` to fetch the following page — IMDb
  therefore keeps paging far beyond the 48 curated seeds. The home `/trending`
  row still resolves the curated seed list (cache 3h).
- **Douban** — keyless `j/search_subjects` with `tag=热门`.
  `popular` interleaves 10 hot movie rows and 10 hot TV rows per page
  (`page_start=(page-1)*10` each), so the page alternates movie/TV;
  `movie` / `tv` use `page_limit=20` and `page_start=(page-1)*20`.

## DouBan charts: `GET /movie-workbench/api/charts` + `GET /movie-workbench/api/chart` (v1.8)

The DouBan channel's 片单 tab lists the official charts; opening one shows its
ranked titles with paged infinite scroll (no search box, per product decision).

### Request

`/charts?source=douban` — `source` is required and must be exactly `douban`.

`/chart?source=douban&id=&start=&count=` — `source` required (`douban`), `id`
required and must be one of the allowlisted chart ids, `start` optional integer
`0`–`1000` (default `0`), `count` optional integer `1`–`30` (default `20`).

Allowlisted chart ids, in display order:

```json
["movie_top250", "movie_weekly_best", "movie_real_time_hotest",
 "tv_real_time_hotest", "tv_chinese_best_weekly", "tv_global_best_weekly"]
```

### Response

`/charts` is always HTTP 200 for a valid request:

```json
{
  "ok": true,
  "source": "douban",
  "tookMs": 412,
  "charts": [
    {
      "id": "movie_top250",
      "title": "豆瓣电影 Top250",
      "subtitle": "豆瓣榜单",
      "description": "…",
      "total": 250,
      "cover": "https://img3.doubanio.com/view/photo/…jpg"
    }
  ],
  "errors": []
}
```

`/chart` is also HTTP 200 with `ok: true` for a valid request; a provider failure
returns an empty page plus an `errors` entry:

```json
{
  "ok": true,
  "source": "douban",
  "id": "movie_top250",
  "start": 0,
  "pageSize": 5,
  "tookMs": 233,
  "total": 250,
  "items": [ /* normalized result rows, plus rank and subtitle */ ],
  "hasMore": true,
  "errors": []
}
```

Field rules: `charts[].total` may be `null` when upstream metadata failed (the
chart still renders with its static title); `items` rows use the same normalized
shape as `/search` and additionally carry `rank` (1-based integer, may be null)
and `subtitle` (DouBan's `card_subtitle` line); `hasMore` is
`start + items.length < total`; `total` may be `null` on failure.

Stable error codes: `bad_source`, `empty_id`, `bad_chart`, `bad_start`,
`bad_count` (HTTP 400), plus provider codes surfaced through `errors`
(`upstream_error`, `timeout`, …).

### Upstream

Keyless mobile web API with a `https://m.douban.com/` Referer:

- metadata: `GET https://m.douban.com/rexxar/api/v2/subject_collection/<id>?for_mobile=1`
- rows: `GET https://m.douban.com/rexxar/api/v2/subject_collection/<id>/items?start=&count=&for_mobile=1`

Chart metadata is cached in Host memory for 6 hours (bounded to 20 entries); rows
are fetched per request so rankings stay current.

## DouBan genre charts (extra 片单 entries) (v1.9)

Beyond the six official charts, the 片单 tab also lists generated genre charts:
27 Douban genres (情色 excluded) × two families — `S` (高分经典, high-score
classics) and `U` (近期热门, recent hits). `/charts` therefore returns **60**
entries: the six official charts (unchanged ids, `family: "official"`) followed
by `genre:<genre>:<S|U>` entries with `family: "rating"` / `"heat"`.

`/chart` accepts the generated ids in the same `id` parameter; every other
request/response rule from v1.8 applies (validation, envelope, `items` row shape,
`rank`, `subtitle`, `hasMore`, error codes).

Field additions on every `/charts` entry:

```json
{ "family": "official" }   // official charts
{ "family": "rating" }     // genre chart with sort=S (高分经典X片)
{ "family": "heat" }       // genre chart with sort=U (近期热门X片)
```

Generated ids and titles:

```json
{ "id": "genre:喜剧:S", "title": "高分经典喜剧片", "family": "rating",
  "subtitle": "分类榜单", "description": "按豆瓣评分优先", "total": null, "cover": null }
{ "id": "genre:动作:U", "title": "近期热门动作片", "family": "heat" }
```

Rows for generated charts carry `rank: null` (the client numbers them by
position) and `total` is capped at `500` (Douban caps the recommendation list at
500; 动作's raw total is 501 because of a leading announcement card). The first
upstream page at `start=0` may contain one announcement card (`type: "chart"`,
no subject url); it is filtered out, so a `count=5` page can return 4 rows.

### Upstream

Generated charts use Douban's mobile recommendation list filtered by genre tag:

- `GET https://m.douban.com/rexxar/api/v2/movie/recommend?refresh=0&start=&count=&selected_categories=%7B%7D&uncollect=false&tags=<genre>&sort=<S|U>`
  with a `https://m.douban.com/movie/` Referer.

Rows are fetched per request (no cache). The 分类排行榜 web page
(`movie.douban.com/chart`, `/typerank`) is not used directly because it only
exposes the `100:90` interval and has no high-score/recent split.

## DouBan 冷门佳作 and 年度榜单 charts (v1.10)

`/charts` now returns **97** entries in this order: the six official charts
(`family: "official"`), ten annual charts (`family: "annual"`), 27 hidden-gem
charts (`family: "hidden"`, one per genre) and the 54 genre charts
(`family: "rating"` / `"heat"`, section title 分类题材). `/chart` accepts their ids with the same
validation, envelope and row shape as v1.8/v1.9.

Generated ids:

```json
{ "id": "year:2025:S", "title": "2025 年度高分", "subtitle": "年度片单",
  "family": "annual", "description": "按豆瓣评分优先", "total": null, "cover": null }
{ "id": "year:2025:U", "title": "2025 年度热门", "family": "annual" }
{ "id": "hidden:动作", "title": "冷门佳作 · 动作", "subtitle": "冷门佳片",
  "family": "hidden", "description": "评分优先的冷门佳片", "total": null, "cover": null }
```

Annual years are allowlisted to `[2025, 2024, 2023, 2022, 2021]` (newest first)
and expose both families: `S` (年度高分) and `U` (年度热门). An unknown year or
sort is `400 bad_chart`. Hidden charts take `hidden:<genre>` with one of the 27
allowlisted genres and always sort by rating (`S`); another genre is
`400 bad_chart`. Rows
carry `rank: null`, `total` is capped at `500` (冷门佳片 currently reports 494),
and the first page may drop one announcement card as described in v1.9.

The Lists tab groups the catalog into five collapsible sections in this display
order: 官方榜单, 年度榜单, 高分经典, 近期热门, 冷门佳作.

Official-chart rows expose the poster as `cover_url`; rows from the recommend
feed (annual / hidden / genre) carry only `pic.large` / `pic.normal`, which the
Host maps to the same `poster` field. Generated charts have no catalog cover of
their own, so their cards lazily request the first page of that chart
(`count=3`, because genre charts prepend an announcement card that the Host
filters out) and use the first title that has a `poster` as the card cover
(cached per session, at most 4 concurrent requests, compact placeholder until
loaded).

### Upstream

All three generated families share one endpoint — the mobile movie
recommendation list filtered by a tag:

- genre charts: `tags=<genre>` (e.g. `喜剧`)
- hidden gems: `tags=冷门佳片,<genre>` (comma-separated AND filter)
- annual: `tags=<yyyy>` (e.g. `2025`)

`GET https://m.douban.com/rexxar/api/v2/movie/recommend?refresh=0&start=&count=&selected_categories=%7B%7D&uncollect=false&tags=<tag>&sort=<S|U>`
with a `https://m.douban.com/movie/` Referer. Rows are movies only (DouBan's
`tv` domain has a separate endpoint that is not used here).

## DouBan movie / TV chart split (v1.11)

The old single 片单 tab is now two tabs on the DouBan channel page:

- **电影榜单** (`movie-lists`) requests `/charts?source=douban&kind=movie`.
- **剧集榜单** (`tv-lists`) requests `/charts?source=douban&kind=tv`.

`kind` is optional and defaults to `movie`; any other value is
`400 bad_kind`. The `/charts` response gains a top-level `"kind"` echo and every
catalog entry carries `kind`. Both catalogs keep the `family` field:

| kind | official | annual | hidden | rating + heat | total |
| --- | --- | --- | --- | --- | --- |
| `movie` | 3 | 10 | 27 | 54 | 94 |
| `tv` | 3 | 10 | 0 | 54 | 67 |

Movie official ids are `movie_top250`, `movie_weekly_best`,
`movie_real_time_hotest`; TV official ids are `tv_real_time_hotest`,
`tv_chinese_best_weekly`, `tv_global_best_weekly`. TV generated charts use the
`tv-` id prefix: `tv-year:<yyyy>:<S|U>` and `tv-genre:<genre>:<S|U>` with titles
like `2025 年度热门` and `高分经典悬疑剧` / `近期热门悬疑剧`. TV lists have no
hidden-gems family because DouBan's `冷门佳片,<genre>` tag returns 0–1 TV rows.

`/chart` infers the kind from the id (official id membership first, otherwise
the parsed id prefix), echoes it as `kind`, and fetches generated TV rows from
the TV recommendation endpoint:

`GET https://m.douban.com/rexxar/api/v2/tv/recommend?refresh=0&start=&count=&selected_categories=%7B%7D&uncollect=false&tags=<tag>&sort=<S|U>`
with a `https://m.douban.com/tv/` Referer. Rows are TV series only, paging and
the 500-row cap behave exactly like the movie feed.

## Paged BT search (v1.12)

`GET /movie-workbench/api/torrents` accepts an optional `page` parameter
(integer `1`–`20`, default `1`); anything else is `400 bad_page`. The response
envelope gains `page` and `hasMore`:

```json
{ "ok": true, "query": "Inception 2010", "alt": null, "page": 1,
  "tookMs": 640, "results": [ … ], "hasMore": true, "errors": [] }
```

Provider paging:

- **BitSearch** — `https://bitsearch.to/search?q=<q>&page=<n>` for `n > 1`
  (redirects to bitsearch.eu are followed); each page returns about 20 cards.
  `hasMore` is `true` when the parsed page is full (20 rows), so a short page is
  the end of the list. The 10-minute cache key includes the page number.
- **BT4G** — the RSS endpoint only serves one page (`&page=rss` ignores `p`/`limit`),
  so BT4G contributes rows to page 1 only and reports `hasMore: false`.
  `source=bt4g&page=2` is a valid empty page, not an error.

`source=all` merges only indexes that still have pages: page 1 keeps the quota
interleave so both indexes stay visible, page 2+ asks BitSearch only and caps
the merged page at `limit`. The client appends the next page, deduping rows by
info hash, and exposes a footer with `加载更多` / `正在加载…` / `没有更多了` /
`加载更多失败` plus an IntersectionObserver sentinel for scroll loading.

## TMDB collections (v1.13)

### `GET /movie-workbench/api/detail?source=tmdb&id=<tmdb movie id>&lang=`

`source` accepts `douban` or `tmdb`; `id` must be `1`–`12` digits
(`400 bad_id`), and a missing `id` is `400 empty_id`. With no credential the
route still answers `200` and reports the missing key instead of failing:

```json
{ "ok": true, "source": "tmdb", "id": "157336", "lang": "zh-CN",
  "tookMs": 180, "detail": null,
  "errors": [{ "source": "tmdb", "code": "tmdb_key_missing", "message": "No TMDB API key is configured." }] }
```

With a credential:

```json
{ "ok": true, "source": "tmdb", "id": "157336", "lang": "zh-CN", "tookMs": 210,
  "detail": { "id": "157336", "title": "星际穿越", "kind": "movie", "year": 2014,
    "overview": "…",
    "collection": { "id": "86311", "name": "星际穿越合集",
      "poster": "https://image.tmdb.org/t/p/w342/<poster_path>" } },
  "errors": [] }
```

`collection` is `null` when the movie does not belong to a franchise (and for
DouBan detail responses, whose shape is unchanged).

### `GET /movie-workbench/api/collection?source=tmdb&id=<collection id>&lang=`

`source` is required and must be `tmdb` (`400 bad_source`); `id` is required
(`400 empty_id`) and numeric (`400 bad_id`). The response always answers `200`
for a well-formed request:

```json
{ "ok": true, "source": "tmdb", "id": "86311", "lang": "zh-CN", "tookMs": 240,
  "collection": { "id": "86311", "name": "星际穿越合集", "overview": "…",
    "cover": "https://image.tmdb.org/t/p/w342/<poster_path>" },
  "items": [ { "source": "tmdb", "id": "…", "title": "…", "kind": "movie", "…": "…" } ],
  "errors": [] }
```

`items` are normalized movie results (the same shape as `/search`) sorted by
release year and then title; a missing credential or an upstream failure yields
`collection: null`, `items: []` and an `errors` entry (never a 5xx).

Upstream: `https://api.themoviedb.org/3/movie/<id>` (`belongs_to_collection`)
and `https://api.themoviedb.org/3/collection/<id>` (`parts`). The catalog uses
the same v3 key / v4 bearer credential handling as the other TMDB routes.

### Browser half

The detail page lazily fetches `/detail?source=tmdb&id=` for TMDB movies and
renders a 所属合集 card when `collection` is present. Opening it renders the
collection page (`data-view="collection"`) with a 返回详情 back button; opening
a part shows that title's detail page and its back button returns to the
collection. The collection and its parts are cached in the session, and the
page is covered by `tests/render-smoke.mjs` states `detail (collection)` and
`collection`.

### `GET /movie-workbench/api/series?source=imdb&id=<tt id>`

`source` is required and must be `imdb` (`400 bad_source`); `id` is required
(`400 empty_id`) and must match `tt` + digits (`400 bad_id`). A well-formed
request always answers `200`:

```json
{ "ok": true, "source": "imdb", "id": "tt2395427", "tookMs": 720,
  "series": { "id": "tt2395427", "title": "Avengers: Age of Ultron",
    "cover": "https://m.media-amazon.com/images/M/…jpg",
    "truncated": false,
    "items": [ { "source": "imdb", "id": "tt0848228", "title": "The Avengers", "…": "…" } ] },
  "errors": [] }
```

`items` mixes the title itself with its `follows`, `followed_by`, `spin_off` and
`spin_off_from` connections, deduplicated and sorted by release year (null years
last) then title. Upstream is IMDb's browser GraphQL `title(id).connections`
(250 relations per page, at most 5 pages; `truncated` is true when that cap is
hit). A provider failure yields `series: null` plus an `errors` entry.

### `GET /movie-workbench/api/chart?source=douban&id=collection:<collection id>&start=&count=`

Besides the chart id forms above, `id` accepts `collection:<raw subject
collection id>` (letters, digits and `_`). That opens one of the official charts
a DouBan title is listed in (the ids come from `/detail?source=douban`, field
`collections`). Validation, paging and the response shape are identical to the
other chart ids, except the envelope also carries the chart metadata:

```json
{ "ok": true, "source": "douban", "id": "collection:film_genre_49",
  "chart": { "id": "film_genre_49", "title": "高分经典冒险片榜",
    "subtitle": "豆瓣榜单", "description": "…", "total": 50, "cover": "https://…" },
  "start": 0, "pageSize": 20, "total": 50,
  "items": [ { "source": "douban", "id": "…", "rank": 1, "…": "…" } ],
  "hasMore": true, "errors": [] }
```

`chart` is `null` when the metadata request failed; other chart ids keep
`chart: null` as well.

### Browser half

IMDb detail pages lazily fetch `/series?source=imdb&id=` and render a 相关系列
card (the same visual card as TMDB collections). Opening it renders the series
page (`data-view="series"`) with a 返回详情 back button; opening a part shows
that title's detail page and its back button returns to the series page.

`/detail?source=douban` enriches each entry of `collections` with the chart
metadata (`subtitle`, `description`, `cover`, `total`) by fetching the subject
collection metadata (six-hour cache); entries whose metadata request fails keep
`id` and `title` only.

Detail pages show every related collection as the same inline card
(`.mw-related` section with one `.mw-related-card` per item): a TMDB movie gets
a 所属合集 card, an IMDb title a 相关系列 card (with its item count), and a DouBan
title one 收录于榜单 card per chart (with the chart's total). Choosing a card opens
the existing destination: the collection page (`data-view="collection"`), the
related-series page (`data-view="series"`) or, for a DouBan chart, the chart page
(`data-view="chart"`) directly — its back button (返回详情) returns to the title.
Covered by render-smoke states `detail (collection)`, `detail (series)`,
`detail (rankings)`, `collection` and `series`.

## Detail metadata (v1.15)

`GET /detail?source=` now accepts `douban`, `tmdb` and `imdb`.

- `imdb` ids are IMDb title ids (`tt` + digits); anything else is `400 bad_id`.
  The host queries IMDb's browser GraphQL endpoint without a credential and
  normalizes a `title` node into the shared detail shape:

  ```json
  { "ok": true, "source": "imdb", "id": "tt0848228", "tookMs": 120,
    "detail": { "id": "tt0848228", "title": "The Avengers",
      "originalTitle": "The Avengers", "kind": "movie", "year": 2012,
      "overview": "…", "rating": 8, "votes": 1593640,
      "genres": ["Action", "Sci-Fi"], "region": "United States",
      "runtime": 143 },
    "errors": [] }
  ```

- Provider failures (and an unknown title) answer `200` with `detail: null`
  and a populated `errors[]`; the same is true for the keyless `tmdb` case.
- `douban` detail already carried `genres`, `region`, `runtime`, `rating` and
  `votes`; `tmdb` detail now also returns `originalTitle`, `genres`,
  `region`, `runtime` (minutes), `rating` and `votes` alongside `collection`.
- `runtime` is a number of minutes for TMDB/IMDb and a localized string
  (e.g. `169分钟`) for DouBan; the browser half renders region, each genre and
  the runtime as small `.mw-tag.mw-tag-meta` chips in a `.mw-item-tags-meta`
  row under the rating tags. The synopsis line is no longer width-capped
  (`max-width:72ch` removed), so wide panels use the full middle column.
- A DouBan title's `year` can be missing when it comes from a recommendation
  row (the `j/search_subjects` payload has no year); the detail response's
  `year` is stored in the browser cache and used for the year tag, so the tag
  appears once the detail loads. `GET /detail?source=douban` already returned
  `year` — no host change was needed.

## Douban list rows (v1.16)

`/trending` and `/browse` for `source=douban` no longer read the desktop
`j/search_subjects` feed (which returns no year). They page the mobile
recommendation feed instead:

- movies: `https://m.douban.com/rexxar/api/v2/movie/recommend`
- TV: `https://m.douban.com/rexxar/api/v2/tv/recommend`

with `refresh=0&start=<pageStart>&count=<limit>&selected_categories={}&uncollect=false&sort=U`
and the mobile referer. Rows are normalized from `items[]`: `id`, `title`,
`year`, `rating.value` → rating, `rating.count` → votes, `pic.large` (or
`pic.normal`) → poster, `type` → kind; `start`/`count` paging is exact and
rows whose `type` does not match the requested channel are dropped. As a
result Douban list cards show `<year> · 电影/剧集` like the other channels,
and the detail page finds a year there too. `/search` still uses
`j/subject_suggest` (that payload already has `year`).
