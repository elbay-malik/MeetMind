import { randomUUID } from 'node:crypto'
import type { PipelineResponse, TranscriptSegment } from '../../../shared/types/meeting'
import { createLocalSummaryRepository } from '../../../server/utils/db/summaries-local'
import { EMBEDDING_DIMENSIONS, type Embedder } from '../../../server/utils/qa/embedder'
import { hashedTokenVector } from '../../../server/utils/qa/stub'
import { advancePipeline, type PipelineDeps } from '../../../server/utils/pipeline/advance'
import { assessPipeline, readPipeline, toPipelineResponse } from '../../../server/utils/pipeline/assess'
import { createLocalAudioStore } from '../../../server/utils/storage/local'
import { createStubSummarizer } from '../../../server/utils/summary/stub'
import type { Summarizer } from '../../../server/utils/summary/summarizer'
import type { Transcriber } from '../../../server/utils/transcription/transcriber'
import { indexingHarness } from './indexing'

const AUDIO = new Uint8Array(500).fill(7)

/** A line of about 2,000 tokens: alone, it is a chunk of extraction and a window of the index. */
export function longLine(i: number): string {
  return `Topic ${i} was discussed at length. ${Array.from({ length: 1500 }, (_, w) => `w${i}x${w}`).join(' ')}`
}

/** A short line. A few hundred of these make one chunk and many windows. */
export const shortLine = (i: number) => `segment ${i} discusses topic ${i} in a few words`

/** A reply in Whisper's own shape, with `lines` as its text. */
export function whisperReply(lines: string[]): Uint8Array {
  const segments = lines.map((text, i) => ({ id: i, seek: i * 100, start: i * 2, end: i * 2 + 1.5, text: ` ${text}`, tokens: [1, 2], temperature: 0 }))
  return new TextEncoder().encode(JSON.stringify({
    task: 'transcribe', language: 'english', duration: lines.length * 2, text: lines.join(' '), segments,
  }))
}

/** What the three providers were asked, in order, and what a test has queued for them to throw. */
export function scriptedProviders(lines: string[], options: { model?: string, summarizerKind?: Summarizer['kind'] } = {}) {
  const calls: Array<'whisper' | 'chunk' | 'embed'> = []
  /** The first line of each chunk sent, and every window's text sent, to tell repeats from new work. */
  const sent = { chunks: [] as number[], windows: [] as string[] }
  const queued = { whisper: [] as unknown[], chunk: [] as unknown[], embed: [] as unknown[] }
  /** Runs inside the next call to a provider, as if the world moved during it. */
  const during = { whisper: [] as Array<() => Promise<void>>, chunk: [] as Array<() => Promise<void>>, embed: [] as Array<() => Promise<void>> }
  let always: Partial<Record<keyof typeof queued, () => unknown>> = {}

  async function beforeReply(kind: keyof typeof queued): Promise<void> {
    calls.push(kind)
    await during[kind].shift()?.()
    const failure = queued[kind].shift() ?? always[kind]?.()
    if (failure) throw failure
  }

  const stub = createStubSummarizer()
  const transcriber: Transcriber = {
    kind: 'stub',
    async transcribe() {
      await beforeReply('whisper')
      return whisperReply(lines)
    },
  }
  const summarizer: Summarizer = {
    kind: options.summarizerKind ?? 'stub',
    summarize: stub.summarize,
    async summarizeChunk(input) {
      await beforeReply('chunk')
      sent.chunks.push(input.segments[0]!.idx)
      return stub.summarizeChunk(input)
    },
  }
  const embedder: Embedder = {
    kind: 'stub',
    model: options.model ?? 'model-a',
    dimensions: EMBEDDING_DIMENSIONS,
    async embedDocuments(texts) {
      await beforeReply('embed')
      sent.windows.push(...texts)
      return texts.map(t => hashedTokenVector(t))
    },
    async embedQuery(text) {
      return hashedTokenVector(text)
    },
  }
  return {
    transcriber,
    summarizer,
    embedder,
    calls,
    sent,
    count: (kind: keyof typeof queued) => calls.filter(c => c === kind).length,
    queue: (kind: keyof typeof queued, ...errors: unknown[]) => queued[kind].push(...errors),
    during,
    /** Every call to this provider throws what this returns, from now on. */
    keepFailing: (kind: keyof typeof queued, failure: () => unknown) => {
      always = { ...always, [kind]: failure }
    },
  }
}

export type ScriptedProviders = ReturnType<typeof scriptedProviders>

