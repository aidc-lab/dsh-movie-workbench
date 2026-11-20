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
