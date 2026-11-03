import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Meeting } from '../../shared/types/meeting'
import { fixedSentence, PUBLIC_RULES, publicMessage, toPublicMeeting, withoutLastError } from '../../server/utils/public-errors'
import type { PublicRule, PublicStage } from '../../server/utils/public-errors'
import { AnswerSlotBusyError } from '../../server/utils/qa/answerer'
import { DAILY_LIMIT_MESSAGE, EmbeddingInputTooLongError, dailyLimitReached } from '../../server/utils/qa/embedder'
import { tooManyChunksMessage } from '../../server/utils/summary/steps'
import { inspectStoredAudio } from '../../server/utils/verify-upload'

/** What a real failure can hold: a database's code and constraint, an object's key, a provider's reply. */
const PROVIDER_TEXT = ' {"error":{"message":"org_123 over its tier"}}'
const DATABASE_TEXT = ': PGRST116 violates check constraint "meetings_status_check"'
const OBJECT_KEY_TEXT = ' (GET meetings/9b1d/audio.ogg failed with 403)'

const STAGES: PublicStage[] = ['upload', 'transcription', 'extraction', 'indexing', 'answering']

const say = (stage: PublicStage, message: string, statusCode = 500) => publicMessage(stage, { message, statusCode })

/** Every sentence of ours a route can be handed, by the stage that says it, with the code's own words where the code exports them. */
const AUTHORED: Record<PublicStage, string[]> = {
  upload: [
    inspectStoredAudio({ audioBytes: 4096 }, { size: 4097, contentType: 'audio/ogg' })!,
  ],
  transcription: [
    'Meeting not found',
    'The meeting audio is missing from storage',
    'Stored audio is 4597 bytes, expected 4096',
    'The audio is larger than the transcription service accepts.',
    'Transcription stopped without an answer 2 times.',
    'Reading the transcription kept stopping without finishing; try again later.',
    'Saving the transcript kept stopping without finishing; try again later.',
    'The stored transcription reply changed. Try transcription again.',
    'The stored transcription reply is gone. Try transcription again.',
    'The last transcription attempt failed recently; wait 59s before retrying',
    'Meeting is pending_upload; it has no audio ready to transcribe',
    'This meeting\'s transcript is already there; the failure was in extraction — retry summarisation, not transcription',
    'The uploaded audio was rejected and removed, so there is nothing to transcribe; upload the recording again',
  ],
  extraction: [
    'Meeting not found',
    tooManyChunksMessage(41),
    'Extraction of chunk 3 of 9 stopped without an answer 2 times.',
    'Planning the extraction kept stopping without finishing; try again later.',
    'Saving the summary kept stopping without finishing; try again later.',
    'The last extraction failed recently; wait 12s before retrying',
    'This meeting has no transcript to summarise yet',
    'Meeting is failed; it has no transcript ready to summarise',
  ],
  indexing: [
    'Meeting not found',
    DAILY_LIMIT_MESSAGE,
    dailyLimitReached().message,
    new EmbeddingInputTooLongError(9_000).message,
    new EmbeddingInputTooLongError().message,
    'The embedding service is out of capacity for the moment. Try again shortly.',
    'The embedding service rejected our credentials.',
    'A passage in this transcript runs past 1000 lines, too long to index for questions. Its transcript and summary are not affected.',
    'The stored passages do not add up to this transcript; indexing will try again later.',
    'Indexing stopped without an answer 2 times; it will try again later.',
    'Indexing hit a problem on the server.',
    'Meeting is uploaded; it has no finished transcript to index yet',
    'This meeting\'s index belongs to another model or transcript. Only an explicit request replaces it.',
  ],
  answering: [
    'Ask a question that contains words.',
    'This meeting has not been indexed for questions yet. Index it first.',
    'This meeting\'s index is incomplete or out of date with its transcript. Index it again first.',
    'This meeting\'s transcript changed after it was indexed. Index it again first.',
    DAILY_LIMIT_MESSAGE,
    'The embedding service is out of capacity for the moment. Try again shortly.',
    'The embedding service rejected our credentials.',
    new AnswerSlotBusyError(new Date()).message,
    'Could not schedule the question. Try again shortly.',
    'Answering quota is exhausted for now.',
    'The answering service rejected our credentials.',
  ],
}

