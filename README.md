**English** | [简体中文](README.zh.md)

# dsh-movie-workbench

DSH **Movies workbench** : Search for movies and TV series from **TMDB**, **IMDb** and **Douban** on one page and automatically discover BT resources.

| ![alt text](https://raw.githubusercontent.com/aidc-lab/dsh-movie-workbench/main/docs/home.png) | ![alt text](https://raw.githubusercontent.com/aidc-lab/dsh-movie-workbench/main/docs/detail.png)  |
|------|------|

## Features

- **Film & TV search** — results grouped by channel, with posters, years, ratings and source links.
- **Trending** — each channel's popular movies and TV series on the home page; the row length follows the panel width so every channel fills exactly two rows, and it re-requests on resize.
- **Channel browse** — open any channel for its own page with category tabs (TMDB: This week /
  Movies / TV; IMDb: Featured / Movies / TV; DouBan: Popular / Movies / TV / Movie charts /
  TV charts) and infinite scroll for the next pages.
- **DouBan charts (榜单)** — DouBan's channel page has two separate chart tabs, 电影榜单 and
  剧集榜单, with collapsible sections. Movie lists group 官方榜单, 年度榜单 (2025–2021,
  high-score and recent-hit variants), 高分经典 and 近期热门 for 27 genres, and 冷门佳作 for
  each genre; TV lists group 官方榜单, 年度榜单 and 高分经典 / 近期热门 for the same genres.
  Generated charts use their first title's poster as the card cover. Open a chart to see the
  ranked titles with the same paged infinite scroll.
- **Related sections on the detail page** — TMDB collections, IMDb related titles and
  DouBan charts are all shown as the same inline card: a cover, a name and a small meta
  line. A TMDB collection opens the collection page; an IMDb 相关系列 card opens the
  related-series page in release order; each DouBan 收录于榜单 card opens that chart's
  ranked titles directly.
- **BT resources** — search BT resources, sortable by size, seeders or downloads, with paged
  loading (scroll or 加载更多 for the next page); copy the magnet link or open the source page.

## Installation

### From the Plugins page

Paste the plugin's GitHub repository URL
`https://github.com/aidc-lab/dsh-movie-workbench.git` into the input field, as shown below.

![alt text](https://raw.githubusercontent.com/aidc-lab/dsh-movie-workbench/main/docs/install.png)

### From the CLI

`dsh plugin` does the same thing as the Plugins page: it installs the package as a profile
dependency and registers the bundle. Fully quit DSH Desktop first (the `desktop` profile is
initialized by the app and cannot be used while it is running), and make sure `pnpm` is on `PATH`.

```bash
npm install -g @deepseek-ai/dsh      # provides the dsh command
dsh plugin --profile desktop add dsh-movie-workbench
```

A Git URL also works:
`dsh plugin --profile desktop add git+https://github.com/aidc-lab/dsh-movie-workbench.git`.

## Data-source settings

The gear button next to the TMDB Key button in the page header opens the data-source switches. The
choice is stored in `localStorage` (`dsh-movie-workbench.sources`); at least one channel must stay
enabled, and when only one is left the filter row collapses to that channel.

## Host API

The Host side (`index.js` + `lib/`) exposes a single prefix route, `/movie-workbench/api`:

| Route | Purpose |
|---|---|
| `GET /status` | whether each channel has credentials |
| `GET /search?q=&source=&lang=` | dispatch to the selected channels and return normalized results |
| `GET /trending?source=&lang=&limit=` | recommendation rows, or a longer list for one channel |
| `GET /browse?source=&category=&page=&cursor=&lang=` | one page (20 items) of a channel browse category; returns `hasMore` and, for IMDb, an opaque `next` cursor for infinite scroll |
| `GET /charts?source=douban&kind=movie\|tv` | one chart catalog: `movie` (default) has 3 official charts with live metadata, 10 annual charts (高分/热门 for 2025–2021), 27 hidden-gem charts (one per genre) and 54 genre charts (94 total); `tv` has 3 official, 10 annual and 54 genre charts (67 total, no hidden gems) |
| `GET /chart?source=douban&id=&start=&count=` | one page of a chart's ranked titles; `id` is an official id, `year:<yyyy>:<S or U>`, `hidden:<genre>`, `genre:<genre>:<S or U>`, or the TV forms `tv-year:<yyyy>:<S or U>` / `tv-genre:<genre>:<S or U>` (S = high-score, U = recent hits) |
| `GET /detail?source=douban\|tmdb&id=` | synopsis and metadata for a DouBan title, or the collection reference of a TMDB movie |
| `GET /collection?source=tmdb&id=` | every part of a TMDB collection, as normalized movie results |
| `GET /series?source=imdb&id=` | the IMDb connection chain of one title (follows / followed by / spin-off), ordered by release year |
| `GET /chart?source=douban&id=collection:<id>` | one of the official charts a DouBan title is listed in, with the same ranked envelope as other charts |
| `GET /torrents?q=&alt=&source=&limit=&page=` | BT resource search; one page of results (`page` 1–20) plus `hasMore` for scroll loading |
| `GET /image?url=` | proxy posters from allowlisted image hosts |

All upstream HTTP requests happen in the Host, so the page stays same-origin and DouBan's `Referer`
requirement is handled server-side.

## Configuration

Plugin configuration in `cordis.patch.yml`:

| Option | Default | Meaning |
|---|---|---|
| `tmdbApiKey` | `''` | optional server-side TMDB credential (falls back to the `TMDB_API_KEY` environment variable) |
| `maxResults` | `12` | result cap per channel |
| `requestTimeoutMs` | `8000` | timeout for a single upstream request |

TMDB needs a credential: set `tmdbApiKey`, or paste a v3 key / v4 token into the Key control in the
panel (stored only in the local browser). IMDb and DouBan need no key.

## Notes

- Requires the DSH Web GUI (it provides `ctx.webServer`) and access to `api.themoviedb.org`,
  `v2.sg.media-imdb.com`, `api.graphql.imdb.com`, `movie.douban.com`, `bt4gprx.com`,
  `bitsearch.to` and the poster image hosts.
- IMDb search results carry no rating; DouBan recommendations include the public `rate`; TMDB
  provides ratings and vote counts.
- IMDb related titles come from IMDb's browser GraphQL `connections` field (up to 1,250
  relations per title); DouBan ranking chips come from `subject_collections` in the
  subject payload.
- Channel browse pages return 20 items per page and stop at page 100. IMDb browse pages are
  cursor paged through IMDb's browser GraphQL popularity index, so scrolling keeps loading new
  titles; the home Trending row still uses a curated seed list, which is why it is limited.
- suggestion, rexxar, BT4G and BitSearch are undocumented endpoints and may change or rate-limit;
  failures are surfaced per channel and do not affect the others.
