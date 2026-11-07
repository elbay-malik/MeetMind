import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Answerer, AnswerInput } from '../../server/utils/qa/answerer'
import { askMeeting, capAnswer, MAX_ANSWER_CHARS, TOP_K } from '../../server/utils/qa/ask'
import { createStubAnswerer } from '../../server/utils/qa/stub-answerer'
import { createStubEmbedder } from '../../server/utils/qa/stub'
import { ProviderBusyError, type RequestPacer } from '../../server/utils/summary/groq'
import type { WireAnswer } from '../../shared/schemas/qa'
import type { TranscriptSegment } from '../../shared/types/meeting'
import { indexingHarness } from './helpers/indexing'

/**
 * A meeting long enough to plan into many windows, with one distinctive
 * exchange about the budget and one about hiring, far apart in time. The hiring
 * line shares no word — stopwords included — with the budget questions asked
 * below, since the stub embedder is a bag of tokens and would otherwise
 * legitimately rank it above the filler.
 */
function meeting(): TranscriptSegment[] {
  const filler = (i: number) => `general update number ${i} with nothing notable`
  return Array.from({ length: 80 }, (_, i) => ({
    idx: i,
    startMs: i * 5_000,
    endMs: i * 5_000 + 4_800,
    text: i === 10
      ? 'We agreed to cut the marketing budget by twenty percent next quarter.'
      : i === 11
        ? 'Finance will circulate the revised budget on Monday.'
        : i === 60
          ? 'Priya will interview two candidates for a design role.'
          : filler(i),
  }))
}

/** An answerer that returns a fixed reply and records what it was shown. */
function scriptedAnswerer(reply: WireAnswer) {
  const seen: AnswerInput[] = []
  const answerer: Answerer = {
    kind: 'stub',
    async reserveSlot() {},
    async answer(input) {
      seen.push(input)
      return reply
    },
  }
  return { answerer, seen }
}

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-ask-'))
})
afterAll(() => rm(dataDir, { recursive: true, force: true }))

const embedder = createStubEmbedder()
const harness = indexingHarness(() => dataDir)
const repo = () => harness.repos().index
const transcripts = () => harness.repos().transcripts

async function indexed(meetingId: string, segments = meeting()) {
  await harness.meetingWith(meetingId, segments)
  const outcome = (await harness.drive(meetingId, harness.depsWith(embedder))).at(-1)
  expect(outcome).toMatchObject({ kind: 'done' })
  return segments
}

const ask = (meetingId: string, question: string, answerer: Answerer) =>
  askMeeting({ meetingId, question, transcripts: transcripts(), embedder, repo: repo(), answerer })

