import type { MeetingSearchResult } from '#shared/types/meeting'
import { searchQuerySchema } from '#shared/schemas/search'
import { useMeetingRepository, useTranscriptIndexRepository } from '../../utils/db'
import { badRequest } from '../../utils/http'
import { useEmbedder } from '../../utils/qa'
import { EmbeddingError } from '../../utils/qa/embedder'
import { searchMeetings, SearchError } from '../../utils/qa/search'

/**
 * Search across every indexed meeting's transcript (ADR-0008). Unlike
 * `POST /api/meetings/:id/ask`, this returns passages with their meeting, not
 * a synthesized answer — a meeting-scoped question already has a home.
 */
export default defineEventHandler(async (event): Promise<MeetingSearchResult> => {
  const parsed = searchQuerySchema.safeParse(getQuery(event))
  if (!parsed.success) throw badRequest('Invalid search query', parsed.error)

  try {
    return await searchMeetings({
      query: parsed.data.q,
      embedder: useEmbedder(event),
      repo: useTranscriptIndexRepository(event),
      meetings: useMeetingRepository(event),
    })
  }
  catch (err) {
    if (err instanceof SearchError) {
      throw createError({ statusCode: err.statusCode, statusMessage: 'Cannot search', message: err.message })
    }
    if (err instanceof EmbeddingError) {
      throw createError({ statusCode: err.statusCode, statusMessage: 'Search failed', message: err.message })
    }
    throw err
  }
})
