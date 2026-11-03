# ADR-0017: An optional purge deletes a meeting past its retention days

- **Status:** Accepted, and **off until the user turns it on**. Nothing in this repo turns it on, `wrangler.jsonc` included.
- **Date:** 2026-11-03
- **Supersedes:** Nothing whole. Amends ADR-0013 §4 (the upload page may now promise deletion, when it is true), ADR-0011 (its delete has a second caller, which removes the objects first) and ADR-0012's step 11 (a tick with no step can do this instead). Addresses the retention half of SEC-11 in the security audit.

## Context

ADR-0013 §4 has the upload page make no promise of deletion, because the bucket's lifecycle rule expires audio and nothing removes a transcript, a summary or an index. SEC-11 asks for a scheduled purge. The cron from ADR-0012's step 11 makes that possible with no new moving part.

It is the one thing here that destroys data by itself, with nobody watching, for good. So the decision is mostly about what it must not do.

## Decision

### 1. Off unless it is told otherwise.

`NUXT_RETENTION_PURGE_DAYS` is empty in `.env.example` and `nuxt.config.ts`, and not in `wrangler.jsonc`, and a test holds all three. Empty or 0 is off. So is anything but a positive whole number up to 36,500 (`30.5`, `-1`, `30d`, `true`), and that is logged, naming the setting and not the value, since whoever set it believes it is on. Being off by mistake leaves something stored a little longer, and that is the mistake to make.

### 2. At most one meeting a tick, and only a tick with no step to take.

A tick does one thing, and a person may be waiting on a step. So a backlog of steps holds the purge back, and a backlog of expired meetings does not hold the pipeline back. That is 288 a day at most.

### 3. Through the delete there is.

`deleteMeeting` in `server/utils/meeting-deletion.ts`, with its blocker and its fence on the row, in one different order: **the audio and the raw Whisper reply go first, and then the row and what is left.** The admin route has the row go first, because its caller holds the id and is told to repeat a delete left incomplete (ADR-0011). Nobody here holds the id, the log leaves it out on purpose, and `next_expired_meeting` chooses from rows. With the row gone first, an R2 outage or an invocation killed in between would strand the most sensitive object with nothing to choose it by and nothing counting it, for as long as a lifecycle rule that nothing checks takes, or for ever with none. So a failure leaves the row, and the next tick with nothing else to do takes the same meeting again: every part can be repeated, and a key already gone is not a failure.

What this gives up: **a claim landing between the blocker's read and the fence** keeps the row, as ever, but its objects are gone by then. That is a request in a moment's gap on a meeting past its days, which a later tick then deletes anyway. A step it started finds no audio, which ends it. A meeting whose objects keep failing holds the purge at that meeting, one line a tick, with nothing lost, as an R2 refusing one object and not the next is not a case.

### 4. What it never does.

| Never | How |
| --- | --- |
| Touch the public demo | Left out by id in the SQL, which refuses to run with no id at all, and compared again before anything is read. **With `NUXT_PUBLIC_DEMO_MEETING_ID` empty, not an id, or naming no meeting, the purge does not run**, and that is logged. There is then no telling which meeting is the demo, and `wrangler deploy` removing a dashboard variable (ADR-0015) is an easy way to get there. |
| Delete a meeting a step is live on | Passed over in the selection. If a lease lands after that, `deletionBlocker` reads it, before anything is removed. If one lands after that, the delete's fence on `updated_at` keeps the row, since a claim moves that, and a later tick finishes it (decision 3). |
| Judge age by anything a client can send or the page can move | `created_at`, which only the database's default writes, against the database's own clock: not `updated_at`, which every step moves, nor `uploaded_at`. The Worker then checks the same row by its own clock, so a disagreement between the two leaves the meeting. |
| Delete another meeting by a mistake in choosing | The selection answers one id and writes nothing. That row is read again and checked before anything happens, then deleted fenced on what was read. A wrong answer from the database, tested as one, deletes nothing. `audio_key` is unique, so no two rows can name one object. |

### 5. The upload page says so only with the setting on.

`The meeting and everything stored for it are deleted about 30 days after upload.`, with the true number, beside "you cannot delete it yourself", which stays. It is on the page only with the setting usable, a well-formed demo id, and a Worker. A Node server has no cron, so with the setting on it deletes nothing and says nothing, which the e2e job holds. `useDeploymentFacts` works this out during the server's render from the private setting, and hands the page one number. "About" is honest: age counts from registering, which is moments before the upload ends, and it is deleted on a tick with nothing else to do.

### 6. A migration, which changes nothing by itself.

