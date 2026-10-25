import type { SearchIndexStatus } from '#shared/types/meeting'

/**
 * Indexing runs in flight in this process, by meeting. A second request for the
 * same meeting -- a double click, or a second tab -- joins the first run instead
 * of embedding the same windows twice against a daily quota.
 *
 * Per process only, like the Groq pacer. Two processes can still both index one
 * meeting; that costs quota but not correctness, since every write is an
 * idempotent upsert of the same windows, keyed by index and hash.
 *
 * Shared with the delete route, because indexing is the one pipeline step with
 * no claim on the meeting row to fence against: a run that outlives its
 * meeting's deletion writes the windows back. On Supabase the foreign key
 * refuses that write; the local driver has nothing that would, so
 * `deleteMeeting` refuses while a run is here, and after deleting the row waits
 * for any run that registered in between before removing the windows. That
 * only works because the indexing route registers its run before reading the
 * meeting row. The
 * local driver is single-process by design, so this map sees every run there
 * is.
 */
export const indexingInFlight = new Map<string, Promise<SearchIndexStatus>>()