/** The local drivers a whole pipeline runs on, over one data directory. */
export function pipelineHarness(dataDir: () => string) {
  const indexing = indexingHarness(dataDir)
  const store = () => createLocalAudioStore({ dataDir: dataDir(), secret: 'test' })

  const depsWith = (providers: Pick<ScriptedProviders, 'transcriber' | 'summarizer' | 'embedder'>, overrides: Partial<PipelineDeps> = {}): PipelineDeps => ({
    ...indexing.repos(),
    summaries: createLocalSummaryRepository({ dataDir: dataDir() }),
    store: store(),
    transcriber: providers.transcriber,
    summarizer: providers.summarizer,
    embedder: providers.embedder,
    embedIntervalMs: 0,
    ...overrides,
  })

  /** A meeting as `complete` leaves it: its audio stored, and nothing else done. */
  async function uploadedMeeting(): Promise<string> {
    const id = randomUUID()
    const meeting = await indexing.meetingWith(id, [], 'uploaded')
    await store().put(meeting.audioKey, AUDIO, 'audio/ogg')
    return id
  }

  /** One `POST .../advance`, as the route answers it. */
  async function advance(id: string, deps: PipelineDeps): Promise<PipelineResponse> {
    const outcome = await advancePipeline(id, deps)
    if (outcome.kind !== 'assessed') throw new Error(`advance answered ${outcome.kind}`)
    return toPipelineResponse(outcome.assessment, Date.now())
  }

  /** One `GET .../pipeline`, as the route answers it. */
  async function read(id: string, deps: PipelineDeps): Promise<PipelineResponse> {
    const snapshot = await readPipeline(id, deps.embedder.model, deps)
    if (!snapshot) throw new Error('no such meeting')
    return toPipelineResponse(assessPipeline(snapshot, { model: deps.embedder.model, now: Date.now() }), Date.now())
  }

  /** The transcript as a whole, for a meeting that starts past transcription. */
  async function transcribedMeeting(segments: TranscriptSegment[], status: Parameters<typeof indexing.meetingWith>[2] = 'summarizing', patch: Parameters<typeof indexing.meetingWith>[3] = {}): Promise<string> {
    const id = randomUUID()
    await indexing.meetingWith(id, segments, status, patch)
    return id
  }

  /** Everything stored about a meeting and the account's blocks, for comparing before and after. */
  async function stored(id: string): Promise<unknown> {
    const db = indexing.db()
    const windows = await db.getItem<Array<{ idx: number, model: string, contentHash: string }>>(`windows/${id}`)
    return {
      meeting: await db.getItem(`meetings/${id}`),
      pipeline: await db.getItem(`pipeline/${id}`),
      summary: await db.getItem(`summaries/${id}`),
      transcript: await db.getItem(`transcripts/${id}`),
      windows: windows?.map(w => [w.idx, w.model, w.contentHash]) ?? null,
      slots: await Promise.all(['groq-chat', 'groq-whisper', 'workers-ai-embed'].map(p => db.getItem(`slots/${p}`))),
    }
  }

  return { ...indexing, store, depsWith, uploadedMeeting, transcribedMeeting, advance, read, stored }
}

/** The whole transcript under `lines`, numbered, the way a finished transcription leaves it. */
export function segmentsOf(lines: string[]): TranscriptSegment[] {
  return lines.map((text, idx) => ({ idx, startMs: idx * 2_000, endMs: idx * 2_000 + 1_500, text }))
}

/**
 * The requests each repository method makes on the real drivers, read from them, and the
 * provider calls each step makes. What `POST .../advance` spends is the sum of these, since
 * the route adds none of its own. `summarizeChunk` counts its slot, the Groq call and the
 * 429's note, whichever of them the scripted one stands in for.
 */
export const SUBREQUESTS: Record<string, number> = {
  'meetings.get': 1,
  'pipeline.claimStep': 1,
  'pipeline.releaseStep': 1,
  'pipeline.listRuns': 1,
  'pipeline.planChunks': 1,
  'pipeline.listChunks': 2,
  'pipeline.countChunks': 2,
  'pipeline.recordChunk': 1,
  'pipeline.finalizeSummary': 1,
  'pipeline.appendSegments': 1,
  'pipeline.finishTranscription': 1,
  'pipeline.upsertWindows': 1,
  'pipeline.finishIndex': 1,
  'pipeline.nextForSweep': 1,
  'pipeline.nextExpired': 1,
  'pipeline.deleteForMeeting': 3,
  'meetings.delete': 1,
  'summaries.deleteForMeeting': 3,
  'transcripts.deleteForMeeting': 1,
  'index.deleteForMeeting': 1,
  'transcripts.listRange': 1,
  'transcripts.listFrom': 1,
  // Grows with the meeting, one page per 1,000 lines. Only a transcript with no stored plan reaches it.
  'transcripts.listForMeeting': 1,
  'summaries.getForMeeting': 3,
  'index.readState': 1,
  'index.listKeys': 1,
  'slots.reserve': 1,
  'slots.noteRateLimit': 1,
  'slots.blockedUntil': 1,
  'store.get': 1,
  'store.put': 1,
  'store.openRange': 1,
  'store.delete': 1,
  'transcriber.transcribe': 1,
  'summarizer.summarizeChunk': 3,
  'embedder.embedDocuments': 1,
}

/** `deps`, with every method call tallied against {@link SUBREQUESTS}. */
export function tallied(deps: PipelineDeps) {
  const log: string[] = []
  const wrap = <T extends object>(name: string, target: T): T => new Proxy(target, {
    get(on, key, receiver) {
      const value = Reflect.get(on, key, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        log.push(`${name}.${String(key)}`)
        return Reflect.apply(value, on, args)
      }
    },
  })
  const counted: PipelineDeps = {
    ...deps,
    meetings: wrap('meetings', deps.meetings),
    pipeline: wrap('pipeline', deps.pipeline),
    transcripts: wrap('transcripts', deps.transcripts),
    summaries: wrap('summaries', deps.summaries),
    index: wrap('index', deps.index),
    slots: wrap('slots', deps.slots),
    store: wrap('store', deps.store),
    transcriber: wrap('transcriber', deps.transcriber),
    summarizer: wrap('summarizer', deps.summarizer),
    embedder: wrap('embedder', deps.embedder),
  }
  return {
    deps: counted,
    log,
    /** What has been spent since the log was last cleared. */
    take() {
      const taken = [...log]
      log.length = 0
      const unknown = taken.filter(call => !(call in SUBREQUESTS))
      if (unknown.length > 0) throw new Error(`no subrequest cost for ${[...new Set(unknown)].join(', ')}`)
      return {
        calls: taken,
        subrequests: taken.reduce((sum, call) => sum + SUBREQUESTS[call]!, 0),
        claims: taken.filter(call => call === 'pipeline.claimStep').length,
        providerCalls: taken.filter(call => ['transcriber.transcribe', 'summarizer.summarizeChunk', 'embedder.embedDocuments'].includes(call)).length,
      }
    },
  }
}