`20261103190000_retention_purge.sql` adds `next_expired_meeting(days, demo)`, marked `stable`, as nothing but reading. Only the service role may run it, and it is safe to run twice. It reads the existing `meetings_created_at_idx` and each run by key, one meeting at a time, and at most the 20 oldest: **11 rows with 20,000 meetings expired, each with a run**, by Postgres's own count, in `verify-migrations.sh`. That count is why it is a loop: as one `NOT EXISTS`, Postgres read every run once per call to hash them.

## What it costs

A tick that deletes spends 17 subrequests, and 22 if a meeting it chose first turned out to have no step: a named test. Against 50. `aws4fetch` retrying R2 on a 5xx can add 4. It claims nothing and asks no provider.

## What was checked, and where

Checked on 2026-11-03, on this machine, and on nothing real.

| Where | How | What it showed |
| --- | --- | --- |
| A Worker build under local workerd | `scripts/verify-worker-sweep.mjs`, against real SQL on a throwaway Postgres and a fake bucket | Off: nothing deleted at 400 days, no promise on the page. At 30 days: a bucket answering 500 leaving the oldest meeting's row, and the next tick finishing it, the oldest meeting gone from every table and the bucket, the next untouched until the next tick, a meeting inside its days, the demo at 400 days and one with a live lease all left, the last gone once its lease ended, the page saying 30. Set wrongly, or with a mistyped demo: nothing deleted, one line saying why, with no value |
| The real Supabase driver over real SQL | `pnpm test:postgrest`, in `pnpm ci:local` | The same questions of the selection as the local driver |
| A plain Postgres | `verify-migrations.sh`, in `pnpm ci:local` | Age, the demo, leases, refusals, who may run it, how much it reads, running it twice |
| Local drivers | `tests/unit/purge.spec.ts` | Everything in decision 4, including a database that answers wrongly, and a claim landing mid-delete. An object that cannot be removed, and an invocation killed before the row, each finished on the next tick |
| A Node build with the setting on | `tests/e2e/retention-notice.spec.ts` | No promise, and nothing deleted |

## What stays unproven until Phase 13

- **Everything about it on a deployed Worker,** as for the sweeper: ADR-0012's step 11 addendum has that list. It has never deleted anything real.
- **A real R2 delete of a real object from a tick,** which uses the same driver as the admin route, itself not yet run from a Worker.
- **That the setting reaches a scheduled invocation through `wrangler secret put`,** as `.dev.vars` did.

**Before turning it on,** look at what it would take, since the first days delete everything older, at 288 a day, for good:

```sql
select id, title, status, created_at from meetings where created_at < now() - interval '30 days' order by created_at;
```

## Consequences

Honest limits, all accepted:

- **It is not an erasure process.** It does not answer a person who asks to be removed, which is the other half of SEC-11. That is still an operator with `NUXT_ADMIN_TOKEN` (ADR-0011).
- **A deployment with no demo cannot use it.** Decision 4 has no way to tell a missing demo from a removed variable. **Reverse this if a deployment ever runs without a demo:** it would take a stored flag on the demo's row rather than a setting.
- **A demo id naming another real meeting leaves the real demo to expire.** Nothing can tell. Its home page link would show the wrong meeting, which is how it is noticed. The page's promise also stands while a mistyped id keeps the purge off, because telling takes a read on every home page visit (ADR-0013 §5 declined the same read), and that link opens a 404. The log says so once per isolate.
- **A purge migration not applied** deletes nothing as well, and the page's promise stands for the same reason. `next_expired_meeting` fails on each tick with nothing else to do, and the log says only `sweep failed: Error`, since a failure's message is not logged. So after turning it on, look at the first meeting past its days, or at that line.
- **A meeting still unfinished past its days is finished first,** spending provider quota, since a step goes before the purge, and is deleted after. At 30 days a meeting that unfinished is rare, and leaving out what will be deleted is one more rule in the selection.
- **The link just stops working,** with a 404 and nothing saying why. The browser's "Your meetings" still lists it, as with any meeting an operator has deleted (ADR-0013).
- **`NUXT_R2_RETENTION_DAYS` and this are separate.** The bucket's rule can take the audio first, as it already does, and then the page's promise is about the rest. Set shorter than that rule, this removes audio early, and the byte estimate is right either way, since it is counted from rows.
- **It does not tell anyone it deleted anything,** apart from one line with no id. There is no audit trail of what went, on purpose: the point is that it is gone.

## Alternatives considered

- **Delete by SQL in the database, `pg_cron` or a function.** It could not remove the R2 object, and the bucket's bytes are what cost money.
- **Purge beside the step in every tick.** Up to 40 subrequests in one tick, and a little more CPU in the one invocation nobody can measure yet.
- **Purge before the step.** A backlog of 300 expired meetings the day this is turned on would stop the pipeline's unattended work for a day.
- **Age from `uploaded_at`.** Closer to what the sentence says, but null on a row whose upload never finished, which is the first thing a purge should remove, and written by the server rather than the database.
