import { isTimeoutError } from '../providers.js'

/**
 * Read a streamed image body while enforcing the byte cap.
 *
 * @param {Response} response
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
export async function readBodyWithLimit(response, limit) {
  const stream = response.body
  if (!stream || typeof stream.getReader !== 'function') {
    const fallback = Buffer.from(await response.arrayBuffer())
    if (fallback.byteLength > limit) throw new ImageTooLargeError()
    return fallback
  }
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || !value.byteLength) continue
      total += value.byteLength
      if (total > limit) throw new ImageTooLargeError()
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    try {
      await reader.cancel()
    } catch {
      /* body already gone */
    }
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
  return Buffer.concat(chunks, total)
}
/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 */
export function sendImageFailure(req, res, error) {
  sendJson(req, res, 502, {
    ok: false,
    code: 'upstream_error',
    message: imageFailureMessage(error),
  })
}
/**
 * @param {unknown} error
 * @returns {string}
 */
export function imageFailureMessage(error) {
  if (error instanceof ImageTooLargeError) return error.message
  if (isTimeoutError(error)) return 'The image request timed out.'
  return 'The image request failed.'
}
/**
 * @param {Response} response
 * @returns {string} lower-case media type without parameters, or ''
 */
export function readContentType(response) {
  const raw = response.headers.get('content-type') || ''
  return raw.split(';', 1)[0].trim().toLowerCase()
}
/**
 * Drop an upstream body quietly.
 *
 * @param {Response} response
 */
export function discardBody(response) {
  try {
    if (response.body && typeof response.body.cancel === 'function') {
      const pending = response.body.cancel()
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    }
  } catch {
    /* irrelevant */
  }
}
/** Internal marker for a body that exceeds the poster size cap. */
export class ImageTooLargeError extends Error {
  constructor() {
    super('The image is larger than the 8 MiB limit.')
    this.name = 'ImageTooLargeError'
  }
}
/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {string} upper-case method, 'GET' when absent
 */
export function readMethod(req) {
  return req && typeof req.method === 'string' && req.method ? req.method.toUpperCase() : 'GET'
}
/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ pathname: string, searchParams: URLSearchParams } | null}
 */
export function parseRequestUrl(req) {
  const target = req && typeof req.url === 'string' && req.url ? req.url : '/'
  try {
    const url = new URL(target, 'http://movie-workbench.local')
    return { pathname: url.pathname, searchParams: url.searchParams }
  } catch {
    return null
  }
}
/**
 * Read one request header as a string (Node lower-cases header names).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name
 * @returns {string}
 */
export function readHeader(req, name) {
  const headers = req && req.headers ? req.headers : null
  if (!headers) return ''
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return ''
}
/**
 * Send a JSON response with the contract's JSON headers. Responses are
 * same-origin only: no CORS grant is attached.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {object} payload
 * @param {Record<string, string>} [extraHeaders]
 */
export function sendJson(req, res, statusCode, payload, extraHeaders) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    statusCode = 500
    body = '{"ok":false,"code":"internal_error","message":"Failed to serialize the response."}'
  }
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(extraHeaders || {}),
  }
  writeResponse(res, statusCode, headers, readMethod(req) === 'HEAD' ? null : body)
}
/**
 * Write a response, tolerating a missing / destroyed / already-closed socket.
 * This is the only place that touches `res.writeHead` / `res.end`.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {Record<string, string>} headers
 * @param {string | Buffer | null} body `null` sends headers without a body
 */
export function writeResponse(res, statusCode, headers, body) {
  if (!res || typeof res.writeHead !== 'function' || typeof res.end !== 'function') return
  try {
    if (res.destroyed || res.writableEnded) return
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(statusCode, headers)
    if (body === null || body === undefined) res.end()
    else res.end(body)
  } catch {
    try {
      if (!res.destroyed && typeof res.destroy === 'function') res.destroy()
    } catch {
      /* socket already gone */
    }
  }
}
