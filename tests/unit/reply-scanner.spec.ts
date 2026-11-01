import { describe, expect, it, vi } from 'vitest'
import {
  INITIAL_SCAN,
  parseSegments,
  replyDuration,
  ReplyFormatError,
  scanWindow,
  type ScanState,
} from '../../server/utils/transcription/reply-scanner'

const encode = (value: string) => new TextEncoder().encode(value)

const segment = (i: number, text = ` line ${i}`) => ({
  id: i, seek: i * 100, start: i, end: i + 0.5, text, tokens: [i, i + 1], temperature: 0, avg_logprob: -0.1, compression_ratio: 1.2, no_speech_prob: 0.01,
})

/** Groq's envelope, with the whole transcript's text ahead of the segments. */
function reply(segments: unknown[], extra: Record<string, unknown> = {}) {
  return encode(JSON.stringify({
    task: 'transcribe', language: 'english', duration: 50.1,
    text: segments.map(s => (s as { text?: string }).text ?? '').join(''),
    segments,
    x_groq: { id: 'req_1' },
    ...extra,
  }))
}

/**
 * Read a whole reply the way the pages do: a window from where the last one
 * stopped, doubled when it held nothing whole. Returns every object's text.
 */
function readAll(bytes: Uint8Array, windowBytes: number, maxObjects = 100) {
  let offset = 0
  let state: ScanState = INITIAL_SCAN
  let size = windowBytes
  const objects: Uint8Array[] = []
  for (let page = 0; page < 100_000; page++) {
    const window = bytes.subarray(offset, offset + size)
    const scanned = scanWindow(window, state, { atEnd: offset + window.length >= bytes.length, maxObjects })
    if (scanned.finished) {
      objects.push(...scanned.objects)
      return objects
    }
    if (scanned.consumed === 0 && scanned.objects.length === 0) {
      size *= 2
      continue
    }
    size = windowBytes
    objects.push(...scanned.objects.map(o => o.slice()))
    offset += scanned.consumed
    state = scanned.state
  }
  throw new Error('did not finish')
}

describe('scanWindow', () => {
  it('finds every segment object of a reply in one window', () => {
    const segments = [segment(0), segment(1), segment(2)]
    const raw = parseSegments(readAll(reply(segments), 1_000_000))
    expect(raw.map(s => s.start)).toEqual([0, 1, 2])
    expect(raw.map(s => s.text)).toEqual([' line 0', ' line 1', ' line 2'])
  })

  // The acceptance test: wherever a window ends -- inside an object, a string,
  // an escape, a multi-byte character, the envelope -- nothing changes.
  it('reads the same objects wherever the window boundaries fall', () => {
    const bytes = reply(
      [segment(0, ' héllo 日本語 🎉'), segment(1, ' a "quote" and a \\ slash }]'), segment(2, ' {"segments":[1]}'), segment(3, ' one " then } and ] and { too')],
      { note: 'x' },
    )
    const whole = readAll(bytes, bytes.length).map(o => new TextDecoder().decode(o))
    expect(whole).toHaveLength(4)
    expect(parseSegments(whole.map(encode)).at(-1)!.text).toBe(' one " then } and ] and { too')
    for (let windowBytes = 1; windowBytes <= 64; windowBytes++) {
      const paged = readAll(bytes, windowBytes).map(o => new TextDecoder().decode(o))
      expect(paged, `window of ${windowBytes} bytes`).toEqual(whole)
    }
  })

  it('leaves an object the window cuts for the next window, consuming nothing of it', () => {
    const bytes = reply([segment(0), segment(1)])
    const firstObjectEnd = new TextDecoder().decode(bytes).indexOf('}') + 1
    const window = bytes.subarray(0, firstObjectEnd + 5)
    const scanned = scanWindow(window, INITIAL_SCAN, { atEnd: false, maxObjects: 100 })
    expect(scanned.objects).toHaveLength(1)
    expect(scanned.finished).toBe(false)
    expect(new TextDecoder().decode(window.subarray(scanned.consumed))).not.toContain('}')
  })

  it('never hands back more objects than a page may hold, and resumes at the next', () => {
    const bytes = reply(Array.from({ length: 10 }, (_, i) => segment(i)))
    const first = scanWindow(bytes, INITIAL_SCAN, { atEnd: true, maxObjects: 4 })
    expect(first.objects).toHaveLength(4)
    expect(first.finished).toBe(false)
    const second = scanWindow(bytes.subarray(first.consumed), first.state, { atEnd: true, maxObjects: 100 })
    expect(parseSegments(second.objects).map(s => s.start)).toEqual([4, 5, 6, 7, 8, 9])
    expect(second.finished).toBe(true)
  })

  it('crosses a transcript text field far longer than a window', () => {
    const long = 'word '.repeat(50_000)
    const bytes = encode(JSON.stringify({ text: long, segments: [segment(0)] }))
    expect(parseSegments(readAll(bytes, 4096)).map(s => s.start)).toEqual([0])
  })

  it('finishes with a window of envelope, however little of it mattered', () => {
    const window = encode('{"text":"not there yet')
    expect(scanWindow(window, INITIAL_SCAN, { atEnd: false, maxObjects: 100 })).toMatchObject({ consumed: window.length, objects: [], finished: false })
  })

  it('is not fooled by a key-shaped string in the transcript text, or a nested segments key', () => {
    const decoy = { text: '"segments":[{"start":99,"end":99,"text":"decoy"}]', meta: { segments: [{ start: 98, end: 98, text: 'nested' }] } }
    const bytes = encode(JSON.stringify({ ...decoy, segments: [segment(0)] }))
    expect(parseSegments(readAll(bytes, 7)).map(s => s.start)).toEqual([0])
  })

  it('reads past an escaped quote in the envelope, which does not end its string', () => {
    const bytes = encode(JSON.stringify({ text: 'one " then } and ] closes nothing', segments: [segment(0)] }))
    expect(parseSegments(readAll(bytes, 3)).map(s => s.start)).toEqual([0])
  })

  it('finds segments wherever the envelope puts them, with whitespace around them', () => {
    const bytes = encode('{\n  "segments" : [ {"start":1,"end":2,"text":"a"} ,\n {"start":3,"end":4,"text":"b"} ]\n, "text":"ab" }')
    expect(parseSegments(readAll(bytes, 5)).map(s => s.start)).toEqual([1, 3])
  })

  it('reads a genuinely empty transcript as finished, with nothing in it', () => {
    const scanned = scanWindow(reply([]), INITIAL_SCAN, { atEnd: true, maxObjects: 100 })
    expect(scanned.finished).toBe(true)
    expect(scanned.objects).toEqual([])
  })

  describe('refuses', () => {
    const scanAll = (text: string) => () => scanWindow(encode(text), INITIAL_SCAN, { atEnd: true, maxObjects: 100 })

    // A silent empty transcript would look like a meeting with no speech.
    it('a reply with no segments array, rather than reading it as no speech', () => {
      expect(scanAll('{"text":"hello world"}')).toThrow(ReplyFormatError)
      expect(scanAll('{"text":"hello world"}')).toThrow(/no segments array/)
    })

    it('a segments field that is not an array', () => {
      expect(scanAll('{"segments":null,"text":"x"}')).toThrow(/no segments array/)
    })

    it('a segments array of something other than objects', () => {
      expect(scanAll('{"segments":[1,2]}')).toThrow(/not an object/)
    })

    it('a body that is not JSON at all', () => {
      expect(scanAll('<html>gateway timeout</html>')).toThrow(/could not read/)
    })

    it('an empty body', () => {
      expect(() => scanWindow(new Uint8Array(0), INITIAL_SCAN, { atEnd: true, maxObjects: 100 })).toThrow(/could not read/)
    })

    it('a reply cut off inside the envelope, or inside the array', () => {
      expect(scanAll('{"text":"cut off')).toThrow(/ends early/)
      expect(scanAll('{"segments":[{"start":1,"end":2,"text":"a"},{"start":')).toThrow(/ends early/)
      expect(scanAll('{"segments":[{"start":1,"end":2,"text":"a"}')).toThrow(/ends early/)
    })
  })
})

