# ADR-0003: Upload & storage — direct-to-R2 presigned PUT, Supabase Postgres for metadata, local drivers for dev and CI

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

After [ADR-0001](0001-client-side-audio-extraction.md)/[ADR-0002](0002-ffmpeg-spike-results.md)
the browser holds a ≤ 25 MB Opus file and the original video must never leave the
machine. Phase 3 of the playbook has to get that audio into durable storage and a
metadata row into Postgres, with secrets confined to Nitro routes, on free tiers, and
in a shape that still works when the server later runs on Cloudflare Workers (no
filesystem, per-request env). Two practical constraints shaped the design:

- The development machine and CI have **no cloud credentials**. The upload flow
  still has to be runnable and testable end to end without them.
- A presigned URL cannot cap an object's size: aws4fetch deliberately leaves
  `content-length`/`content-type` out of the signature, and R2 has no POST-policy
  equivalent (`content-length-range`). Whatever the browser PUTs within the URL's
  lifetime lands in the bucket.

## Decision

1. **Audio blobs go to Cloudflare R2 through its S3 API, uploaded directly by the
   browser to a presigned PUT URL** minted by `POST /api/meetings` with
   [aws4fetch](https://github.com/mhart/aws4fetch) (SigV4 on Web Crypto — runs
   unchanged on Node and Workers; it is Cloudflare's own recommended client).
   Path-style endpoint `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`,
   region `auto`, host-only signature, `X-Amz-Expires` = 15 minutes. The server never
   proxies audio bytes in production; it only HEADs and DELETEs objects.

2. **Three-step protocol with server-side verification.** The client registers the
   meeting (row `pending_upload`, declares the byte count), PUTs the blob, then calls
   `POST /api/meetings/:id/complete`. The server HEADs the object and accepts it only
   if its size equals the declared size (which the schema already bounds to 25 MiB);
   otherwise it deletes the object and marks the row `failed`. Completion is
   idempotent. Object keys are always `meetings/<uuid>/audio.ogg` with a server-minted
   UUID, so a client can never steer where its bytes land.

3. **Meeting metadata goes to Supabase Postgres via `@supabase/supabase-js`** with the
   service-role key, server-side only. The `meetings` table has RLS enabled and no
   policies: the service role bypasses RLS, anon/authenticated keys see nothing. The
   schema lives in `supabase/migrations/` and already lists the later pipeline statuses
   so Phases 4–9 need no status migration.

4. **Local drivers stand in when the cloud settings are absent.** `useAudioStore()`
   and `useMeetingRepository()` pick R2/Supabase when their `NUXT_*` variables are set
   and otherwise fall back to a filesystem store and a JSON-file repository under
   `NUXT_DATA_DIR` (default `.data/`, gitignored). The local store mints
   HMAC-signed, same-origin upload URLs (`PUT /api/uploads/:token`) that carry the
   key, media type, exact byte count and expiry — the same contract a presigned URL
   gives us, enforced in our own route. This is what `pnpm dev`, the vitest e2e
   suite and `scripts/drive-upload.mjs` run against.

5. **The privacy invariant is enforced, not assumed.** No route accepts video: the
   only bodies the server takes are a small JSON payload and, on the local driver, a
   PUT whose media type must be `audio/ogg` and whose length must match the grant.
   On R2 the bucket's CORS policy allows `PUT` from the app origin only, and the
   completion step deletes anything that is not the declared audio.

## Consequences

- Development, CI and the headless acceptance script run with zero credentials. The
  price is that the R2 and Supabase drivers are exercised only where those settings
  exist — **verifying them against real accounts is an open follow-up** (see below).
- Two implementations sit behind each of two small interfaces (`AudioStore`,
  `MeetingRepository`); the routes are driver-agnostic.
- Per meeting R2 costs one Class A op (the PUT) and one Class B op (the HEAD);
  deletes are free. Negligible against the 1M/10M monthly free allowances.
- Abandoned `pending_upload` rows (browser closed mid-upload) accumulate; a sweep
  belongs with rate limiting in Phase 10.
- R2 returns expired-URL errors without CORS headers, so the browser only sees an
  opaque failure. The 15-minute lifetime is generous for a < 25 MB upload; the UI shows
  a generic "storage rejected the upload" message and lets the user retry.
- The local drivers import `node:fs` lazily (dynamic `import()` of unstorage's fs
  driver) so the Cloudflare bundle never evaluates it; confirm in Phase 13.
- The upload UI now hands off to `/meetings/:id/progress`, which reads the row and
  shows the pipeline stages — the seam for Phase 4 (transcription).

## Alternatives considered

- **Supabase Storage for audio** — 1 GB total, 50 MB per file and metered egress vs
  R2's 10 GB and free egress. Rejected (playbook decision).
- **Proxying the upload through the Nitro route in production** — simpler CORS story,
  but doubles bandwidth and puts the Worker in the data path for no gain. Kept only as
  the local driver's mechanism.
- **`@aws-sdk/client-s3` + `s3-request-presigner`** — works, but hundreds of KB of
  Node-oriented code; aws4fetch is a dependency-free 10 KB and the client Cloudflare
  documents for R2 on Workers.
- **Signing `content-type`/`content-length` into the URL (`allHeaders: true`)** — a
  signed length can only pin an exact value, never a maximum, and R2's validation of
  it on presigned PUTs is undocumented. Post-upload HEAD verification is the documented
  pattern and covers both.
- **Resumable/multipart uploads (tus)** — unnecessary below 25 MB.
- **Nitro `useStorage()` mounts for the local drivers** — bakes the fs driver into
  every preset's config; explicit drivers keep the Cloudflare build clean and let tests
  redirect the data root at runtime via `NUXT_DATA_DIR`.
- **Running Supabase locally (CLI + Docker) for development** — heavy for Phase 3;
  revisit when pgvector work starts in Phase 7.

## Follow-ups

- Run the flow once against a real R2 bucket and Supabase project (set the six
  `NUXT_*` variables, apply the migration, `pnpm dev`, upload the 30 s fixture) and
  record the result here.
- Sweep stale `pending_upload` rows and their (absent) objects — Phase 10.
