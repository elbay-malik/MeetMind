# ADR-0011: Deleting a meeting is an admin operation

- **Status:** Accepted, amended by [ADR-0013](0013-private-meeting-links.md) and [ADR-0017](0017-retention-purge.md)
- **Date:** 2026-10-25

## Context

There was no DELETE route anywhere in the API. ADR-0010's storage budget stops the
archive growing past its ceiling, but nothing could make room again: once full,
uploads were refused (507) until the bucket's 30-day lifecycle rule expired
something. The 2026-09-22 audit listed this as the top open gap.

The app has no users and no auth. Every meeting is reachable by anyone who knows
its id, and `GET /api/meetings` lists them. A delete route open to the same
callers would turn deletion into free vandalism of the whole archive.

Deleting a meeting also races the rest of the pipeline. Steps that write a
meeting's data can still be running when the delete lands, and a late write
leaves data behind that nothing tracks. Measured against the code, before any of
this was built:

| Writer still running | Supabase | Local driver |
| --- | --- | --- |
| Browser PUT on a still-valid upload URL | object with no row: billed, **not counted by the budget** | same |
| Transcription writing segments | foreign key refuses it | orphan transcript file |
| Summarisation writing the summary | foreign key refuses it | orphan summary file |
| Indexing writing windows | foreign key refuses it | orphan windows file, **which cross-meeting search still scans** |

The upload row is the serious one. A presigned PUT stays usable for its whole
lifetime whatever the meeting's status, so this applies to an `uploaded`
meeting too, not only a `pending_upload` one.

## Decision

`DELETE /api/meetings/:id` exists and is **admin-only**. It needs
`Authorization: Bearer <NUXT_ADMIN_TOKEN>`.

- **No token configured: the route answers 404**, the same as a route that does
  not exist. An unconfigured deployment neither accepts nor advertises it. There
  is no generated fallback, unlike the local upload secret: a token nobody knows
  would only make the route look enabled.
- **A token shorter than 32 characters is refused** with a 500 rather than used.
  It is the only thing between the internet and an irreversible delete.
- **The token is compared in constant time.** Both values are MACed under a key
  made for that one comparison, and Web Crypto compares the MACs, as
  `signed-token.ts` already does. `node:crypto.timingSafeEqual` does not exist
  on Workers.
- **Authorisation is checked before the id is looked at**, so an unauthenticated
  caller cannot learn whether a meeting exists.

The route refuses with **409 and a `Retry-After`** while a writer could still be
active:

- **Within 20 minutes of registration.** That is the 5-minute upload URL plus 15
  minutes of grace, because R2 checks expiry when a PUT *starts*, not when it
  finishes. Measured from `createdAt`, which is written just after the URL is
  minted, so it can only overestimate how long the URL lives.
- **While a transcription or summarisation claim is inside its lease.** A claim
  past its lease is treated as abandoned, which is how the routes themselves
  treat it.
- **While indexing is running in this process.** Indexing has no claim on the
  row to check, and no deadline to count down to, so the `Retry-After` is a
  fixed 60 seconds. Only the local driver needs this guard (its single process
  sees every run), because on Supabase the foreign key refuses the late write.
  The check is a read, so an indexing request can start after it and still read
  the row before the row goes. The indexing route therefore registers its run
  *before* reading the row, and after deleting the row the delete route waits
  for any run now registered, then removes the windows. The not-found path,
  which sweeps up after a failed delete, waits the same way.

It then deletes in this order:

1. **The row, fenced on the `status` and `updated_at` it just read**, in one
   `DELETE … WHERE id AND status AND updated_at RETURNING *`. A claim that lands
   between the check and the delete leaves nothing to match, so the route
   answers 409 (`Retry-After: 1`) and a meeting that is in use loses nothing. On Supabase every
   child table goes with the row by `on delete cascade`; no migration was
   needed.
2. **Everything else: the audio object, then windows, summary and transcript.**
   On the local driver these are separate files with no cascade. On Supabase the
   child deletes are normally no-ops, but are issued anyway so the method means
   the same thing on both drivers.

Every step in (2) is idempotent and the audio key follows from the id. So when
cleanup fails after the row is gone, the route answers 500 and asks for the
request to be repeated, and a repeat that finds no row runs (2) again before
answering 404.

## Consequences

- The storage budget becomes reversible. It is derived from the rows (ADR-0010),
  so a meeting's bytes stop counting the moment its row is deleted, with no
  counter to keep in step.
- Deleting is an operator task: `curl -X DELETE -H "Authorization: Bearer $TOKEN"`.
  There is no button in the UI. A user cannot delete their own meeting.
- A meeting cannot be deleted in the first 20 minutes after it is registered.
  This is deliberate, and the 409 says when to retry.
- One case is still open. If the row is deleted but the audio delete then fails,
  and the request is never repeated, the object stays billable but uncounted
  until the lifecycle rule expires it. That is at most one meeting's audio
  (`MAX_AUDIO_BYTES`, 25 MB) per failed delete, and the 500 says to repeat.
- The ceiling is still global, not per caller (audit, 2026-09-22). Admin delete
  is how an operator recovers from an archive filled by abuse. It does not
  prevent the abuse.

## Alternatives considered

- **A per-meeting delete secret returned at upload.** This lets an uploader delete
  their own meeting without accounts. Rejected for now: it means storing a hash,
  adding a migration, and keeping the secret in the browser, which is a
  half-built auth system. The admin route does not stand in its way later.
- **An open DELETE, matching the open upload and read routes.** Rejected: it makes
  wiping the whole archive a loop over `GET /api/meetings`.
- **Delete the audio first, then the row.** This is what `failMeetingUpload`
  does, and it never leaves bytes uncounted. Rejected here: if the fenced row
  delete then loses to a claim, a meeting still in use has lost its audio. Row
  first, with an idempotent finish on retry, never damages a live meeting.
- **A `deleting` tombstone status.** This is stronger than the time-based
  guards, but needs a migration to the status CHECK and changes to every claim
  path. That is not worth it for an operator route.

## Addendum (2026-11-02): no list, and the only way to revoke a link

ADR-0013 removed `GET /api/meetings` and cross-meeting search, so three things above
describe the past. The Context's "`GET /api/meetings` lists them" and the table's
windows row, "which cross-meeting search still scans", no longer hold; an orphan windows
file on the local driver is now only an orphan. The rejected open DELETE would no longer
be a loop over a list, but it would still let any link holder destroy a shared meeting,
so it stays rejected.

Two things follow for the operator. A delete needs an id, which now comes from whoever
reports the meeting or from the Supabase table, not from the API. And this route is now
the only way to revoke a leaked link, since an id cannot be rotated. That is the same
route with the same 30-minute refusal, used for a new reason.
