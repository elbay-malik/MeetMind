import { contentRangeHeader, parseByteRange, rangeLength } from '#shared/utils/byte-range'
import { AUDIO_MIME, DEMO_PLAYBACK_MIME } from '#shared/utils/meeting'
import { useAudioStore } from '../../../utils/storage'
import { RangeNotSatisfiableError } from '../../../utils/storage/audio-store'
import type { OpenedAudio } from '../../../utils/storage/audio-store'
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
 * usable later. The route is unauthenticated: holding the meeting's id is what
 * grants access, as on the rest of the API (ADR-0013).
 */
/**
 * Pass through a store's validator only if it is a well-formed entity tag.
 * Stores are not trusted to produce header-safe values.
 */
function sanitiseEtag(etag: string | null): string | null {
  if (!etag) return null
  return /^(W\/)?"[\x21\x23-\x7e]*"$/.test(etag) ? etag : null
}

export default defineEventHandler(async (event) => {
  const id = requireMeetingId(event)

  const meeting = await useMeetingRepository(event).get(id)
  if (!meeting) throw notFound('Meeting not found')
  if (meeting.status === 'pending_upload') throw notFound('This meeting has no audio yet')

  const store = useAudioStore(event)

  // The length comes from the row, not from a HEAD on every request.
  //
  // `complete.post.ts` HEADs the upload once and refuses to mark the meeting
  // `uploaded` unless the stored object is exactly `audioBytes`
  // (`inspectStoredAudio`), so a meeting past `pending_upload` carries a length
  // that was verified against storage. HEADing again per request bought nothing
  // and cost a second billable Class B operation against R2's 10-million-a-month
  // allowance -- which, at two operations a request, halved what this route can
  // serve for free -- plus a round-trip on the critical path of every seek.
  //
  // Correctness does not rest on that number being fresh. Every header below is
  // built from what the GET actually returned: `openRange` takes the served
  // window and the true size from Content-Range, never from the window asked
  // for. A stale `audioBytes` can therefore only make the REQUESTED window
  // wrong, which the store reports as 416 and which is handled below -- it
  // cannot make a 200 or 206 describe itself incorrectly.
  const requested = parseByteRange(getRequestHeader(event, 'range'), meeting.audioBytes)
  if (requested.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${meeting.audioBytes}`, 'accept-ranges': 'bytes' },
    })
  }

  const window = requested.kind === 'partial' ? requested.range : null
  let opened: OpenedAudio | null
  try {
    opened = await store.openRange(meeting.audioKey, window)
  }
  catch (error) {
    // The object is shorter than the row claims. Possible because it stays
    // writable for as long as its presigned PUT lives, so a length verified at
    // completion can be overtaken. The store knows the true length; answer with
    // it rather than failing the request.
    if (error instanceof RangeNotSatisfiableError) {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${error.size}`, 'accept-ranges': 'bytes' },
      })
    }
    throw error
  }
  if (!opened) throw notFound('The meeting audio is missing from storage')

  const partial = requested.kind === 'partial'
  const headers = new Headers({
    // Pinned, never reflected from the store. On R2 the browser's PUT sets the
    // object's type and the presigned signature covers only the host, so an
    // object could carry text/html; echoing that would turn this same-origin
    // route into a way to serve attacker-chosen markup from our own origin. The row is
    // ours, and only these two types come out of it whatever it holds.
    'content-type': meeting.audioMime === DEMO_PLAYBACK_MIME ? DEMO_PLAYBACK_MIME : AUDIO_MIME,
    'x-content-type-options': 'nosniff',
    'content-length': String(rangeLength(opened.window)),
    // Advertised even on a 200: Chromium will not treat a resource as seekable
    // without it.
    'accept-ranges': 'bytes',
    // Any content-encoding turns seeking off in Firefox regardless of correct
    // range handling, so forbid transformation in transit.
    'cache-control': 'private, max-age=3600, no-transform',
    // The store's own validator when it has one, so a replacement of the same
    // length is still a cache miss. The fallback is deliberately built only from
    // values we control: the stored content type is attacker-influenced on R2,
    // and putting it in a header would reflect untrusted text — quotes included
    // — into the response.
    'etag': sanitiseEtag(opened.etag) ?? `"${meeting.id}-${opened.size}"`,
  })
  if (partial) headers.set('content-range', contentRangeHeader(opened.window, opened.size))

  const status = partial ? 206 : 200

  // On a Node target, drive the response ourselves. h3's web-stream path pipes
  // without observing backpressure and never cancels the source when the client
  // disconnects, so a player that stops reading — which every seek causes — would
  // pull the rest of the object into memory with nobody listening. `pipeline`
  // applies backpressure and destroys the source on disconnect. Imported lazily
  // so the Workers bundle never evaluates node:stream.
  //
  // A real socket is what says so, and the same test h3's sendStream makes. On a Worker,
  // Nitro hands every request a mock response that has `writeHead` too and a null socket,
  // and writing to that one copies the whole object into a buffer, chunk by chunk: seconds
  // of CPU against a limit of 10 ms, with nothing reaching the browser until the end.
  const nodeRes = event.node?.res
  if (nodeRes?.socket && typeof nodeRes.writeHead === 'function') {
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
