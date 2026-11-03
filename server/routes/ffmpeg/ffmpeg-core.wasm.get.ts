import { FFMPEG_CORE_WASM_KEY } from '#shared/utils/ffmpeg-core'
import { isDriverRefusal } from '../../utils/drivers'
import { useAudioStore } from '../../utils/storage'

const UNAVAILABLE = 'The audio tool could not be loaded. Try again later.'
const MISSING = 'The audio tool is not available on this server.'

/** A sentence of ours and nothing of the store's. Not cached, as the next request may well work. */
function plain(status: number, sentence: string): Response {
  return new Response(sentence, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  })
}

/**
 * ffmpeg's wasm on a Worker, from the private bucket (ADR-0018): it is over the 25 MiB asset
 * limit, so a Worker build leaves the file out and this answers at the same path. A Node
 * server and `pnpm dev` keep the public file, which is found before this route is.
 *
 * It takes nothing from the request, so no request can make it read any other object. The
 * headers are pinned, never reflected from R2, and the same goes for the type: an object's type
 * is whatever whoever put it there said. A plain Response, so the runtime pipes the bytes and a
 * Worker spends no CPU copying them. No Range: the browser reads the whole file once.
 */
export default defineEventHandler(async (event) => {
  let opened
  try {
    opened = await useAudioStore(event).openRange(FFMPEG_CORE_WASM_KEY, null)
  }
  catch (err) {
    if (isDriverRefusal(err)) return plain(503, (err as Error).message)
    console.warn('[meetmind] could not read the ffmpeg wasm:', err)
    return plain(503, UNAVAILABLE)
  }
  if (!opened) {
    console.warn(`[meetmind] the ffmpeg wasm is not in the bucket at ${FFMPEG_CORE_WASM_KEY}: run pnpm upload:ffmpeg-wasm`)
    return plain(404, MISSING)
  }
  return new Response(opened.body, {
    status: 200,
    headers: {
      'content-type': 'application/wasm',
      'content-length': String(opened.size),
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
})
