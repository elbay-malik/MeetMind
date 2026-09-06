import type { ActionItem, Decision, MeetingSummary } from '#shared/types/meeting'

export interface SummaryRepository {
  readonly kind: 'supabase' | 'local'
  /** Replace a meeting's whole extraction. Re-running is idempotent. */
  replaceForMeeting(meetingId: string, summary: MeetingSummary): Promise<void>
  getForMeeting(meetingId: string): Promise<MeetingSummary | null>
}

export type SummaryRow = {
  meeting_id: string
  summary: string
  provider: 'groq' | 'stub'
  created_at: string
  updated_at: string
}

export type DecisionRow = {
  meeting_id: string
  idx: number
  decision: string
  quote: string
  segment_idx: number
  start_ms: number
  created_at: string
}

export type ActionItemRow = {
  meeting_id: string
  idx: number
  task: string
  assignee: string | null
  due_date_text: string | null
  quote: string
  segment_idx: number
  start_ms: number
  created_at: string
}

export function rowToDecision(row: DecisionRow): Decision {
  return {
    idx: row.idx,
    decision: row.decision,
    quote: row.quote,
    segmentIdx: row.segment_idx,
    startMs: row.start_ms,
  }
}

export function decisionToRow(meetingId: string, item: Decision): Omit<DecisionRow, 'created_at'> {
  return {
    meeting_id: meetingId,
    idx: item.idx,
    decision: item.decision,
    quote: item.quote,
    segment_idx: item.segmentIdx,
    start_ms: item.startMs,
  }
}

export function rowToActionItem(row: ActionItemRow): ActionItem {
  return {
    idx: row.idx,
    task: row.task,
    assignee: row.assignee,
    dueDateText: row.due_date_text,
    quote: row.quote,
    segmentIdx: row.segment_idx,
    startMs: row.start_ms,
  }
}

export function actionItemToRow(meetingId: string, item: ActionItem): Omit<ActionItemRow, 'created_at'> {
  return {
    meeting_id: meetingId,
    idx: item.idx,
    task: item.task,
    assignee: item.assignee,
    due_date_text: item.dueDateText,
    quote: item.quote,
    segment_idx: item.segmentIdx,
    start_ms: item.startMs,
  }
}
