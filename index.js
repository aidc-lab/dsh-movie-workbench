import { createAdmission, createHandler } from './lib/host.js'

/** Host services this plugin needs: the named-route HTTP carrier. */
export const inject = ['webServer']

/**
 * Read one optional Host service without making the whole plugin wait for it.
 * The AI picker degrades to a friendly `llm_unavailable` answer when the
 * profile does not mount the model stack.
 *
 * @param {object} ctx Host plugin context
 * @param {string} name service name
 * @returns {any}
 */
function readService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * Register the movie-workbench HTTP route on the DSH web server.
 *
 * One `prefix` registration owns `/movie-workbench/api` (and everything under
 * it) and is disposed through `ctx.effect` with the plugin fiber.
 *
 * @param {object} ctx Host plugin context (injects `webServer`)
 * @param {object} [config] plugin row config: `tmdbApiKey`, `maxResults`,
 *   `requestTimeoutMs`, `userAgent`
 */
export function apply(ctx, config) {
  const handler = createHandler(config, {
    getLlm: () => readService(ctx, 'llm'),
    getSelection: () => {
      const service = readService(ctx, 'agentDefaultModel')
      try {
        return service && typeof service.currentSelection === 'function'
          ? service.currentSelection()
          : null
      } catch {
        return null
      }
    },
  })
  const admitRequest = createAdmission(() => readService(ctx, 'connection'))
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: '/movie-workbench/api',
      handler: (req, res) => {
        if (!admitRequest(req, res)) return
        void handler(req, res)
      },
    })
    return () => dispose()
  })
}
