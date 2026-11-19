import { createHandler } from './lib/host.js'

/** Host services this plugin needs: the named-route HTTP carrier. */
export const inject = ['webServer']

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
  const handler = createHandler(config)
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: '/movie-workbench/api',
      handler: (req, res) => {
        void handler(req, res)
      },
    })
    return () => dispose()
  })
}
