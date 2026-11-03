# ADR-0019: A daily count on the demo's questions, and none while an extraction is pending

- **Status:** Accepted, and **not yet deployed**
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

**"An extraction in progress" is `extractionInProgress` in `shared/utils/meeting.ts`,** which `assess.ts` has always used: `summarizing`, `indexing`, or failed at `summarization`. The demo's own row does not count. A partial index holds only those rows, so the gate reads at most two rows of `meetings` however many there are, which `verify-migrations.sh` holds with 20,000 by Postgres's own count. The same cases run against the SQL and the local driver.

**The setting is `NUXT_DEMO_QUESTIONS_PER_DAY`, default 25.** Zero, blank, and anything but a positive whole number refuse every demo question and log it by name: a typo must never read as no cap. 25 questions is 75,000 tokens at the high estimate, which leaves extraction most of the day. To change it, use `wrangler secret put`, since `wrangler deploy` deletes a dashboard variable that `wrangler.jsonc` does not list.

**Refusals.** Status 429, with `data.retryAfterSec` and `retry-after`, as the route already sends.

| Refused because | The sentence | Try again |
| --- | --- | --- |
| Over the count | `The demo has used its questions for today.` | The next 00:00 UTC |
| Extraction pending | `The demo pauses its questions while a meeting is being processed.` | About a minute |
| The gate or take failed | The answering stage's fixed sentence, and a log line | Not said |

Both sentences go through `server/utils/public-errors.ts`, and the question form adds its own "Try again at <time>.". Nothing went wrong to cause the first two, so they are not logged.

**A failure fails closed, for the demo alone.** So does the migration not being applied yet: the call fails, and demo questions are refused. An answer the driver cannot read also counts as a failure, never as "go ahead".

## Consequences

- **A meeting that failed at extraction holds the demo's questions until someone retries or deletes it.** That is what `extractionInProgress` means, and it is deliberate that a stopped extraction counts as still wanting its slots. An invite holder's stuck meeting therefore shows up as a demo that says it is paused, with a retry about a minute away, for as long as it lasts. If the demo says so with nothing processing, this is the first place to look: find the row in Supabase, then retry or delete it.
- **One person can use all 25.** The count is across everyone, because there is no identity to count by and an IP header is not something a Worker should store for this. That costs a day of the demo's questions and nothing else, which is the trade.
- **A question that fails at the provider has still used its count,** since something was spent. A retried attempt inside one question does not take a second one.
- **A question can pass the gate just as an extraction starts,** and take one slot. A loop cannot keep doing that: the next gate refuses.
- **Refused requests are not free.** Each costs a Worker request and two Supabase calls, the meeting and the gate. Flooding is the rate rule's job, and the free plan's 100,000 requests a day is the bound.
- Two more subrequests on a demo question, out of about 11 of 50.

## What stays unproven until deployed

- Real tokens per question, so whether 25 is the right number. Read Groq's dashboard after the first days.
- The SQL and both drivers have run against a throwaway Postgres behind PostgREST and the local driver, not against Supabase. `pnpm db:migrate` has not applied this migration.
- That a real extraction and a real question loop do what the order above says on a deployed Worker, as this has run only with a staged slot ledger.

## Alternatives considered

- **Workers' rate limit binding.** The request has already run by then, its counts are per location, and it knows nothing of a day.
- **A rate rule on the route.** Sees 10 seconds at a time. Both harms here need a request a minute.
- **A separate Groq key for questions.** Limits are per account, so it would be a second account, and it would not stop the slot stall.
- **Counting before the slot.** Simpler, and burns the day's questions on refused requests.
- **Counting tokens rather than questions.** Nothing here keeps a count of tokens, and a question's bound is known.
