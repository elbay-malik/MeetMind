/** What this page may say about the server it came from, as that server knows it. */
export interface DeploymentFacts {
  /**
   * A Cron Trigger calls this server, so a meeting whose tab closed carries on by itself, very
   * slowly (ADR-0012's step 11 addendum). True only on a Worker: a Node server and `pnpm dev`
   * have no cron, and must not say so.
   */
  sweeps: boolean
  /**
   * The days after which everything stored for a meeting is deleted (ADR-0017), or null when
   * nothing is. Only what the purge really runs at: it needs a cron as well as the setting.
   */
  purgeDays: number | null
}

/**
 * Read during the server's render, from what Nitro's Cloudflare handler gave this request, which
 * is one of ADR-0016's signals: no setting can be forgotten or set by mistake, and no visitor can
 * send it. It comes to the browser in the payload. A page never rendered by the server says the
 * less, which is that nothing carries on.
 */
export function useDeploymentFacts() {
  return useState<DeploymentFacts>('deployment-facts', () => {
    if (!import.meta.server) return { sweeps: false, purgeDays: null }
    const event = useRequestEvent()
    const sweeps = event?.context.cloudflare !== undefined
    const config = useRuntimeConfig(event)
    return { sweeps, purgeDays: sweeps ? purgeDaysInEffect(config.retentionPurgeDays, config.public.demoMeetingId) : null }
  })
}
