import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Everything the code inside `work` logs is dropped, and nothing else is, however many
 * requests share this isolate meanwhile. For a tick of the cron sweeper (ADR-0012's step 11
 * addendum), which runs the steps a route runs. A route's steps log what went wrong as it
 * stands, and it can name a table or an object's key, with a route's logs being read per
 * request. A tick has 288 runs a day and nobody at the other end, and what went wrong
 * is on the run's row already. So this is one place rather than a rule for every step.
 */

const LEVELS = ['debug', 'error', 'info', 'log', 'warn'] as const

const holding = new AsyncLocalStorage<true>()
const WRAPPED = Symbol('meetmind.quiet-logs')

type Logger = ((...args: unknown[]) => void) & { [WRAPPED]?: true }

/**
 * Wrapped when first needed, not on load, so a server that never runs a tick never has its
 * console touched. Checked each time, as anything else may have replaced it since.
 */
function wrapConsole(): void {
  for (const level of LEVELS) {
    const current = console[level] as Logger
    if (current[WRAPPED]) continue
    const wrapped: Logger = (...args) => {
      if (!holding.getStore()) current.apply(console, args)
    }
    wrapped[WRAPPED] = true
    console[level] = wrapped
  }
}

export function withoutLogs<T>(work: () => Promise<T>): Promise<T> {
  wrapConsole()
  return holding.run(true, work)
}
