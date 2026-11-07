# ADR-0019: A daily count on the demo's questions, and none while an extraction is pending

- **Status:** Accepted, **deployed on 2026-11-06**, and in force since 2026-11-07, when the demo's id was set
- **Date:** 2026-11-04
- **Supersedes:** Nothing whole. Amends ADR-0015 (questions on the demo stay open, within a count) and ADR-0012 (what a question does around its slot). Addresses SEC-04 and the demo's side of SEC-05 in the security audit.

## Context

The demo's id is on the home page, and asking it a question is the one thing a stranger may spend. Two things follow from that, and a rate rule fixes neither, because each needs only about one request a minute:

- **Groq's 200,000 tokens a day.** A question is estimated at 1,500 to 3,000 tokens, not measured, with a hard bound of 8,000 (`groq-token-budget.spec.ts`). At the pace slots allow, that is gone in one or two hours, and a block lands on every extraction and every other question for the rest of the day.
- **Extraction's slots.** A question may claim a slot up to 20 seconds ahead, and extraction waits 0 ms for one. One well-timed request a minute keeps `next_available_at` in the future, and extraction never gets a slot for as long as the loop runs.

## Decision

**On the public demo only, `POST .../ask` is refused over a daily count, and while any other meeting's extraction is in progress.** Other meetings' questions are unchanged, and never call any of this.

**The order matters both ways.**

```
gate (reads) → read the index → reserve the slot → take the count → embed, search, answer
```

- **The gate runs before the slot,** because reserving a slot is itself what stalls extraction. It reads, and writes nothing (`stable` in SQL, so a read-only transaction may run it). It also runs before the index is read, which saves hashing the whole transcript on every refused request.
- **The count is taken only after the slot is granted,** right before anything is spent. Otherwise a loop that is refused its slot, which is almost every request of a loop, would burn the day's questions for everyone. If the take finds the count has been reached in the meantime, it refuses too, and that one slot goes unused.

**Storage.** `demo_question_days` has one row per UTC day, with RLS on and grants to `service_role` alone. `demo_question_gate` and `take_demo_question` are the only ways in. The take is one statement, so a limit of N grants exactly N among any number at once, and it deletes earlier days, so the table never holds more than a day or two.

**"An extraction in progress" is `pausesDemoQuestions` in `shared/utils/meeting.ts`:** `summarizing` or `indexing` for as long as a meeting is, and failed at `summarization` for an hour after its row last changed (`FAILED_EXTRACTION_PAUSE_MS`). The three states are `extractionInProgress`, which `assess.ts` has always used, and the hour was added on 2026-11-07 (see Consequences). The demo's own row does not count. Two partial indexes hold only those rows, one on the two states in progress and one on the failed rows by `updated_at`, so the gate reads at most two rows of `meetings` however many there are, and none of the failures older than the hour. `verify-migrations.sh` holds both with 20,000 rows by Postgres's own count. The same cases run against the SQL and the local driver.

**The setting is `NUXT_DEMO_QUESTIONS_PER_DAY`, default 25.** Zero, blank, and anything but a positive whole number refuse every demo question and log it by name: a typo must never read as no cap. 25 questions is 75,000 tokens at the high estimate, which leaves extraction most of the day. To change it, use `wrangler secret put`, since `wrangler deploy` deletes a dashboard variable that `wrangler.jsonc` does not list.

**Refusals.** Status 429, with `data.retryAfterSec` and `retry-after`, as the route already sends.

| Refused because | The sentence | Try again |
| --- | --- | --- |
| Over the count | `The demo has used its questions for today.` | The next 00:00 UTC |
| Extraction pending | `The demo pauses its questions while a meeting is being processed.` | About a minute |
| The gate or take failed | The answering stage's fixed sentence, and a log line | Not said |

Both sentences go through `server/utils/public-errors.ts`, and the question form adds its own "Try again at <time>.". Nothing went wrong to cause the first two, so they are not logged.

**Before any of this, the route takes only JSON from its own site,** on every meeting. A body declared as anything but `application/json` is a 415, and a request the browser marks `Sec-Fetch-Site: cross-site` is a 403, both from the headers before the body is read, so neither reaches the gate, a slot or the count. A page on another origin can make a browser send a form or plain text without asking, but JSON only after a CORS preflight, which this app never grants. A client that sends no `Sec-Fetch-Site`, such as curl, is judged by its type alone.

**A failure fails closed, for the demo alone.** So does the migration not being applied yet: the call fails, and demo questions are refused. An answer the driver cannot read also counts as a failure, never as "go ahead".

## Consequences

