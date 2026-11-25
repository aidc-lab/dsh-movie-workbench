# AGENTS.md

DSH plugin ("影视工作台"): a Host HTTP route plus a browser panel that searches TMDB, IMDb and Douban and finds BT resources. Plain JavaScript, Node built-ins only, no dependencies and no build step.

## Architecture

- `index.js` is the Host entry: `inject = ['webServer']`, one `prefix` route `/movie-workbench/api` registered through `ctx.effect`. Every request is admitted through `ctx.get('connection').requestRejection(req)` before `createHandler`; keep that wrapper around new routes. `llm` / `agentDefaultModel` are optional `ctx.get()` services, so the plugin must load in profiles without the AI stack.
- `lib/host.js` and `lib/providers.js` are public barrels; implementations live in `lib/host/` (router, config, params, pick, route modules) and `lib/providers/` (tmdb, imdb, douban, torrents, shared core). Import through the barrels.
- `client.js` is the whole browser half. The DSH loader expects one classic script: `window.__ModuleLoader__.load({ id: 'dsh-movie-workbench', ... })`, no top-level import/export, no JSX, `require('react')` only. CSS is one inline string injected as a `<style>` element.
- The page is one component that switches views via `data-view` (collection → series → chart → detail → channel → list). View state lives in a module-scoped `session` object so switching sidebar panels restores the last screen; add new persistent view state there.
- Sidebar panel id/key is `movies-workbench`; the locale namespace is `movies.workbench`.
- `tests/data-contract.md` is the authoritative Host↔Client contract (params, envelopes, error codes, caching). It is versioned/append-only; add a section for behavior changes. The README API table is only a summary.
- `cordis.patch.yml` supplies the plugin row config; `package.json`'s `dsh` block wires the bundle patch and client platform.

## Commands

- `make check` — `node --check` every source. New files under `lib/host/` or `lib/providers/` are picked up by Makefile wildcards; other new source files must be added to `SOURCES`.
- `make smoke` (alias `make test`) — `check` plus all offline tests.
- `node tests/client-smoke.mjs`, `node tests/render-smoke.mjs`, `node tests/access-smoke.mjs`, `node tests/torrent-smoke.mjs`, `node tests/pick-smoke.mjs` — run one test; plain Node scripts with no framework or filters.
- `make live` — network end-to-end harness for every Host route. It starts an ephemeral server, runs checks, then exits (it is not a dev server). It clears `TMDB_API_KEY` to exercise the keyless path. Use it for host/provider changes; smoke covers `/pick`, `/models`, the admission guard and the client.
- `make pack` — dry-run of published files. `package.json` `files` is a whitelist: new runtime files outside `lib/`, `client.js`, etc. must be added.
- `make install` / `make uninstall` — `dsh plugin --profile desktop ...`; fully quit DSH Desktop first and keep `pnpm` on `PATH`.
- `README.md` and `README.zh.md` are maintained together; update both for user-visible changes.

## Traps

- Valid requests must stay HTTP 200 with `ok:true` and per-provider failures in `errors[]`; reserve 400 for parameter validation. Never fail a whole request because one channel is down.
- The client only calls same-origin `/movie-workbench/api`; all upstream HTTP stays in the Host. Posters must go through `/image` because a browser `<img>` cannot send Douban's required `Referer`. Do not add CORS grants or `OPTIONS` preflight: the API is same-origin and relies on the DSH browser cookie, so a CORS grant would reopen cross-origin reads.
- TMDB credential precedence: `x-mw-tmdb-key` header → `tmdbApiKey` config → `TMDB_API_KEY`. A missing key is an `errors` entry, not a 5xx.
- `tests/render-smoke.mjs` patches the client source by regex: the `const session = { ... }` block, the `const ZH = { ... }` dictionary (simple single-quoted entries), and the `settingsOpen` `useState(false)` line. Reworking these literals breaks tests even when UI behavior is fine.
- Render tests assert `data-view="list|channel|chart|detail|collection|series"` and `.mw-*` classes; preserve these anchors.
- UI copy lives in the `ZH`/`EN` dictionaries in `client.js`; both must keep identical key sets. `locale/*.json` holds only plugin metadata.
- Some Host caches are module-scoped: IMDb seeds 3 h, Douban details 30 min, chart metadata 6 h/20 entries, torrents 10 min/80 entries, model catalog 60 s. Don't expect a repeated request to hit upstream.
- Don't rename localStorage keys casually: `dsh-movie-workbench.tmdb-key` and `.recent-searches` still read through from legacy `movies-workbench.*`.
