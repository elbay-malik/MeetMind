import { z } from 'zod'
import type { Meeting } from '#shared/types/meeting'
import { useMeetingRepository } from '../../utils/db'
import { badRequest } from '../../utils/http'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

/** Most recent meetings first. */
export default defineEventHandler(async (event): Promise<{ meetings: Meeting[] }> => {
  const parsed = querySchema.safeParse(getQuery(event))
  if (!parsed.success) throw badRequest('Invalid query', parsed.error)
  const meetings = await useMeetingRepository(event).list({ limit: parsed.data.limit })
  return { meetings }
})
