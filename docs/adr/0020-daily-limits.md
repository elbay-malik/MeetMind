# ADR-0020: Daily limits on every meeting's questions

- **Status:** Accepted, and **not yet deployed**
- **Date:** 2026-11-07
- **Supersedes:** Nothing whole. Amends ADR-0019 (meetings other than the demo now have a daily count of their own) and ADR-0015 (what guards the question route).

## Context

ADR-0019 put a daily count on the public demo's questions, since anyone can ask it. Every other
meeting's questions had none: its link is private (ADR-0013), held by whoever registered it and
whoever they gave it to, and only slot pacing (ADR-0012) and the providers' own limits bounded
what one link could ask. Every meeting, and extraction, draws on the same daily allowances of the
answering model and the embedding service, so the free quotas stay available to all of them only
if no one link can take what it likes of them in a day.

## Decision

**Each meeting but the demo answers at most `MEETING_QUESTIONS_PER_DAY` questions a UTC day: 100,
in `server/utils/qa/meeting-questions.ts`.** A hundred is far more than someone reading one
meeting asks in a day. It is a constant and not a setting: nothing needs it to differ between
deployments, and a setting is one more thing a typo could open. The demo keeps its own count of
25 and its pause (ADR-0019), and a question calls one of the two, never both.

**The demo's design, keyed by meeting.** The same order, for the same reasons:

```
gate (reads) → read the index → reserve the slot → take the count → embed, search, answer
```

- **The gate reads before the slot,** so a question over the count holds no slot, and before the
  index is read. It writes nothing (`stable` in SQL).
- **The count is taken only after the slot is granted,** right before anything is spent, so a
  question refused its slot uses none of the day. If the take finds the count reached in the
  meantime, it refuses too.
- **A question that fails at a provider after its take has used its count,** as on the demo.

**Storage.** `meeting_question_days` has one row per UTC day and meeting, keyed `(day,
meeting_id)`, with RLS on and grants to `service_role` alone, and the row goes with its meeting
on delete. `meeting_question_gate` and `take_meeting_question` are the only ways in. The take is
one statement, so a limit of N grants exactly N among any number at once, and it deletes every
meeting's earlier days, so the table holds no more than a day or two of the meetings asked. The
local driver keeps one file per day and meeting, and the same cases in
`tests/unit/helpers/meeting-question-cases.ts` run against it and the SQL. A UUID in capitals is
the same meeting to both.

**Refusals.** Status 429, with `data.retryAfterSec` and `retry-after`, as the route already sends.

| Refused because | The sentence | Try again |
| --- | --- | --- |
| Over the count | `This meeting has used its questions for today.` | The next 00:00 UTC |
| The gate or take failed | The answering stage's fixed sentence, and a log line | Not said |

The sentence goes through `server/utils/public-errors.ts`, and the question form adds its own
"Try again at <time>.", as for the demo's. Nothing went wrong to cause it, so it is not logged.

**A failure fails closed,** as the demo's does, and so does the migration not being applied yet:
every question on every meeting is then refused with the fixed sentence. README's deploy steps
apply the migrations before the Worker is deployed, which is the order this needs.

## Consequences

- **Whoever holds a link shares its 100.** There is no identity to count by, so one person can
  use a meeting's day. That costs that meeting's questions until 00:00 UTC, and nothing else.
- **A bound per meeting, not across them.** Someone with the invite code can register more
  meetings, and each has its own count.
- **Two more subrequests on a question,** the gate and the take, as the demo's have.
- **Under the local driver, a deleted meeting's count stays** until the next day's first take
  deletes it. No new meeting can have its id, so it is never read again.

## What stays unproven until deployed

- Whether 100 is the right number. Read Groq's dashboard after the first days, as for the demo's 25.
- The SQL and both drivers have run against a throwaway Postgres behind PostgREST and the local
  driver, not against Supabase. `pnpm db:migrate` has not applied this migration.

## Alternatives considered

- **A setting, as the demo's count is.** The demo's count is the one a stranger can reach, and the
  one worth tuning from its dashboard. This one has no such reader, and one fewer setting to get wrong.
- **One count across every meeting but the demo.** Simpler, and one meeting asked a lot would
  refuse every other meeting's questions for the day.
- **Counting the demo here as well.** It already has a count, with its own number and reasons, and
  two counts on one question would refuse it on whichever ran out first.
- **Counting before the slot.** Simpler, and a question refused its slot would use the day's count.
