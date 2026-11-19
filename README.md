**English** | [简体中文](README.zh.md)

# dsh-movie-workbench

A DeepSeek Harness bundle that adds a **影视工作台 / Movies workbench** panel to the
left sidebar: search movies and TV shows across **TMDB**, **IMDb** and **豆瓣** in one
place, browse per-channel recommendations, open a detail page and find BT resources.

## Features

- **One search, three channels** — results grouped by channel with poster, year,
  rating and a source link.
- **Idle recommendations** — one row per channel, each with a 查看全部 / See all page
  (up to 24 titles).
- **Detail page** — poster, original title, tags, synopsis and a source link; a 豆瓣
  synopsis loads lazily.
- **BT resources** — BT4G and BitSearch rows merged below the metadata, sortable by
  size, seeders or leechers; copy the magnet or open the source page.
- **Data-source switches** — turn TMDB, IMDb or 豆瓣 off from the page header; a
  disabled channel disappears from chips, rows, counts and results.
- **Recent searches and cancel-search** — recent chips under the search field; the
  clear control (or `Esc`) aborts a search and returns to recommendations.

## Install

1. Clone the repository:

   ```bash
   git clone https://github.com/aidc-lab/dsh-movie-workbench.git
   ```

2. In DSH open **Plugins**, choose **Add plugin**, and select the cloned directory (the
   folder that contains `package.json`).

3. Make sure the `dsh-movie-workbench` bundle is enabled. Restart DSH only if the
   installation reports that a restart is required; the 影视工作台 entry then appears in
   the left sidebar.

The bundle is plain JavaScript: no build step, no dependencies to install, and no session
is required. Its Host half registers one route, `/movie-workbench/api`.

After pulling a newer version, restart DSH so the Host loads the updated code.

## Data-source settings

The gear control beside the TMDB key control opens the data-source switches. The choice
is stored in `localStorage` (`dsh-movie-workbench.sources`); at least one channel stays
enabled, and when only one is left the chip row collapses to it.

## Idle recommendations

| Channel | Source | Note |
|---|---|---|
| TMDB | `trending/all/week` | needs a TMDB credential; otherwise the row shows the key action |
| IMDb | curated list resolved through the suggestion API | no public popularity feed; cached 3 h in Host memory |
| 豆瓣 | `j/search_subjects` (`tag=热门`, movie + TV) | keyless, carries the published rating |

The toolbar refresh control reloads the current screen (recommendations while idle, the
active search otherwise); saving or clearing the TMDB key refreshes the rows too.

## Detail page and synopsis

A result opens its own page inside the panel; the back control returns to the results.
豆瓣's suggestion and search endpoints return no synopsis, so a 豆瓣 title loads
`/detail?source=douban&id=` when its page opens: the Host fetches the subject's mobile
detail API (`m.douban.com/rexxar`, keyless) and caches it for 30 minutes. The page shows
`简介加载中…` until the text arrives; the same response carries genres, runtime, region
and the published rating.

## BT resources

The detail page also searches two keyless public torrent indexes using the title's
original and localized names, and lists the merged rows below the metadata. Per-row
actions: **复制 / Copy** copies the magnet link, **详情 / Details** opens the source page.
Sorting chips: default, seeders, leechers, size — click the active chip to flip the
direction; rows without the metric stay last.

| Source | Endpoint |
|---|---|
| BT4G | `https://bt4gprx.com/search?q=…&page=rss` |
| BitSearch | `https://bitsearch.to/search?q=…` (redirects to `bitsearch.eu`) |

Only metadata and magnet links are shown: no torrent file is downloaded, no tracker is
contacted, nothing is written to the session. Results are cached 10 minutes in Host
memory and per title in the page. These are third-party indexes; whether a download is
legal depends on your jurisdiction and the work.

## Host API

The Host half (`index.js` + `lib/`) owns one prefix route, `/movie-workbench/api`:

| Route | Purpose |
|---|---|
| `GET /status` | which channels have a credential |
| `GET /search?q=&source=&lang=` | fans out and returns normalized results |
| `GET /trending?source=&lang=&limit=` | recommendation rows, or one channel's longer list |
| `GET /detail?source=douban&id=` | one 豆瓣 subject's synopsis and metadata |
| `GET /torrents?q=&alt=&source=&limit=` | BT search (BT4G + BitSearch) |
| `GET /image?url=` | relays posters from allow-listed hosts |

All upstream HTTP runs in the Host, so the page stays same-origin and 豆瓣's `Referer`
requirement is handled server-side.

## Configuration

`cordis.patch.yml` row config:

| key | default | meaning |
|---|---|---|
| `tmdbApiKey` | `''` | optional server-side TMDB credential (fallback `TMDB_API_KEY` env) |
| `maxResults` | `12` | per-channel result cap |
| `requestTimeoutMs` | `8000` | per-upstream timeout |

TMDB needs a credential: set `tmdbApiKey`, or paste a v3 key / v4 bearer token into the
panel's key control (stored in this browser only). IMDb and 豆瓣 need no key.

## Notes

- Requires the DSH Web GUI (`ctx.webServer`) and outbound HTTPS to
  `api.themoviedb.org`, `v2.sg.media-imdb.com`, `movie.douban.com`, `bt4gprx.com`,
  `bitsearch.to` and the poster hosts.
- IMDb search results carry no rating; 豆瓣 recommendations carry their published
  `rate`; TMDB supplies vote averages.
- The public suggestion, rexxar, BT4G and BitSearch endpoints are undocumented and can
  change or rate-limit; failures surface per channel instead of failing the whole view.
