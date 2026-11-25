import { API_PREFIX, normalizeSettings } from './config.js'
import { parseRequestUrl, readMethod, sendJson } from './http.js'
import { handleModels, handlePick } from './pick.js'
import { handleBrowse, handleSearch, handleStatus, handleTrending } from './routes/catalog.js'
import { handleImage } from './routes/image.js'
import { handleChart, handleCharts, handleCollection, handleDetail, handleSeries } from './routes/pages.js'
import { handleTorrents } from './routes/torrents.js'

/**
 * Create the HTTP handler for the whole Host half.
 *
 * @param {object} [config] plugin row config: `tmdbApiKey`, `maxResults`,
 *   `requestTimeoutMs`, `userAgent`
 * @param {object} [services] optional live Host services used by `POST /pick`:
 *   `getLlm()` returns the DSH LLM service or null, `getSelection()` returns
 *   the profile's default `{ provider, model }` selection or null
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 *   handler owning the full response lifecycle; it never rejects
 */
export function createHandler(config = {}, services = {}) {
  const settings = normalizeSettings(config)

  return async function moviesWorkbenchHandler(req, res) {
    try {
      if (!res || typeof res.writeHead !== 'function') return
      const method = readMethod(req)

      const requestUrl = parseRequestUrl(req)
      if (!requestUrl) {
        sendJson(req, res, 400, {
          ok: false,
          code: 'internal_error',
          message: 'Malformed request URL.',
        })
        return
      }

      if (
        requestUrl.pathname !== API_PREFIX &&
        !requestUrl.pathname.startsWith(`${API_PREFIX}/`)
      ) {
        sendJson(req, res, 404, {
          ok: false,
          code: 'not_found',
          message: 'Unknown endpoint.',
        })
        return
      }

      const endpoint = requestUrl.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'

      // `/pick` is the only POST endpoint; everything else stays read-only.
      if (endpoint === '/pick') {
        if (method !== 'POST') {
          sendJson(
            req,
            res,
            405,
            { ok: false, code: 'method_not_allowed', message: `Method ${method} is not allowed.` },
            { allow: 'POST' },
          )
          return
        }
      } else if (method !== 'GET' && method !== 'HEAD') {
        sendJson(
          req,
          res,
          405,
          { ok: false, code: 'method_not_allowed', message: `Method ${method} is not allowed.` },
          { allow: 'GET, HEAD' },
        )
        return
      }

      switch (endpoint) {
        case '/status':
          handleStatus(req, res, settings)
          return
        case '/search':
          await handleSearch(req, res, requestUrl.searchParams, settings)
          return
        case '/trending':
          await handleTrending(req, res, requestUrl.searchParams, settings)
          return
        case '/browse':
          await handleBrowse(req, res, requestUrl.searchParams, settings)
          return
        case '/charts':
          await handleCharts(req, res, requestUrl.searchParams, settings)
          return
        case '/chart':
          await handleChart(req, res, requestUrl.searchParams, settings)
          return
        case '/detail':
          await handleDetail(req, res, requestUrl.searchParams, settings)
          return
        case '/collection':
          await handleCollection(req, res, requestUrl.searchParams, settings)
          return
        case '/series':
          await handleSeries(req, res, requestUrl.searchParams, settings)
          return
        case '/torrents':
          await handleTorrents(req, res, requestUrl.searchParams, settings)
          return
        case '/image':
          await handleImage(req, res, requestUrl.searchParams, settings)
          return
        case '/pick':
          await handlePick(req, res, settings, services)
          return
        case '/models':
          await handleModels(req, res, services)
          return
        default:
          sendJson(req, res, 404, {
            ok: false,
            code: 'not_found',
            message: `Unknown endpoint "${endpoint}".`,
          })
      }
    } catch {
      // Last-resort guard: a broken socket or an unexpected bug must not escape
      // the route handler (the DSH web server would answer 400 and log it).
      sendJson(req, res, 500, {
        ok: false,
        code: 'internal_error',
        message: 'Unexpected error while handling the request.',
      })
    }
  }
}
