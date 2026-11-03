# ADR-0009: What Workers actually does with this app — a measurement spike before Phase 9

- **Status:** In progress (credential-free half measured; the rest blocked on a Cloudflare token). Finding 3's open question is settled by [ADR-0018](0018-ffmpeg-wasm-from-private-r2.md)
- **Date:** 2026-10-22

## Context

Phases 0–8 are built. Phase 9 (orchestration) is the playbook's next phase and
the named home for five deferred items: the distributed Groq pacer and
resumable per-chunk retry (ADR-0006), cross-clock-hour scheduling (ADR-0004),
the `indexing` status rename (ADR-0007 decision 6), and the index-completeness
marker (ADR-0008's addendum). Every one of those is **coordination state**, and
where coordination state can live is a property of the runtime.

Today all three answers are in-process: a module-level pacer
(`server/utils/summary/index.ts`), an `inFlight` map
(`server/api/meetings/[id]/search-index.post.ts`), and a `setTimeout` sleep
inside `createRequestPacer`. If those are per-isolate on Workers, Phase 9 needs
a durable primitive — a Durable Object, Workflows, or Postgres rows — and
picking it *after* building the orchestrator means building it twice.

So: measure the runtime before designing against it. Every deployment finding
in the 2026-09-22 audit was an inference from documentation. This ADR replaces
inferences with numbers, and is explicit about which numbers are still missing.

Nothing here is deployed. `wrangler dev` runs the real `workerd` runtime
locally and needs no account, which is why the first half cost an afternoon
rather than four signups.

## What was measured, with no credentials

### 1. It builds, and the bundle is nowhere near any limit

`NITRO_PRESET=cloudflare_module pnpm build` exits 0. Server bundle **1.9 MB
on disk, 1.69 MB reported, 495 kB gzipped**.

The audit worried this would not fit "the free plan's 3 MiB gzipped cap". That
cap no longer exists: Cloudflare
[removed the compressed-size limits on 2026-09-04](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/)
in favour of 64 MiB uncompressed on both plans. The bundle uses roughly 3% of
it. **Closed, not a concern.**

### 2. `nodejs_compat` is required, and sufficient for `node:path`

The build warns `[cloudflare] Node.js compatibility is not enabled.` without
the flag. ADR-0008's follow-up flagged the eager `node:path` import in all five
`*-local.ts` drivers as an unverified Workers risk.

With `compatibility_flags: ["nodejs_compat"]` (see `wrangler.jsonc`, dated past
the 2024-09-23 v2 cutoff) the whole server bundle loads and serves under
`workerd`. **`node:path` is a non-issue.** The dangerous neighbour was never
`node:path`.

### 3. The 30.7 MiB wasm is a hard stop, confirmed by the tooling

```
✘ [ERROR] Asset too large.
  Cloudflare Workers supports assets with sizes of up to 25 MiB. We found a file
  .output/public/ffmpeg/ffmpeg-core.wasm with a size of 30.7 MiB.
```

Two things worth knowing beyond "it is over the cap":

- **It fails at `wrangler dev`, before any upload.** This is not a deploy-time
  surprise; it is a local hard stop, discoverable and iterable for free.
- **The cap is identical on Free and Paid.** It is a platform limit, not a plan
  lever, so paying does not move it.

*[ADR-0018](0018-ffmpeg-wasm-from-private-r2.md) settled this: a route serves it from the private
bucket at the same path. With the wasm gone from a Worker build, this hard stop is gone too, so
`wrangler dev` at the repo root now reads the real `.env`: never run it there.*

Excluding `ffmpeg/` from the assets directory makes everything else run. That
is a probe, not the fix: `.output` is generated, so the exclusion has to come
from the build, and the file still has to reach the browser from somewhere.
Options, unresolved: serve it from the R2 bucket already in the stack (needs a
configurable base URL — `app/workers/ffmpeg.worker.ts` hardcodes
`self.location.origin`, and `nuxt.config.ts` exposes no public runtime config —
plus bucket CORS); ship it gzipped at 9.7 MiB and inflate client-side; build a
minimal core with only demux + audio decode + Opus encode + resample; or drop
wasm for WebCodecs.

### 4. The local/stub drivers do NOT work on Workers — and this corrects the audit

Every data route returns 500 under `workerd`:

```
H3Error: [unenv] fs.mkdir is not implemented yet!
H3Error: [unenv] fs.readdir is not implemented yet!
```

`unenv` stubs `node:fs` with throw-on-call implementations, so
`unstorage/drivers/fs` cannot work. SSR is unaffected — `/` and `/meetings`
both render 200.

**This inverts the audit's A6 finding.** That finding said a Worker deployed
with no secrets bound would silently serve fabricated stub transcripts at
HTTP 200, with only a `console.info` to betray it, and called it the worst
operational hazard in the system. The opposite is true: a credential-less
Workers deploy **fails loudly on every data route**. The silent-fake-content
hazard does not exist on this runtime.

Two consequences:

- The stub tier is a **local-development** tier, not a deployment configuration.
  There is no "deploy it and see" without real credentials.
- `/api/health` returning `ok` unconditionally is still wrong, but it is much
  less dangerous than reported — the app cannot pretend to work, it just breaks.
  (And note the health endpoint must keep returning 200 for liveness:
  `.github/workflows/ci.yml` uses `curl -sf /api/health` as the browser job's
  boot probe, so a readiness-based 503 there would hang that job.)

## What is NOT measured, and why

The two numbers that actually decide Phase 9's primitive:

- **CPU milliseconds per route against the free plan's 10ms.** The expensive
  paths are `attestQuote` scanning the transcript once per citation
  (`server/utils/summary/reconcile.ts`), the up-to-25 MB `FormData` built in
  `server/utils/transcription/groq.ts`, and cross-meeting search parsing up to
  100 passages of PostgREST JSON.
- **Subrequests per invocation against the cap of 50.** `summarize` plausibly
  approaches it: up to two Groq calls per chunk across ~7 chunks, plus three
  `repo.claim()` round-trips, plus `replaceForMeeting`'s writes.

Neither is obtainable from the stub path, for the reason in finding 4: those
routes do not execute at all under `workerd` without real drivers, and with
stubs there are no outbound fetches to count. **Both need a Cloudflare token
and real service credentials.** This is the honest limit of the free half of
the spike, and it is worth stating plainly rather than substituting a local
Node measurement that would not reflect the runtime.

Note also that the 50-subrequest cap is a hard per-invocation limit that
**streaming does not defeat**, which is a stronger argument for Phase 9's
queue than the ~100s figure the audit leaned on — that one is a proxy
time-to-first-byte timeout, not a handler wall-clock cap, and an SSE response
that flushes headers early sidesteps it without any queue.

## Decision

Treat Phase 13's infrastructure as a spike that precedes Phase 9, not as a
phase that follows it. Committed here: `wrangler.jsonc`, `wrangler` as a
devDependency, `workerd` approved in `pnpm-workspace.yaml`'s `allowBuilds`
(its postinstall links the runtime binary), and the Cloudflare control-plane
variables documented in `.env.example`.

Not committed, deliberately: no Nitro preset in `nuxt.config.ts`. Switching
the default preset would repoint `.output` and break `pnpm test:e2e`,
`pnpm ci:local` and the browser CI job, all of which run
`node .output/server/index.mjs`. The Workers build stays an explicit
`NITRO_PRESET=cloudflare_module` invocation until there is a deployment that
needs it.

## Follow-ups

- Measure the two numbers above once a token exists; record them here.
- Decide how `ffmpeg-core.wasm` reaches the browser (finding 3) — required
  before any deploy, since nothing works without it.
- Make the assets exclusion come from the build rather than a hand-written
  `.output/public/.assetsignore`.
- ~~`pnpm test:services` has never run~~ — it has now, see below. It still has
  no CI job, and finding 4 means real credentials are a prerequisite for *any*
  Workers deploy, so it stops being optional.

## Addendum, 2026-10-22: the schema is live and the service contracts hold

The Supabase project exists and all eight migrations are applied, so two of
this ADR's own blockers are gone and `pnpm test:services` has run for the
first time in the project's history: **10 passed, 6 skipped**.

What that actually covered:

| Group | Result | Note |
| --- | --- | --- |
| Supabase Postgres | 5 passed | row shape against `meetingSchema`, the `updated_at` trigger, the audio cap enforced in the database, segment ordering, cascade delete |
| Groq Whisper | 2 passed | the response envelope really has the shape the parser assumes |
| Gemini embeddings | 3 passed | `outputDimensionality` honoured at 768 rather than the 3,072 default, vectors unit-length, a question ranked nearer the passage that answers it |
| R2 | 6 skipped | the four `NUXT_R2_*` variables are not set |

Two things worth recording beyond the pass count.

The migrations were applied by a new `pnpm db:migrate`
(`scripts/apply-migrations.sh`), not by the Supabase CLI, which is not
installed here. It keeps a ledger in its own `meetmind_migrations` schema, so a
re-run is a no-op and an edit to an already-applied file is refused outright. It
also fails with a named error for the three ways the connection string goes
wrong, each of which Postgres otherwise mislabels: the dashboard's literal
`[YOUR-PASSWORD]` placeholder (which surfaces as `password authentication
failed`), the Direct connection (IPv6-only on new projects, unroutable from
Docker's bridge), and the Transaction pooler on 6543 (which cannot run DDL).
All three were hit in practice before the script existed.

Gemini's three checks had been running and passing while the runner's own
banner omitted Gemini from its detected-credentials list. Nothing was broken,
but "10 passed, 6 skipped" does not distinguish a group skipped for want of a
key from one that quietly stopped existing, so the banner now names the skipped
groups too. That is the only defence this suite has against a false green,
since it has no CI job to notice a group disappearing.

Still open from this ADR: the two Workers numbers (CPU per route, subrequests
per invocation) remain unmeasured — the credentials now exist, but R2 does not,
and finding 4 means the data routes need every driver real before they execute
under `workerd` at all.
