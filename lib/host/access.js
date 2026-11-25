/**
 * DSH browser admission for the plugin's HTTP routes.
 *
 * DSH's web server deliberately has no server-wide authentication or origin
 * policy: each route owner decides how requests are admitted. The panel is a
 * same-origin page served by `dsh-client-connection`, so every API request must
 * pass the Connection service's {@link requestRejection} check (Host/Origin
 * fence plus an authenticated browser cookie or API credential) before it
 * reaches the data layer. Missing services and unexpected answers fail closed.
 */

import { sendJson } from './http.js'

const REJECTIONS = {
  401: {
    code: 'unauthorized',
    message: 'Your DSH browser session is not authenticated. Reload the page and try again.',
  },
  403: {
    code: 'forbidden',
    message: 'This request did not pass the DSH origin and browser-session check.',
  },
}

/**
 * Create the per-request admission guard used by the route registration.
 *
 * `requestRejection(req)` is the DSH-supported check for HTTP route owners: it
 * returns 401, 403 or undefined (admitted), and wraps the same trust and
 * credential decision as `admit(req)` without exposing the Peer.
 *
 * @param {() => any} getConnection returns the live DSH `connection` service
 *   (or undefined when the profile does not mount it)
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean}
 *   true when the request may proceed; false after writing a refusal
 */
export function createAdmission(getConnection) {
  return function admitRequest(req, res) {
    let connection
    try {
      connection = getConnection()
    } catch {
      connection = undefined
    }

    if (!connection || typeof connection.requestRejection !== 'function') {
      sendJson(req, res, 503, {
        ok: false,
        code: 'access_unavailable',
        message: 'DSH browser authentication is unavailable on this Host.',
      })
      return false
    }

    let rejection
    try {
      rejection = connection.requestRejection(req)
    } catch {
      sendJson(req, res, 503, {
        ok: false,
        code: 'access_unavailable',
        message: 'DSH browser authentication could not be checked.',
      })
      return false
    }

    if (rejection === 401 || rejection === 403) {
      const info = REJECTIONS[rejection]
      sendJson(req, res, rejection, {
        ok: false,
        code: info.code,
        message: info.message,
      })
      return false
    }

    if (rejection !== undefined) {
      sendJson(req, res, 503, {
        ok: false,
        code: 'access_unavailable',
        message: 'DSH browser authentication returned an unexpected decision.',
      })
      return false
    }

    return true
  }
}
