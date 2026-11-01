/**
 * Meetings uploaded in this tab that the browser refused to add to Your meetings.
 * Kept in memory, because storage is the thing that said no, and read by the
 * meeting's link notice: at that moment the link on screen is the only copy.
 */
export const useNotRememberedMeetings = () => useState<string[]>('meetings-not-remembered', () => [])
