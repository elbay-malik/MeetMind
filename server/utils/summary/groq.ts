import { z } from 'zod'
import type { MeetingSummary, TranscriptSegment } from '#shared/types/meeting'
import { wireSummarySchema, type WireSummary } from '#shared/schemas/summary'
import { planChunks } from './plan'
import { reconcile } from './reconcile'
import { SummarizationError, type SummarizeInput, type Summarizer } from './summarizer'

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'

/**
 * Only the gpt-oss models support strict structured outputs on Groq. The
 * playbook names llama-3.3-70b-versatile, which is still a current model but
 * cannot do the one thing this phase needs.
 */
const MODEL = 'openai/gpt-oss-120b'

/**
 * Transcript tokens allowed per request, leaving room inside the per-minute
 * allowance for the instructions and the reply. Exported so the route can plan
 * the same chunking to enforce a chunk-count ceiling before spending a single
 * provider call.
 */
export const CHUNK_BUDGET_TOKENS = 5000

/**
 * JSON Schema for the provider's strict mode, which is narrower than JSON
 * Schema at large: every property must be required, objects must forbid extra
 * properties, and an optional field is expressed as a union with null.
 */
function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>
  return harden(json) as Record<string, unknown>
}

function harden(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(harden)
  if (!node || typeof node !== 'object') return node

  // Keywords strict mode rejects. They constrain nothing the model can see
  // anyway, since validation happens against the transcript afterwards.
  const UNSUPPORTED = new Set([
    'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum',
    'exclusiveMaximum', 'format', 'pattern', 'minItems', 'maxItems', 'default',
  ])
  const copy = Object.fromEntries(
    Object.entries(node as Record<string, unknown>).filter(([key]) => !UNSUPPORTED.has(key)),
  )
  if (copy.type === 'object' && copy.properties && typeof copy.properties === 'object') {
    copy.additionalProperties = false
    copy.required = Object.keys(copy.properties as Record<string, unknown>)
    copy.properties = Object.fromEntries(
      Object.entries(copy.properties as Record<string, unknown>).map(([k, v]) => [k, harden(v)]),
    )
  }
  if (copy.items) copy.items = harden(copy.items)
  if (Array.isArray(copy.anyOf)) copy.anyOf = copy.anyOf.map(harden)
  return copy
}

const INSTRUCTIONS = [
  'You extract decisions and action items from meeting transcripts.',
  '',
  'Each transcript line is numbered. For every decision or action item you report,',
  'first quote the exact words from a single line that show it, then give the line',
  'number, then state the item. Quote verbatim: the quote is checked against the',
  'transcript and anything that does not appear there is discarded.',
  '',
  'Report only what was actually said. Most meetings contain few decisions and some',
  'contain none; empty lists are the correct answer in that case. Do not infer an',
  'assignee who was not named, and do not convert a spoken due date into a calendar',
  'date — record the words as spoken, or null.',
].join('\n')

function renderTranscript(segments: TranscriptSegment[]): string {
  return segments.map(s => `${s.idx}| ${s.text}`).join('\n')
}