- **A meeting that failed at extraction holds the demo's questions for an hour after its last change, with nothing logged.** A failed row may never ask for a slot again, and nothing moves it by itself: a tick retries no failed stage, and the retention purge is off by default. An ordinary outage gets a meeting there, if a chunk fails twice or takes three 429s in a row, and Groq's daily limit does that too. Only an invite holder can upload one. The demo then says it is paused, with a retry about a minute away, until the hour is over, and the only sign is asking it.
  - Until 2026-11-07 the hold had no end: the demo stayed paused, for days if nobody acted, until someone retried the meeting and the retry got through, or deleted it with the admin token. The bound is `FAILED_EXTRACTION_PAUSE_MS`, in the gate's SQL as `interval '1 hour'`, and the shared cases hold the two to the same minute on either side.
  - A retry moves the row to `summarizing`, which pauses the demo for as long as it runs, and a retry that fails again starts a new hour. So the bound ends a pause only for a failure nobody is acting on.
  - A row refused as too long (`This transcript would need N sequential requests`, `refusedAsTooLong`) cannot be retried, as planning it again refuses it again. It holds the demo for its hour like any other failure, where before only the admin delete ended that pause.
  - A meeting in `summarizing` or `indexing` pauses the demo for as long as it stays there, however long ago its row last moved, as before. Those are the states in which it does take slots.
  - An hour is well past the minute a failed extraction waits before it may be retried (`RETRY_COOLDOWN_MS`), so whoever saw it fail and presses retry is still inside it, and a failure nobody looks at costs the demo an hour rather than days.
  - If the demo says it is paused with nothing processing, this is the first place to look: `select id, status, failed_stage, error_message, updated_at from meetings where status in ('summarizing', 'indexing') or (status = 'failed' and failed_stage = 'summarization' and updated_at > now() - interval '1 hour');`
- **One person can use all 25.** The count is across everyone, because there is no identity to count by and an IP header is not something a Worker should store for this. That costs a day of the demo's questions and nothing else, which is the trade.
- **A question that fails at the provider has still used its count,** since something was spent. A retried attempt inside one question does not take a second one.
- **A question can pass the gate just as an extraction starts,** and take one slot. A loop cannot keep doing that: the next gate refuses.
- **Refused requests are not free.** Each costs a Worker request and two Supabase calls, the meeting and the gate. Flooding is the rate rule's job, and the free plan's 100,000 requests a day is the bound.
- **A rollback can drop the cap.** Secrets belong to a version, so rolling back past `wrangler secret put NUXT_PUBLIC_DEMO_MEETING_ID` leaves a version with no demo id, and so no count, no pause and no read-only guard. README's rollback steps say to name a version created after it. This comes from wrangler's code and Cloudflare's docs, and has not been run.
- Two more subrequests on a demo question, out of about 11 of 50.

## What stays unproven

- Real tokens per question, so whether 25 is the right number. Read Groq's dashboard after the first days.
- The SQL and both drivers have run against a throwaway Postgres behind PostgREST and the local driver. `pnpm db:migrate` applied this migration to Supabase before the deploy (README's step 2), and no check in `pnpm test:services` calls the gate or the take there.
- That a real extraction and a real question loop do what the order above says on a deployed Worker, as this has run only with a staged slot ledger.
- That the rate rule and `run_worker_first` hold one address to about 86,000 requests a day at the edge. Nothing under `/_nuxt/` ran the Worker under local `wrangler dev`, and an encoded `/%5Fnuxt/` path does run the Worker there. Since 2026-11-07 the live rule's expression reads the path both as sent and after normalisation, and on the live site `/`, `/%5Fnuxt/x` and a path with dot segments answered 429 after 10 requests (README's steps 7 and 8). That the whole day stays under the allowance is the arithmetic of that rate, not something measured.

## Alternatives considered

- **Workers' rate limit binding.** The request has already run by then, its counts are per location, and it knows nothing of a day.
- **A rate rule on the route.** Sees 10 seconds at a time. Both harms here need a request a minute.
- **A separate Groq key for questions.** Limits are per account, so it would be a second account, and it would not stop the slot stall.
- **Counting before the slot.** Simpler, and burns the day's questions on refused requests.
- **Counting tokens rather than questions.** Nothing here keeps a count of tokens, and a question's bound is known.
- **Leaving failed rows out of the pause altogether.** A retry is not refused by the pause, but a failure is most often followed by one within minutes, and the hour keeps the demo from taking a slot in the minute between.
- **A failed row holding the demo until someone acts, as first decided.** The decided meaning, and it let one ordinary failure pause the demo for days with no sign but asking it.
