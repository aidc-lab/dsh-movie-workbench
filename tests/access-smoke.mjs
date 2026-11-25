/**
 * Offline tests for DSH browser admission and the same-origin response policy.
 *
 * The production boundary is `index.js`: it asks the profile's `connection`
 * service to admit each request before the data layer runs. These tests use a
 * fake `connection` service and Node-style request/response pairs so the
 * 401/403/503 paths and the route wiring stay covered without a DSH process.
 *
 * Run via `make smoke` or `node tests/access-smoke.mjs`.
 */
import assert from 'node:assert/strict'
import { createAdmission, createHandler } from '../lib/host.js'
import { apply } from '../index.js'

const tests = []
const failures = []

function check(name, ok, detail) {
  tests.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

function request(overrides = {}) {
  return {
    method: 'GET',
    url: '/movie-workbench/api/status',
    headers: { host: '127.0.0.1:55946', 'sec-fetch-site': 'same-origin' },
    ...overrides,
  }
}

function response() {
  return {
    status: 0,
    headers: undefined,
    body: null,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = { ...headers }
      this.headersSent = true
    },
    end(body) {
      if (body !== undefined) this.body = String(body)
      this.writableEnded = true
    },
  }
}

function bodyOf(res) {
  try {
    return JSON.parse(res.body || '')
  } catch {
    return null
  }
}

// --- admission guard -------------------------------------------------------

{
  const res = response()
  const admitted = createAdmission(() => undefined)(request(), res)
  check('missing connection refuses with 503', admitted === false && res.status === 503, String(res.status))
  check('missing connection returns access_unavailable', bodyOf(res)?.code === 'access_unavailable')
  check('refusal does not grant CORS', res.headers?.['access-control-allow-origin'] === undefined)
}

{
  const res = response()
  const admitted = createAdmission(() => ({ admit: () => ({ rejection: 401 }) }))(request(), res)
  check('unauthenticated connection is refused with 401', admitted === false && res.status === 401, String(res.status))
  check('401 body is unauthorized', bodyOf(res)?.code === 'unauthorized')
}

{
  const res = response()
  const admitted = createAdmission(() => ({ admit: () => ({ rejection: 403 }) }))(request(), res)
  check('untrusted origin is refused with 403', admitted === false && res.status === 403, String(res.status))
  check('403 body is forbidden', bodyOf(res)?.code === 'forbidden')
}

{
  const res = response()
  const admitted = createAdmission(() => ({
    admit: () => {
      throw new Error('broken service')
    },
  }))(request(), res)
  check('throwing admit refuses with 503', admitted === false && res.status === 503, String(res.status))
}

{
  const res = response()
  const admitted = createAdmission(() => ({ admit: () => ({}) }))(request(), res)
  check('decision without peer refuses with 503', admitted === false && res.status === 503, String(res.status))
}

{
  const res = response()
  const admitted = createAdmission(() => ({ admit: () => ({ peer: { id: 'browser' } }) }))(request(), res)
  check('admitted request proceeds untouched', admitted === true && res.status === 0 && res.body === null)
}

// --- same-origin HTTP policy ----------------------------------------------

{
  const handler = createHandler({})
  const res = response()
  await handler(request(), res)
  const body = bodyOf(res)
  check('GET /status still succeeds', res.status === 200 && body?.ok === true, String(res.status))
  check('JSON responses carry no CORS grant', res.headers?.['access-control-allow-origin'] === undefined)
  check('JSON responses keep nosniff', res.headers?.['x-content-type-options'] === 'nosniff')
}

{
  const handler = createHandler({})
  const res = response()
  await handler(request({ method: 'OPTIONS' }), res)
  check('OPTIONS is not a preflight endpoint', res.status === 405, String(res.status))
  check('method refusal advertises GET/HEAD only', res.headers?.allow === 'GET, HEAD')
}

// --- production route wiring ----------------------------------------------

{
  let route
  let admission = { rejection: 401 }
  const ctx = {
    get(name) {
      return name === 'connection' ? { admit: () => admission } : undefined
    },
    effect(callback) {
      callback()
      return () => {}
    },
    webServer: {
      register(registered) {
        route = registered
        return () => {}
      },
    },
  }

  apply(ctx, {})
  check('plugin registers the API prefix', route?.path === '/movie-workbench/api' && route?.kind === 'prefix')

  const refused = response()
  route.handler(request(), refused)
  check('production route admits before the handler', refused.status === 401 && bodyOf(refused)?.code === 'unauthorized')

  admission = { peer: { id: 'browser' } }
  const allowed = response()
  route.handler(request(), allowed)
  await new Promise(resolve => setTimeout(resolve, 0))
  check('authenticated request reaches the data layer', allowed.status === 200 && bodyOf(allowed)?.ok === true, String(allowed.status))
}

console.log(`\n${tests.length - failures.length}/${tests.length} access checks passed`)
if (failures.length > 0) {
  console.error(`Failed: ${failures.join(', ')}`)
  process.exit(1)
}
