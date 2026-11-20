**English** | [简体中文](README.zh.md)

# dsh-movie-workbench

DSH **Movies workbench** : Search for movies and TV series from **TMDB**, **IMDb** and **Douban** on one page and automatically discover BT resources.

| ![alt text](https://raw.githubusercontent.com/aidc-lab/dsh-movie-workbench/main/docs/home.png) | ![alt text](https://raw.githubusercontent.com/aidc-lab/dsh-movie-workbench/main/docs/detail.png)  |
|------|------|

## Features

- **Film & TV search** — results grouped by channel, with posters, years, ratings and source links.
- **Trending** — each channel's popular movies and TV series on the home page; the row length follows the panel width so every channel fills exactly two rows, and it re-requests on resize.
- **Channel browse** — open any channel for its own page with category tabs (TMDB: This week /
  Movies / TV; IMDb: Featured / Movies / TV; DouBan: Popular / Movies / TV) and infinite scroll for
  the next pages.
- **BT resources** — search BT resources, sortable by size, seeders or downloads; copy the magnet
  link or open the source page.

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
| `GET /detail?source=douban&id=` | synopsis and metadata for a DouBan title |
| `GET /torrents?q=&alt=&source=&limit=` | BT resource search |
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
- Channel browse pages return 20 items per page and stop at page 100. IMDb browse pages are
  cursor paged through IMDb's browser GraphQL popularity index, so scrolling keeps loading new
  titles; the home Trending row still uses a curated seed list, which is why it is limited.
- suggestion, rexxar, BT4G and BitSearch are undocumented endpoints and may change or rate-limit;
  failures are surfaced per channel and do not affect the others.