describe('askMeeting', () => {
  it('answers from the retrieved lines, citing the one that supports it with its timestamp', async () => {
    await indexed('a1')
    const answer = await ask('a1', 'What did we decide about the marketing budget?', createStubAnswerer())

    expect(answer.found).toBe(true)
    if (!answer.found) return
    expect(answer.citations).toEqual([{
      quote: 'We agreed to cut the marketing budget by twenty percent next quarter.',
      segmentIdx: 10,
      startMs: 50_000,
    }])
  })

  it('shows the answering model only the retrieved lines, not the whole meeting', async () => {
    const segments = await indexed('a2')
    const { answerer, seen } = scriptedAnswerer({ citations: [], answer: '' })
    await ask('a2', 'What did we decide about the marketing budget?', answerer)

    const shown = seen[0]!.segments.map(s => s.idx)
    expect(shown).toContain(10)
    expect(shown.length).toBeLessThan(segments.length)
    // At most TOP_K windows' worth, contiguous runs in transcript order.
    expect(shown).toEqual([...shown].sort((a, b) => a - b))
    expect(new Set(shown).size).toBe(shown.length)
    expect(TOP_K).toBeGreaterThan(0)
  })

  it('drops a fabricated citation and withholds an answer left with none', async () => {
    // The whole point: a fluent answer whose evidence nobody said is not shown.
    await indexed('a3')
    const { answerer } = scriptedAnswerer({
      citations: [{ quote: 'We agreed to double the marketing budget immediately.', segmentIdx: 10 }],
      answer: 'The budget was doubled.',
    })
    expect(await ask('a3', 'What happened to the marketing budget?', answerer))
      .toEqual({ found: false, answer: null, citations: [] })
  })

  // Whisper splits sentences across segments, and the answering model quotes
  // the sentence. Lines 10 and 11 are consecutive and both retrieved by a
  // budget question; a quote running from one into the other is real speech.
  it('keeps a citation whose quote runs from one retrieved line into the next', async () => {
    await indexed('a12')
    const { answerer } = scriptedAnswerer({
      citations: [{ quote: 'by twenty percent next quarter. Finance will circulate the revised budget', segmentIdx: 10 }],
      answer: 'It was cut by a fifth.',
    })
    const answer = await ask('a12', 'What did we decide about the marketing budget?', answerer)
    expect(answer.found).toBe(true)
    if (!answer.found) return
    expect(answer.citations).toEqual([{
      quote: 'by twenty percent next quarter. Finance will circulate the revised budget',
      segmentIdx: 10,
      startMs: 50_000,
    }])
  })

  it('drops a real quote from a line that was never retrieved', async () => {
    // Line 60 exists in the meeting, but a budget question does not retrieve
    // it — so the model cannot have read it, and citing it is invention even
    // though the words are genuine. The check runs against the retrieved lines
    // only, not the whole transcript.
    await indexed('a4')
    const { answerer, seen } = scriptedAnswerer({
      citations: [{ quote: 'Priya will interview two candidates for a design role.', segmentIdx: 60 }],
      answer: 'Priya is interviewing.',
    })
    const answer = await ask('a4', 'What did we decide about the marketing budget?', answerer)
    expect(seen[0]!.segments.map(s => s.idx)).not.toContain(60)
    expect(answer).toEqual({ found: false, answer: null, citations: [] })
  })

  it('keeps the supported citations when only some are fabricated, in time order, once each', async () => {
    await indexed('a5')
    const { answerer } = scriptedAnswerer({
      citations: [
        { quote: 'Finance will circulate the revised budget on Monday.', segmentIdx: 11 },
        { quote: 'the budget was never discussed', segmentIdx: 11 },
        { quote: 'We agreed to cut the marketing budget by twenty percent next quarter.', segmentIdx: 10 },
        { quote: 'We agreed to cut the marketing budget by twenty percent next quarter.', segmentIdx: 10 },
      ],
      answer: '  The marketing budget is being cut by twenty percent, with a revised budget on Monday.  ',
    })
    const answer = await ask('a5', 'What did we decide about the marketing budget?', answerer)
    expect(answer).toEqual({
      found: true,
      answer: 'The marketing budget is being cut by twenty percent, with a revised budget on Monday.',
      citations: [
        { quote: 'We agreed to cut the marketing budget by twenty percent next quarter.', segmentIdx: 10, startMs: 50_000 },
        { quote: 'Finance will circulate the revised budget on Monday.', segmentIdx: 11, startMs: 55_000 },
      ],
    })
  })

  it('withholds an empty answer even when its citations check out', async () => {
    await indexed('a6')
    const { answerer } = scriptedAnswerer({
      citations: [{ quote: 'We agreed to cut the marketing budget by twenty percent next quarter.', segmentIdx: 10 }],
      answer: '   ',
    })
    expect((await ask('a6', 'What about the marketing budget?', answerer)).found).toBe(false)
  })

  it('returns an over-long answer cut to the cap, at a sentence end, with an ellipsis', async () => {
    await indexed('a14')
    const sentence = 'The budget was cut by twenty percent for the next quarter. '
    const { answerer } = scriptedAnswerer({
      citations: [{ quote: 'We agreed to cut the marketing budget by twenty percent next quarter.', segmentIdx: 10 }],
      answer: sentence.repeat(60),
    })
    const answer = await ask('a14', 'What about the marketing budget?', answerer)
    expect(answer.found).toBe(true)
    if (!answer.found) return
    expect(answer.answer.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS)
    expect(answer.answer).toMatch(/quarter\. …$/)
    expect(answer.citations).toHaveLength(1)
  })

  it('returns an answer within the cap unchanged', async () => {
    await indexed('a15')
    const text = 'The marketing budget was cut by twenty percent next quarter.'
    const { answerer } = scriptedAnswerer({
      citations: [{ quote: 'We agreed to cut the marketing budget by twenty percent next quarter.', segmentIdx: 10 }],
      answer: text,
    })
    expect(await ask('a15', 'What about the marketing budget?', answerer)).toMatchObject({ found: true, answer: text })
  })

  it('refuses to answer before the meeting is indexed, without spending any call', async () => {
    await transcripts().replaceForMeeting('a7', meeting())
    const { answerer, seen } = scriptedAnswerer({ citations: [], answer: '' })
    await expect(ask('a7', 'What about the budget?', answerer))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/not been indexed/) })
    expect(seen).toHaveLength(0)
  })

  it('refuses to answer from an index made stale by a replaced transcript', async () => {
    await indexed('a8')
    await transcripts().replaceForMeeting('a8', meeting().map(s => s.idx === 10 ? { ...s, text: 'We agreed to keep the budget unchanged.' } : s))
    const { answerer, seen } = scriptedAnswerer({ citations: [], answer: '' })
    await expect(ask('a8', 'What about the budget?', answerer))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/out of date/) })
    expect(seen).toHaveLength(0)
  })

  it('refuses a window whose text changed between the status check and retrieval', async () => {
    // The race the retrieval-time hash check exists for: the transcript is
    // replaced after the index reads as ready but before search runs. The marker
    // alone cannot catch it, so this repository reports it as finished while its
    // search hands back a window carrying a stale hash.
    await indexed('a11')
    const real = repo()
    const racing = {
      ...real,
      async search(...args: Parameters<typeof real.search>) {
        const matches = await real.search(...args)
        return matches.map((m, i) => i === 0 ? { ...m, contentHash: '0'.repeat(64) } : m)
      },
    }
    const { answerer, seen } = scriptedAnswerer({ citations: [], answer: '' })
    await expect(askMeeting({
      meetingId: 'a11', question: 'What about the marketing budget?', transcripts: transcripts(), embedder, repo: racing, answerer,
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/changed after it was indexed/) })
    expect(seen).toHaveLength(0)
  })

  it('refuses a question with no words in it', async () => {
    await indexed('a9')
    await expect(ask('a9', ' ?! ', createStubAnswerer()))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('does not let the stub answerer treat a shared short word as an answer', async () => {
    // Stub-only behaviour, but it is what every demo without a key shows: a
    // question sharing only "the" with an unrelated line must come back not
    // found, not as a confident citation of the wrong decision.
    await indexed('a12b')
    const answer = await ask('a12b', 'Which vendors bid for the office lease?', createStubAnswerer())
    expect(answer).toEqual({ found: false, answer: null, citations: [] })
  })

  it('reports not found, without calling the model, for a meeting with nothing in it', async () => {
    await indexed('a10', [])
    const { answerer, seen } = scriptedAnswerer({ citations: [], answer: '' })
    expect(await ask('a10', 'What about the budget?', answerer))
      .toEqual({ found: false, answer: null, citations: [] })
    expect(seen).toHaveLength(0)
  })
})