describe('publicMessage', () => {
  describe.each(STAGES)('for %s', (stage) => {
    it.each(AUTHORED[stage])('passes on our own sentence: %s', (message) => {
      expect(say(stage, message, 409)).toBe(message)
    })

    it.each(AUTHORED[stage])('stops our own sentence with anything appended: %s', (message) => {
      for (const appended of [PROVIDER_TEXT, DATABASE_TEXT, OBJECT_KEY_TEXT, '\n', '\nanother line', ' ']) {
        expect(say(stage, message + appended, 409)).toBe(fixedSentence(stage, 409))
      }
    })

    it.each(AUTHORED[stage])('stops our own sentence with anything in front of it: %s', (message) => {
      for (const prepended of [PROVIDER_TEXT, 'Supabase failed: ', '\n']) {
        expect(say(stage, prepended + message, 409)).toBe(fixedSentence(stage, 409))
      }
    })

    it('says the fixed sentence of its status class for what it does not know', () => {
      const unknown = `Could not reach the service: fetch failed${OBJECT_KEY_TEXT}`
      expect(say(stage, unknown, 429)).toBe(fixedSentence(stage, 429))
      for (const status of [400, 409, 413, 422, 500, 502, 503]) {
        expect(say(stage, unknown, status)).toBe(fixedSentence(stage, status))
        expect(say(stage, unknown, status)).toBe(fixedSentence(stage, 500))
      }
      expect(fixedSentence(stage, 429)).not.toBe(fixedSentence(stage, 500))
    })

    it('says nothing of the text in what it says instead', () => {
      expect(say(stage, `Supabase read failed${DATABASE_TEXT}${OBJECT_KEY_TEXT}${PROVIDER_TEXT}`, 500)).not.toMatch(/PGRST|constraint|audio\.ogg|org_123/)
    })

    it('holds every rule to an exact sentence, or a regex anchored at both ends with no wildcard', () => {
      const regexOf = (rule: PublicRule) => typeof rule === 'string' ? null : rule instanceof RegExp ? rule : rule.match
      for (const rule of PUBLIC_RULES[stage]) {
        const regex = regexOf(rule)
        if (!regex) continue
        expect(regex.source.startsWith('^'), regex.source).toBe(true)
        expect(regex.source.endsWith('$'), regex.source).toBe(true)
        // `m` would make the anchors match at any line, and a dot or a negated class any word.
        expect(regex.flags, regex.source).toBe('')
        expect(regex.source.replace(/\\./g, '').replace(/\[(?!\^)[^\]]*\]/g, ''), regex.source).not.toMatch(/\.|\[\^|\\S|\\W|\\D/)
        // What goes out as it came carries digits or a status and no word of anyone else's.
        // Only a rule that says something else instead may read more than that.
        if (rule instanceof RegExp) expect(regex.source.replace(/\[\\d,\]/g, ''), regex.source).not.toMatch(/\\w|\[/)
      }
    })
  })

  it('keeps a stage\'s sentences to that stage, where they say something only it can', () => {
    expect(say('answering', 'The meeting audio is missing from storage', 409)).toBe(fixedSentence('answering', 409))
    expect(say('indexing', 'Ask a question that contains words.', 400)).toBe(fixedSentence('indexing', 400))
  })

  it('passes on a rejected upload\'s size, which is only numbers', () => {
    expect(say('upload', 'Uploaded audio was 4097 bytes, expected 4096', 409)).toBe('Uploaded audio was 4097 bytes, expected 4096')
  })

  it('never repeats a rejected upload\'s media type, which the uploader set', () => {
    const reason = inspectStoredAudio({ audioBytes: 4096 }, { size: 4096, contentType: 'video/mp4' })!
    expect(reason).toMatch(/video\/mp4/)
    expect(say('upload', reason, 409)).toBe('The uploaded object is not audio/ogg.')
    // A type that is not one, which the shape above does not take either.
    const notAType = inspectStoredAudio({ audioBytes: 4096 }, { size: 4096, contentType: 'text/html, <script>' })!
    expect(say('upload', notAType, 409)).toBe(fixedSentence('upload', 409))
  })

  it('does not take the stored form of a refused upload, which says how its delete went', () => {
    const stored = 'Uploaded audio was 4097 bytes, expected 4096; object could not be deleted and needs sweeping (DELETE meetings/9b1d/audio.ogg failed with 500)'
    expect(say('upload', stored, 409)).toBe(fixedSentence('upload', 409))
  })

  it.each([
    'Meeting is failed; it has no audio ready to transcribe at PGRST116',
    'Meeting is deleted; it has no audio ready to transcribe',
    'Meeting is ; it has no audio ready to transcribe',
    'Stored audio is -4 bytes, expected 4096',
    'Stored audio is many bytes, expected 4096',
    'Transcription service refused the request (HTTP 400): {"error":{"message":"org_123"}}',
    'Could not reach the transcription service: fetch failed',
    'Transcription service returned a body we could not read: Unexpected token < in JSON at position 0',
    'Transcription quota is exhausted for now. Try again in 30s.',
    'Supabase update failed (PGRST116): relation "pipeline_runs" does not exist',
    'R2 GET meetings/9b1d/audio.ogg failed with 403',
    '',
  ])('does not take %j for transcription', (message) => {
    expect(say('transcription', message, 502)).toBe(fixedSentence('transcription', 502))
  })

  it.each([
    'Answering service refused the request (HTTP 400): {"error":{"code":"org_123"}}',
    'Answering service refused the request (HTTP 400): {"error":{"code":"org_123"}} Retrying needs the next request slot.',
    'Embedding service refused the request (HTTP 400, code 8007): model is overloaded',
    'The answer did not match the expected shape: ✖ Invalid input',
  ])('does not take %j for answering', (message) => {
    expect(say('answering', message, 502)).toBe(fixedSentence('answering', 502))
  })
})

describe('toPublicMeeting', () => {
  const row = { id: 'm', status: 'failed', failedStage: 'upload', errorMessage: 'PGRST116', audioKey: 'k' } as Meeting

  it('removes the field rather than setting it to null', () => {
    expect(toPublicMeeting(row)).toEqual({ id: 'm', status: 'failed', failedStage: 'upload', audioKey: 'k' })
    expect(toPublicMeeting(row)).not.toHaveProperty('errorMessage')
  })

  it('removes it from a meeting with no error too, so the wire has one shape', () => {
    expect(toPublicMeeting({ ...row, errorMessage: null })).not.toHaveProperty('errorMessage')
  })

  it('leaves the row it was given alone: the logic that reads it is still to run', () => {
    toPublicMeeting(row)
    expect(row.errorMessage).toBe('PGRST116')
  })
})

describe('withoutLastError', () => {
  it('removes the field and keeps the figures', () => {
    const answer = withoutLastError({ done: 1, total: 2, lastError: 'PGRST116' })
    expect(answer).toEqual({ done: 1, total: 2 })
    expect(answer).not.toHaveProperty('lastError')
  })
})

/**
 * TypeScript takes a `Meeting` wherever a `PublicMeeting` is asked for, since it only has one
 * field more, so nothing but this can say a route returned the raw row.
 */
describe('the routes', () => {
  const apiRoot = fileURLToPath(new URL('../../server/api/', import.meta.url))
  const appRoot = fileURLToPath(new URL('../../app/', import.meta.url))

  async function sources(root: string): Promise<Record<string, string>> {
    const found: Record<string, string> = {}
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ts|vue)$/.test(entry.name)) continue
      const path = `${entry.parentPath}/${entry.name}`
      found[path.slice(root.length)] = await readFile(path, 'utf8')
    }
    return found
  }

  /**
   * The raw `Meeting` type named in code, and not `PublicMeeting` or `MeetingSummary`: a
   * page's script only, with no comments or strings, which say the word for other reasons.
   */
  function namesTheRawType(source: string): boolean {
    const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(source)?.[1] ?? source
    const code = script.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '').replace(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g, '""')
    return /(?<![\w.])Meeting(?!\w)/.test(code)
  }

  /** A `return { ... }` with a `meeting` in it that did not go through the one function. */
  function returnsRawMeeting(source: string): boolean {
    const safe = source.replace(/\bmeeting: toPublicMeeting\([^)]*\)/g, '')
    return /\breturn\s*\{[^}]*\bmeeting\b/.test(safe)
  }

  /** A stored or thrown message read in a route, whichever way, or the last error. */
  const readsRawText = (source: string) => /\.message\b|\blastError\b|String\(err/.test(source)

  it('finds what it is looking for, so it cannot pass by reading nothing', async () => {
    const files = await sources(apiRoot)
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['meetings/[id].get.ts', 'meetings/[id]/transcribe.post.ts', 'meetings/index.post.ts']))
    expect(Object.values(files).filter(source => source.includes('toPublicMeeting(')).length).toBeGreaterThanOrEqual(5)
  })

  it('catches each way of getting it wrong', () => {
    expect(returnsRawMeeting('return { meeting }')).toBe(true)
    expect(returnsRawMeeting('return { meeting, upload }')).toBe(true)
    expect(returnsRawMeeting('return { upload, meeting }')).toBe(true)
    expect(returnsRawMeeting('return { meeting: outcome.meeting, summary: outcome.summary }')).toBe(true)
    expect(returnsRawMeeting('return {\n  meeting: outcome.meeting,\n  progress,\n}')).toBe(true)
    expect(returnsRawMeeting('return { meeting: toPublicMeeting(outcome.meeting), summary }')).toBe(false)
    expect(returnsRawMeeting('return { index: outcome.index }')).toBe(false)
    expect(namesTheRawType('import type { Meeting } from \'#shared/types/meeting\'')).toBe(true)
    expect(namesTheRawType('Promise<{ meeting: Meeting }>')).toBe(true)
    expect(namesTheRawType('Promise<{ meeting: PublicMeeting, summary: MeetingSummary }>')).toBe(false)
    expect(namesTheRawType('throw notFound(\'Meeting not found\')')).toBe(false)
    expect(readsRawText('message: outcome.message')).toBe(true)
    expect(readsRawText('progress: { lastError }')).toBe(true)
  })

  it('return no raw Meeting: not by type and not by value', async () => {
    const raw = Object.entries(await sources(apiRoot))
      .filter(([, source]) => namesTheRawType(source) || returnsRawMeeting(source))
      .map(([file]) => file)
    expect(raw).toEqual([])
  })

  it('read no error\'s text themselves: that is publicMessage\'s, which is handed the failure', async () => {
    const raw = Object.entries(await sources(apiRoot)).filter(([, source]) => readsRawText(source)).map(([file]) => file)
    expect(raw).toEqual([])
  })

  it('hand the app no raw Meeting to read: it asks for the public shape', async () => {
    const raw = Object.entries(await sources(appRoot))
      .filter(([, source]) => /errorMessage/.test(source) || namesTheRawType(source))
      .map(([file]) => file)
    expect(raw).toEqual([])
  })
})
