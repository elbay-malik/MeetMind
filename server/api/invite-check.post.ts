import { requireInviteCode } from '../utils/invite'

/**
 * Whether a code would be accepted, so the home page can refuse a wrong one before
 * the browser spends minutes extracting audio (ADR-0015). The same guard
 * `POST /api/meetings` runs first, and nothing else: no cheaper to guess against than
 * that route, and it reads and writes nothing.
 */
export default defineEventHandler(async (event) => {
  await requireInviteCode(event)
  setResponseStatus(event, 204)
  return null
})
