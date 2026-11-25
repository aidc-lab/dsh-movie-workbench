/**
 * dsh-movie-workbench Host data layer.
 *
 * The implementation lives in `lib/host/`: configuration, HTTP plumbing,
 * parameter parsing, provider adapters, the AI pick route and one module per
 * route family. This entry keeps the small public surface stable for
 * `index.js`, the tests and the live harness.
 *
 * Plain ESM, Node 24 globals only, no dependencies.
 */

export { API_PREFIX } from './host/config.js'
export { createHandler } from './host/index.js'
export { fallbackPick, parsePickResponse } from './host/pick.js'
