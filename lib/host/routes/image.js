import { DEFAULT_USER_AGENT, isAllowedImageUrl, isDoubanHost } from '../../providers.js'
import { MAX_IMAGE_BYTES } from '../config.js'
import { discardBody, readBodyWithLimit, readContentType, readMethod, sendImageFailure, sendJson, writeResponse } from '../http.js'

/**
 * `GET /image?url=` — stream one poster back, because Douban images answer
 * HTTP 418 unless the request carries a Douban Referer.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} searchParams
 * @param {object} settings
 */
export async function handleImage(req, res, searchParams, settings) {
  const rawUrl = (searchParams.get('url') || '').trim()
  if (!rawUrl) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_request',
      message: 'The "url" query parameter is required.',
    })
    return
  }
  if (!isAllowedImageUrl(rawUrl)) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_request',
      message: 'The image URL is not an allowed https poster URL.',
    })
    return
  }

  const target = new URL(rawUrl)
  const headers = {
    'user-agent': settings.userAgent || DEFAULT_USER_AGENT,
    accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  }
  if (isDoubanHost(target.hostname)) headers.referer = 'https://movie.douban.com/'

  let upstream
  try {
    upstream = await fetch(target, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(settings.requestTimeoutMs),
    })
  } catch (error) {
    sendImageFailure(req, res, error)
    return
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    discardBody(upstream)
    sendJson(req, res, 502, {
      ok: false,
      code: 'upstream_error',
      message: 'The image host redirected the request.',
    })
    return
  }
  if (!upstream.ok) {
    discardBody(upstream)
    sendJson(req, res, 502, {
      ok: false,
      code: 'upstream_error',
      message: `The image host responded with HTTP ${upstream.status}.`,
    })
    return
  }

  const contentType = readContentType(upstream)
  if (!contentType || !contentType.startsWith('image/')) {
    discardBody(upstream)
    sendJson(req, res, 502, {
      ok: false,
      code: 'upstream_error',
      message: 'The image host did not return an image.',
    })
    return
  }

  const declaredLength = Number(upstream.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    discardBody(upstream)
    sendJson(req, res, 502, {
      ok: false,
      code: 'upstream_error',
      message: 'The image is larger than the 8 MiB limit.',
    })
    return
  }

  let body
  try {
    body = await readBodyWithLimit(upstream, MAX_IMAGE_BYTES)
  } catch (error) {
    sendImageFailure(req, res, error)
    return
  }

  writeResponse(
    res,
    200,
    {
      'content-type': contentType,
      'content-length': String(body.byteLength),
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    },
    readMethod(req) === 'HEAD' ? null : body,
  )
}
