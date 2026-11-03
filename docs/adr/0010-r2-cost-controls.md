# ADR-0010: Bounding R2 cost when R2 itself cannot be bounded

- **Status:** Accepted, amended by [ADR-0013](0013-private-meeting-links.md), [ADR-0015](0015-invite-only-uploads.md) and [ADR-0018](0018-ffmpeg-wasm-from-private-r2.md)
- **Date:** 2026-10-23

## Context

The project targets 0 EUR/month. R2 went live on 2026-10-22, which turned that
target from an aspiration into something with a credit card behind it.

**R2 has no spending cap.** Past the free allowance Cloudflare bills rather than
refusing. The [pricing page](https://developers.cloudflare.com/r2/pricing/) and
[limits page](https://developers.cloudflare.com/r2/platform/limits/) describe no
budget, cap, or auto-suspend; the only limits documented are rate limits. The one
billing notification type, *Usage Based Billing*, requires "Professional plans or
higher" and does not list R2 among its products, so on this account the alert is
probably not even available. Community answers going back two years say the same
thing in blunter terms.

So any hard stop has to be built. What follows is what each lever can actually
do, because they are not interchangeable.

### What drives cost in this app

| | Free per month | What this app spends | Over-tier price |
| --- | --- | --- | --- |
| Storage | 10 GB-month | ~7–11 MB per meeting-hour → ~900–1,400 hours | $0.015/GB-month, **recurring** |
| Class A | 1M | ~1 per upload (the browser's presigned PUT) | $4.50/M |
| Class B | 10M | 1 per audio request (was 2 before this phase) | $0.36/M |

Storage is the dangerous one, and not because the numbers are large. It is the
only charge that **recurs**: an object bills every month for as long as it
exists. It also compounds with two findings from the 2026-09-22 audit that were
logged as hygiene and are really cost bugs — `POST /api/meetings` is anonymous,
and **there is no DELETE route anywhere in the API**. An upload loop could
therefore grow a standing monthly bill that the application has no way to
reverse.

## Decision

Three levers, each doing the one thing it is capable of.

### 1. A bucket lifecycle rule bounds how long bytes survive

`expire-meeting-audio-30d`: expire after 30 days, scoped to the `meetings/`
prefix, which is where `audioObjectKey` writes and nowhere else. Cloudflare-side,
free, and needs no code.

Its limit must be stated plainly: **it does nothing against a burst.** A script
can add hundreds of gigabytes in a day and every one of them bills for a month
before the rule touches them. It bounds slow organic growth. That is all.

Cloudflare's default 7-day multipart-abort rule is kept — interrupted uploads
would otherwise sit there billable.

**No bucket lock.** Locks are retention protection: they block deletes and
overwrites, explicitly including removal by lifecycle rules, and a bucket cannot
be emptied while one exists. For cost control they are precisely backwards.

### 2. A storage budget in the application is the actual stop

`POST /api/meetings` refuses with **507 Insufficient Storage** when the bytes
already stored plus the bytes this upload would add exceed a ceiling
(`NUXT_R2_MAX_STORED_BYTES`, default 8 GiB — under the 10 GB free line, with room
for the estimate to lag reality). Checked **before** the presigned URL is minted,
because that URL is the capability that spends the storage; handing it out and
checking afterwards would not be a limit.

Two design points worth keeping:

**The total is derived, not counted.** `public.stored_audio_bytes` sums
`audio_bytes` over the rows whose objects should still exist. A counter would
drift in two directions that cannot be repaired: the lifecycle rule deletes
objects without telling the database, and a crash between storing bytes and
incrementing loses them permanently. A derived total is self-correcting, and it
is read only when a meeting is registered, which is rare.

**Pending registrations reserve their bytes.** Counting only confirmed uploads
would let any number of concurrent registrations each see an empty store, pass
the check, and then all upload. A registration counts while its presigned PUT is
still live and stops counting once it expires, so an abandoned one cannot inflate
the total for ever and close the budget permanently.

The rule exists twice — `public.stored_audio_bytes` for Supabase,
`audioIsStored()` for the local tier — because the two tiers cannot share an
implementation. Both are asserted case-by-case against the same six cases
(`scripts/verify-migrations.sh` for the SQL,
`tests/unit/stored-audio-bytes.spec.ts` for the TypeScript), and the RPC's
reachability and bigint handling are covered in `pnpm test:services`, which is
the only place that proves PostgREST returns something the app can add to.

### 3. Per-request operation metering is deliberately NOT built

This was planned and then rejected on inspection, which is worth recording so it
is not proposed again as an oversight.

A counter row written on every audio request would cost a database round-trip per
request — more latency and more Supabase quota than the $0.36 per million it
guards. That is the same trap as the per-request `HEAD` removed in the same
phase: a check that costs more than the thing it protects. An in-memory counter
is worse than nothing on Workers, where isolates are short-lived and per-request
(ADR-0009), so it would under-count silently and give false assurance.

Bounding request volume is **rate limiting's** job, which PLAYBOOK Phase 10 owns.
ADR-0013 removed the open search endpoint this used to call the pressing case, and ADR-0015
closed registration; what is left is spending through a meeting's link, and questions on the
public demo.
Operations are also now half what they were, so the allowance is ~10M audio
requests rather than ~5M.

## Consequences

- Storage cost is bounded by construction rather than by watchfulness. The
  failure mode becomes "uploads are refused", which is visible and safe, instead
  of "the bill grows", which is neither.
- `NUXT_R2_RETENTION_DAYS` **must match the lifecycle rule**. It is how the byte
  estimate knows which uploads Cloudflare has already deleted, and nothing can
  verify the two agree from inside the app. Both are documented together in the
  README's R2 setup steps for that reason.
- Audio stops playing 30 days after upload. Transcripts, summaries and search
  live in Postgres and are unaffected, so a meeting stays readable and findable;
  only playback and re-transcription break. This was chosen explicitly.
- Registering a meeting now costs one extra aggregate read. Acceptable because
  registration happens once per meeting, unlike the per-request cost rejected
  above.
- The 0-disables-the-check path (`NUXT_R2_MAX_STORED_BYTES=0`) has no automated
  coverage; an unparseable value deliberately throws rather than silently
  removing the only limit there is.

## Follow-ups

- **A DELETE route.** The budget stops growth but nothing can reclaim space, so
  the archive's only exit is the 30-day expiry. This is now the highest-value
  gap, and it was already open from the audit.
- **Rate limiting** (Phase 9), the correct control for operation volume and the
  one thing that addresses a burst rather than slow growth.
- The ceiling is global, not per-caller. With no authentication there is no
  "caller" to meter, so one abuser can exhaust the archive for everyone — denial
  of service rather than denial of wallet. The right fix is auth plus
  per-principal quotas, which no phase owns yet.
