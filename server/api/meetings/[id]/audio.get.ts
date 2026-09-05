import { contentRangeHeader, parseByteRange, rangeLength } from '#shared/utils/byte-range'
import { AUDIO_MIME } from '#shared/utils/meeting'
import { useAudioStore } from '../../../utils/storage'
import { useMeetingRepository } from '../../../utils/db'
import { notFound, requireMeetingId } from '../../../utils/http'

/**
 * Stream a meeting's audio to the browser, with byte ranges.
 *
 * Range support is what makes the audio seekable, and its absence fails
 * quietly: with no valid 206 the browser reports no seekable ranges and a seek
 * snaps to the start rather than erroring. So this always advertises
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
      headers: {
        'content-range': `bytes */${probe.size}`,
        'accept-ranges': 'bytes',
      },
    })
  }

  const window = requested.kind === 'partial' ? requested.range : null
  const opened = await store.openRange(meeting.audioKey, window)
  if (!opened) throw notFound('The meeting audio is missing from storage')

  const partial = requested.kind === 'partial'
  const headers = new Headers({
    'content-type': opened.contentType ?? AUDIO_MIME,
    'content-length': String(rangeLength(opened.window)),
    // Advertised even on a 200: Chromium marks a resource unseekable without
    // it, whatever the response code.
    'accept-ranges': 'bytes',
    // Any content-encoding turns seeking off in Firefox regardless of correct
    // range handling, so forbid transformation in transit.
    'cache-control': 'private, max-age=3600, no-transform',
    // Weak-ish but stable: the object is immutable in practice once uploaded,
    // and both parts change together if it is ever replaced.
    'etag': `"${meeting.id}-${opened.size}"`,
  })
  if (partial) headers.set('content-range', contentRangeHeader(opened.window, opened.size))

  return new Response(opened.body, { status: partial ? 206 : 200, headers })
})