describe('parseSegments', () => {
  const slices = (...objects: unknown[]) => objects.map(o => encode(JSON.stringify(o)))

  it('tolerates unknown fields, since the envelope is not fully documented', () => {
    expect(parseSegments(slices(segment(4)))).toEqual([{ start: 4, end: 4.5, text: ' line 4' }])
  })

  it('refuses a segment missing a field the transcript needs', () => {
    expect(() => parseSegments(slices({ start: 0, end: 1 }))).toThrow(/unexpected response/)
    expect(() => parseSegments(slices({ start: 'soon', end: 1, text: 'x' }))).toThrow(ReplyFormatError)
  })

  it('refuses bytes that are not valid UTF-8 rather than patching them over', () => {
    expect(() => parseSegments([new Uint8Array([0x7B, 0x22, 0xFF, 0x22, 0x3A, 0x31, 0x7D])])).toThrow(/could not read/)
  })

  it('parses each object on its own: nothing ever parses the whole reply', () => {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const bytes = reply(Array.from({ length: 200 }, (_, i) => segment(i)))
      expect(parseSegments(readAll(bytes, 4096))).toHaveLength(200)
      const longest = Math.max(...parse.mock.calls.map(([text]) => text.length))
      expect(parse.mock.calls).toHaveLength(200)
      expect(longest).toBeLessThan(400)
    }
    finally {
      parse.mockRestore()
    }
  })
})

describe('replyDuration', () => {
  const head = (text: string) => new TextEncoder().encode(text)

  it('reads the envelope\'s duration, which comes before the transcript', () => {
    expect(replyDuration(head('{"task":"transcribe","language":"en","duration": 50.16,"text":"hi","segments":[]}'))).toBe(50.16)
  })

  it.each([
    ['absent', '{"task":"transcribe","text":"hi","segments":[]}'],
    ['not a number', '{"duration":"long","segments":[]}'],
    ['zero', '{"duration":0,"segments":[]}'],
    ['only quoted in the transcript', '{"text":"she said \\"duration\\": 5","segments":[]}'],
    ['too far in to be the envelope', `{"text":"${'x'.repeat(2000)}","duration":5,"segments":[]}`],
  ])('has nothing to say when it is %s', (_, text) => {
    expect(replyDuration(head(text))).toBeNull()
  })
})
