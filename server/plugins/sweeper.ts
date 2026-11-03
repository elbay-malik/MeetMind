import { runScheduledTick } from '../utils/pipeline/sweep'

/**
 * Where a Cron Trigger reaches the app (ADR-0012's step 11 addendum). Nitro's cloudflare_module
 * handler calls this hook for a scheduled event and nothing else ever does, so on Node and
 * under `pnpm dev` this registers something that never runs, and no route leads here.
 * Not `scheduledTasks`: those also run in-process on a Node server, and add a route under dev.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async ({ controller, env, context }) => {
    // Before anything can fail. Cloudflare documents no retry of a failed tick, and has
    // this to ask for none, so the next try is the next tick, and no failure comes back sooner.
    controller.noRetry()
    await runScheduledTick({ env, context })
  })
})
