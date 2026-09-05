import { contentRangeHeader, parseByteRange, rangeLength } from '#shared/utils/byte-range'
import { AUDIO_MIME } from '#shared/utils/meeting'
import { useAudioStore } from '../../../utils/storage'
import { useMeetingRepository } from '../../../utils/db'
import { notFound, requireMeetingId } from '../../../utils/http'

/**
 * Stream a meeting's audio to the browser, with byte ranges.
 *
 * Range support is what makes the audio seekable, and its absence fails
 * quietly: without a valid 206 the browser reports no seekable ranges and a
 * seek snaps to the start rather than erroring. So this always advertises
 * `accept-ranges` and honours a single range.
 *
 * Served from our own origin rather than a presigned URL: the local driver is
 * unreachable from the public internet either way, a presigned link is a bearer
 * capability that outlives the page, and same-origin audio keeps Web Audio
 * usable later. The route is unauthenticated, which matches the rest of the API
 * until an auth phase arrives.
 */
export default defineEventHandler(async (event) => {
  const id = requireMeetingId(event)

  const meeting = await useMeetingRepository(event).get(id)
  if (!meeting) throw notFound('Meeting not found')
  if (meeting.status === 'pending_upload') throw notFound('This meeting has no audio yet')

  const store = useAudioStore(event)
  const probe = await store.head(meeting.audioKey)
  if (!probe) throw notFound('The meeting audio is missing from storage')

  const requested = parseByteRange(getRequestHeader(event, 'range'), probe.size)
  if (requested.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${probe.size}`, 'accept-ranges': 'bytes' },
    })
  }

  const window = requested.kind === 'partial' ? requested.range : null
  const opened = await store.openRange(meeting.audioKey, window)
  if (!opened) throw notFound('The meeting audio is missing from storage')

  const partial = requested.kind === 'partial'
  const headers = new Headers({
    // Pinned, never reflected from the store. On R2 the browser's PUT sets the
    // object's type and the presigned signature covers only the host, so an
    // object could carry text/html; echoing that would turn this same-origin
    // route into a way to serve attacker-chosen markup from our own origin.
    'content-type': AUDIO_MIME,
    'x-content-type-options': 'nosniff',
    'content-length': String(rangeLength(opened.window)),
    // Advertised even on a 200: Chromium will not treat a resource as seekable
    // without it.
    'accept-ranges': 'bytes',
    // Any content-encoding turns seeking off in Firefox regardless of correct
    // range handling, so forbid transformation in transit.
    'cache-control': 'private, max-age=3600, no-transform',
    // The store's own validator when it has one, so a replacement of the same
    // length is still a cache miss. Falling back to id and size would not
    // distinguish that case.
    'etag': probe.etag ?? `"${meeting.id}-${opened.size}-${probe.contentType ?? ''}"`,
  })
  if (partial) headers.set('content-range', contentRangeHeader(opened.window, opened.size))

  const status = partial ? 206 : 200

  // On a Node target, drive the response ourselves. h3's web-stream path pipes
  // without observing backpressure and never cancels the source when the client
  // disconnects, so a player that stops reading — which every seek causes — would
  // pull the rest of the object into memory with nobody listening. `pipeline`
  // applies backpressure and destroys the source on disconnect. Imported lazily
  // so the Workers bundle never evaluates node:stream.
  const nodeRes = event.node?.res
  if (nodeRes && typeof nodeRes.writeHead === 'function') {
    const { Readable } = await import('node:stream')
    const { pipeline } = await import('node:stream/promises')
    nodeRes.writeHead(status, Object.fromEntries(headers.entries()))
    try {
      await pipeline(
        Readable.fromWeb(opened.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
        nodeRes,
      )
    }
    catch {
      // A client that disconnects mid-stream is normal, not an error worth
      // surfacing; pipeline has already torn the source down.
    }
    event._handled = true
    return
  }

  // Workers and anything else: the runtime consumes the stream itself.
  return new Response(opened.body, { status, headers })
})
