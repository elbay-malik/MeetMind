import { describe, expect, it } from 'vitest'
import { normalizeSegments } from '../../server/utils/transcription/normalize'
import { INITIAL_SCAN, parseSegments, scanWindow } from '../../server/utils/transcription/reply-scanner'
import { createStubTranscriber } from '../../server/utils/transcription/stub'

const stub = createStubTranscriber()
/** The stub's reply as the pages will read it: the same scanner, the same normalising. */
const transcriber = {
  async transcribe(input: { bytes: Uint8Array, contentType: string }) {
    const reply = await stub.transcribe(input)
    const { objects } = scanWindow(reply, INITIAL_SCAN, { atEnd: true, maxObjects: 1000 })
    const { duration } = JSON.parse(new TextDecoder().decode(reply)) as { duration: number }
    return { segments: normalizeSegments(parseSegments(objects)), durationSec: duration }
  },
}
const audioOf = (bytes: number) => ({ bytes: new Uint8Array(bytes), contentType: 'audio/ogg' })

describe('stub transcriber', () => {
  it('produces segments shaped like the real thing, so callers need no special case', async () => {
    const { segments } = await transcriber.transcribe(audioOf(60_000))
    expect(segments.length).toBeGreaterThan(0)
    for (const [i, s] of segments.entries()) {
      expect(s.idx).toBe(i)
      expect(s.endMs).toBeGreaterThanOrEqual(s.startMs)
      expect(s.text.trim()).not.toBe('')
    }
  })

  it('is deterministic, so tests that assert on it do not flake', async () => {
    const a = await transcriber.transcribe(audioOf(40_000))
    const b = await transcriber.transcribe(audioOf(40_000))
    expect(a).toEqual(b)
  })

  it('says plainly that it is not a real transcript', async () => {
    const { segments } = await transcriber.transcribe(audioOf(10_000))
    expect(segments[0]!.text).toMatch(/stub transcript/i)
    expect(segments[0]!.text).toMatch(/no transcription provider is configured/i)
  })

  it('scales its length with the audio', async () => {
    const short = await transcriber.transcribe(audioOf(4_000))
    const long = await transcriber.transcribe(audioOf(400_000))
    expect(long.durationSec!).toBeGreaterThan(short.durationSec!)
    expect(long.segments.length).toBeGreaterThan(short.segments.length)
  })

  it('handles a tiny file without producing zero or negative spans', async () => {
    const { segments, durationSec } = await transcriber.transcribe(audioOf(1))
    expect(durationSec).toBeGreaterThanOrEqual(1)
    expect(segments.length).toBeGreaterThanOrEqual(1)
    expect(segments[0]!.endMs).toBeGreaterThan(segments[0]!.startMs)
  })

  it('stays bounded for a long recording rather than emitting thousands of rows', async () => {
    const { segments } = await transcriber.transcribe(audioOf(25_000_000))
    expect(segments.length).toBeLessThanOrEqual(12)
  })
})
