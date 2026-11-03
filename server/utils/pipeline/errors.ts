import { isDriverRefusal } from '../drivers'

/** What a caller of the pipeline routes is told of anything that went wrong on the server. */
const PIPELINE_INTERNAL_MESSAGE = 'The pipeline hit a problem on the server. Try again shortly.'

/**
 * Run a pipeline route's work, keeping the cause in the log. A database's or a storage
 * driver's error can name its tables or an object's key, and these routes say nothing of
 * anything but the meeting's own progress. What a route throws on purpose comes after this.
 *
 * A server that cannot run at all (ADR-0016) is the one thing that passes through: it says
 * nothing of any internals, and it has been logged once already, which this would repeat
 * for every request.
 */
export async function withoutInternals<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  }
  catch (err) {
    if (isDriverRefusal(err)) throw err
    console.warn('[meetmind] a pipeline route failed:', err)
    throw createError({ statusCode: 500, statusMessage: 'Pipeline failed', message: PIPELINE_INTERNAL_MESSAGE })
  }
}
