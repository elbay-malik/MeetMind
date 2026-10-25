import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { MeetingSummary } from '#shared/types/meeting'
import type { Database } from './database.types'
import type { SupabaseOptions } from './supabase'
import {
  actionItemToRow,
  decisionToRow,
  rowToActionItem,
  rowToDecision,
  type SummaryRepository,
} from './summaries'

const clients = new Map<string, SupabaseClient<Database>>()

function clientFor(options: SupabaseOptions): SupabaseClient<Database> {
  const cacheKey = `${options.url}\n${options.serviceKey}`
  let client = clients.get(cacheKey)
  if (!client) {
    client = createClient<Database>(options.url, options.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    clients.set(cacheKey, client)
  }
  return client
}

function fail(action: string, error: { code?: string, message: string }): never {
  throw new Error(`Supabase ${action} failed${error.code ? ` (${error.code})` : ''}: ${error.message}`)
}

/** PostgREST caps result sets server-side, so reads page rather than truncate. */
const PAGE = 1000

export function createSupabaseSummaryRepository(options: SupabaseOptions): SummaryRepository {
  // Separate accessors per table: a union of table names defeats supabase-js's
  // row-type inference and everything downstream collapses to never.
  const summaries = () => clientFor(options).from('meeting_summaries')
  const decisions = () => clientFor(options).from('meeting_decisions')
  const actionItems = () => clientFor(options).from('meeting_action_items')

  return {
    kind: 'supabase',

    async replaceForMeeting(meetingId, summary) {
      // No cross-call transactions over PostgREST, so this is delete then
      // insert. The caller keeps the gap inside the window where the meeting is
      // claimed, and the composite primary keys make a repeat run a
      // replacement rather than a duplicate.
      const removedDecisions = await decisions().delete().eq('meeting_id', meetingId)
      if (removedDecisions.error) fail('decisions delete', removedDecisions.error)
      const removedActions = await actionItems().delete().eq('meeting_id', meetingId)
      if (removedActions.error) fail('action items delete', removedActions.error)

      const { error: upsertError } = await summaries().upsert({
        meeting_id: meetingId,
        summary: summary.summary,
        provider: summary.provider,
      })
      if (upsertError) fail('summary upsert', upsertError)

      if (summary.decisions.length > 0) {
        const { error } = await decisions()
          .insert(summary.decisions.map(d => decisionToRow(meetingId, d)))
        if (error) fail('decisions insert', error)
      }
      if (summary.actionItems.length > 0) {
        const { error } = await actionItems()
          .insert(summary.actionItems.map(a => actionItemToRow(meetingId, a)))
        if (error) fail('action items insert', error)
      }
    },

    async deleteForMeeting(meetingId) {
      // Normally a no-op by the time it runs -- deleting the meeting cascades
      // to all three tables -- but stated rather than assumed, so this method
      // means the same thing on both drivers. Items before the summary they
      // belong to.
      const removedDecisions = await decisions().delete().eq('meeting_id', meetingId)
      if (removedDecisions.error) fail('decisions delete', removedDecisions.error)
      const removedActions = await actionItems().delete().eq('meeting_id', meetingId)
      if (removedActions.error) fail('action items delete', removedActions.error)
      const removedSummary = await summaries().delete().eq('meeting_id', meetingId)
      if (removedSummary.error) fail('summary delete', removedSummary.error)
    },

    async getForMeeting(meetingId): Promise<MeetingSummary | null> {
      const { data, error } = await summaries()
        .select().eq('meeting_id', meetingId).maybeSingle()
      if (error) fail('summary select', error)
      if (!data) return null

      // Paged: PostgREST caps result sets server-side and says nothing, so an
      // unpaged read would silently truncate a long meeting's items.
      const storedDecisions = []
      for (let from = 0; ; from += PAGE) {
        const page = await decisions().select().eq('meeting_id', meetingId)
          .order('idx', { ascending: true }).range(from, from + PAGE - 1)
        if (page.error) fail('decisions select', page.error)
        storedDecisions.push(...page.data)
        if (page.data.length < PAGE) break
      }

      const storedActions = []
      for (let from = 0; ; from += PAGE) {
        const page = await actionItems().select().eq('meeting_id', meetingId)
          .order('idx', { ascending: true }).range(from, from + PAGE - 1)
        if (page.error) fail('action items select', page.error)
        storedActions.push(...page.data)
        if (page.data.length < PAGE) break
      }

      return {
        summary: data.summary,
        provider: data.provider,
        decisions: storedDecisions.map(rowToDecision),
        actionItems: storedActions.map(rowToActionItem),
      }
    },
  }
}