export interface GroqSummarizerOptions {
  apiKey: string
  endpoint?: string
  timeoutMs?: number
  /** Attempts per chunk when the reply is unusable. One retry is usually enough. */
  maxAttempts?: number
  /**
   * Minimum time between the start of one chunk request and the next.
   * Sequential alone does not pace anything: two 5,000-token chunks (a full
   * CHUNK_BUDGET_TOKENS each) can both land inside the SAME rolling-minute
   * window and still exceed the provider's ~8,000-token aggregate allowance,
   * even though each fits comfortably under the per-request budget on its
   * own. Defaults to 60s, matching that rolling window; overridable so tests
   * are not forced to actually wait it out.
   */
  minRequestIntervalMs?: number
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export function createGroqSummarizer(options: GroqSummarizerOptions): Summarizer {
  const endpoint = options.endpoint ?? ENDPOINT
  const timeoutMs = options.timeoutMs ?? 90_000
  const maxAttempts = options.maxAttempts ?? 2
  const minRequestIntervalMs = options.minRequestIntervalMs ?? 60_000
  const jsonSchema = toStrictJsonSchema(wireSummarySchema)

  async function askOnce(transcript: string): Promise<WireSummary> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        // Structured outputs cannot be streamed, so this is a single reply.
        messages: [
          { role: 'system', content: INSTRUCTIONS },
          { role: 'user', content: transcript },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'meeting_summary', strict: true, schema: jsonSchema },
        },
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err)
      throw new SummarizationError(`Could not reach the summarization service: ${detail}`, 502, true)
    })

    if (!response.ok) throw await describeFailure(response)

    const body = await response.json().catch(() => {
      throw new SummarizationError('The summarization service returned an unreadable body', 502, true)
    }) as { choices?: { message?: { content?: string } }[] }

    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new SummarizationError('The summarization service returned no content', 502, false)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    }
    catch {
      throw new SummarizationError('The summarization service returned invalid JSON', 502, true)
    }

    const validated = wireSummarySchema.safeParse(parsed)
    if (!validated.success) {
      throw new SummarizationError(
        `The summary did not match the expected shape: ${z.prettifyError(validated.error)}`,
        502,
        true,
      )
    }
    return validated.data
  }

  return {
    kind: 'groq',

    async summarize({ segments }: SummarizeInput): Promise<MeetingSummary> {
      if (segments.length === 0) {
        return { summary: '', decisions: [], actionItems: [], provider: 'groq' }
      }

      const chunks = planChunks(segments, CHUNK_BUDGET_TOKENS)
      const parts: WireSummary[] = []

      // Sequential on purpose: the per-minute token allowance is the binding
      // limit, and firing chunks in parallel is the fastest way to exhaust it.
      // Sequential alone is not the same as PACED, though: two chunks sent
      // back to back can both land in the same rolling minute. Waiting out
      // the rest of the previous chunk's window before sending the next one
      // keeps each request inside its own window instead of exhausting the
      // aggregate limit partway through a multi-chunk run. (A within-chunk
      // retry from withRetries below is not separately paced against this —
      // a narrower, related gap left as-is here.)
      let previousChunkStartedAt = 0
      for (const chunk of chunks) {
        if (previousChunkStartedAt) {
          const remaining = minRequestIntervalMs - (Date.now() - previousChunkStartedAt)
          if (remaining > 0) await sleep(remaining)
        }
        previousChunkStartedAt = Date.now()
        parts.push(await withRetries(() => askOnce(renderTranscript(chunk.segments)), maxAttempts))
      }

      const merged: WireSummary = {
        summary: parts.map(p => p.summary.trim()).filter(Boolean).join(' '),
        decisions: parts.flatMap(p => p.decisions),
        actionItems: parts.flatMap(p => p.actionItems),
      }

      const { decisions, actionItems } = reconcile(merged, segments)
      return { summary: merged.summary, decisions, actionItems, provider: 'groq' }
    },
  }
}

/** Retry only what retrying can fix, and only as many times as asked. */
async function withRetries<T>(work: () => Promise<T>, attempts: number): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await work()
    }
    catch (err) {
      last = err
      const retryable = err instanceof SummarizationError && err.retryable
      if (!retryable || attempt === attempts) throw err
    }
  }
  throw last
}

async function describeFailure(response: Response): Promise<SummarizationError> {
  const detail = (await response.text().catch(() => '')).slice(0, 300)

  if (response.status === 429) {
    // Not retryable here: withRetries has no backoff, so an immediate retry
    // would hit the same throttle again and double the quota pressure that
    // triggered it. The chunk-level failure surfaces to summarize.post.ts,
    // whose own 30s cooldown before a `failed` meeting can be retried is the
    // backoff — instant retries are exactly what that cooldown exists to stop.
    const retryAfter = response.headers.get('retry-after')
    return new SummarizationError(
      `Summarization quota is exhausted for now.${retryAfter ? ` Try again in ${retryAfter}s.` : ''}`,
      429,
      false,
    )
  }
  if (response.status === 401 || response.status === 403) {
    return new SummarizationError('The summarization service rejected our credentials.', 502, false)
  }
  if (response.status >= 500) {
    return new SummarizationError(`Summarization service is unavailable (HTTP ${response.status}).`, 502, true)
  }
  return new SummarizationError(
    `Summarization service refused the request (HTTP ${response.status}): ${detail}`,
    502,
    false,
  )
}