describe('a question\'s request slot', () => {
  const QUESTION = 'What did we decide about the marketing budget?'
  afterEach(() => vi.restoreAllMocks())

  function pacer(wait: () => Promise<void> = async () => {}) {
    const paced = { waits: 0, async wait() {
      paced.waits++
      await wait()
    }, async rateLimited() {} }
    return paced satisfies RequestPacer
  }

  // Otherwise slot pacing bounds nothing on Workers AI: a loop refused every slot would
  // still spend an embedding per request, and invited uploads could not be indexed.
  it('is taken before the question is embedded, so a refused question spends no embedding', async () => {
    await indexed('s1')
    const embed = vi.spyOn(embedder, 'embedQuery')
    const busy = pacer(async () => {
      throw new ProviderBusyError(new Date(Date.now() + 60_000))
    })
    await expect(ask('s1', QUESTION, createStubAnswerer({ pacer: busy })))
      .rejects.toMatchObject({ statusCode: 429, retryable: false })
    expect(embed).not.toHaveBeenCalled()
  })

  it('is taken once for an answered question, not again for the answer', async () => {
    await indexed('s2')
    const paced = pacer()
    const answer = await ask('s2', QUESTION, createStubAnswerer({ pacer: paced }))
    expect(answer.found).toBe(true)
    expect(paced.waits).toBe(1)
  })

  it('is not taken for a question refused because the meeting has no index', async () => {
    const paced = pacer()
    await transcripts().replaceForMeeting('s3-not-indexed', meeting())
    await expect(ask('s3-not-indexed', QUESTION, createStubAnswerer({ pacer: paced })))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(paced.waits).toBe(0)
  })
})

describe('the answer\'s length cap', () => {
  it('returns text within the cap unchanged, the cap itself included', () => {
    expect(capAnswer('It was cut.')).toBe('It was cut.')
    const exact = 'a'.repeat(MAX_ANSWER_CHARS)
    expect(capAnswer(exact)).toBe(exact)
  })

  it('cuts at the last sentence end before the cap', () => {
    const text = `${'word '.repeat(150)}end here. ${'more '.repeat(200)}`
    const capped = capAnswer(text)
    expect(capped.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS)
    expect(capped).toBe(`${'word '.repeat(150)}end here. …`)
  })

  it('does not take a decimal point for a sentence end', () => {
    const text = `${'word '.repeat(150)}then 3.5 ${'more '.repeat(200)}`
    const capped = capAnswer(text, 760)
    expect(capped.length).toBeLessThanOrEqual(760)
    expect(capped).not.toMatch(/3\. …$/)
    expect(capped).toMatch(/\w…$/)
  })

  it('cuts at the last space when no sentence ends late enough', () => {
    const capped = capAnswer('word '.repeat(400))
    expect(capped.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS)
    expect(capped).toMatch(/^(word )+word…$/)
  })

  it('cuts text with no spaces at the cap, without splitting a character', () => {
    const capped = capAnswer('😀'.repeat(MAX_ANSWER_CHARS))
    expect(capped.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS)
    expect(capped.endsWith('😀…')).toBe(true)
    const cjk = capAnswer('会议决定削减预算'.repeat(300))
    expect(cjk.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS)
    expect(cjk.endsWith('…')).toBe(true)
  })
})
