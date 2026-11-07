import type { H3Event } from 'h3'
import type { Meeting } from '#shared/types/meeting'
import { isPublicDemo } from './demo-meeting'

/** How long a data centre keeps a demo read: see ADR-0015's "The demo's reads come from the edge cache". */
export const DEMO_CACHE_SECONDS = 60 * 60

/** The part of the Workers Cache API used here; `caches.default` exists only on Cloudflare. */
interface EdgeCache {
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): Promise<void>
}

function edgeCache(): EdgeCache | undefined {
  return (globalThis as { caches?: { default?: EdgeCache } }).caches?.default
}

/**
 * Where one read of the demo is kept. The key is a synthetic URL, never a page anyone can
 * request, and it carries the meeting row's `updatedAt`: the row changes whenever anything is
 * redone, so a demo repaired with the variable unset is read afresh under a new key rather
 * than served its old transcript or summary for the rest of the hour.
 */
export function demoCacheKey(meeting: Pick<Meeting, 'id' | 'updatedAt'>, resource: string): string {
  return `https://meetmind.cache/demo/${meeting.id.toLowerCase()}/${resource}/${encodeURIComponent(meeting.updatedAt)}/v1`
}

type WaitUntil = (promise: Promise<unknown>) => void

/**
 * Let the store finish after the response is sent, where the platform allows it. Nitro puts
 * `waitUntil` on the event, backed by the Worker's execution context; without it the store
 * is awaited, so it is never cut off.
 */
async function finishAfterResponse(event: H3Event, work: Promise<void>): Promise<void> {
  const fromEvent = (event as { waitUntil?: WaitUntil }).waitUntil
  const workerContext = (event.context as { cloudflare?: { context?: { waitUntil?: WaitUntil } } }).cloudflare?.context
  if (fromEvent) fromEvent.call(event, work)
  else if (workerContext?.waitUntil) workerContext.waitUntil(work)
  else await work
}

/**
 * `load()`, read through this data centre's edge cache when, and only when, `meeting` is the
 * public demo and `finished` says the value can no longer change. The demo is public and
 * read-only, so a busy demo would otherwise read the same transcript and summary from the
 * database on every visit. Any other meeting is private to whoever holds its link (ADR-0013)
 * and is never stored. Where there is no Cache API (Node in development and tests) this is
 * just `load()`.
 *
 * The stored body is the JSON the route would have sent, and a hit is parsed from it, so the
 * response is the same bytes either way. Only a value `cacheable` accepts is stored: an error
 * thrown by `load` is never stored, and neither is an answer that says "not yet". A cache
 * that fails to answer or to store is a slower read, not a failed one.
 */
export async function readThroughDemoCache<T>(
  event: H3Event,
  meeting: Pick<Meeting, 'id' | 'updatedAt'>,
  resource: string,
  options: { finished: boolean, cacheable?: (value: T) => boolean },
  load: () => Promise<T>,
): Promise<T> {
  const cache = edgeCache()
  if (!cache || !options.finished || !isPublicDemo(event, meeting.id)) return load()

  const key = demoCacheKey(meeting, resource)
  const hit = await cache.match(key).catch(() => undefined)
  // Says which way the read went, so the cache can be seen working on the live site.
  if (hit?.ok) {
    setResponseHeader(event, 'x-demo-cache', 'hit')
    return JSON.parse(await hit.text()) as T
  }
  setResponseHeader(event, 'x-demo-cache', 'miss')

  const value = await load()
  if (options.cacheable && !options.cacheable(value)) return value

  const stored = cache.put(key, new Response(JSON.stringify(value), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${DEMO_CACHE_SECONDS}`,
    },
  })).catch(() => {})
  await finishAfterResponse(event, stored)
  return value
}
