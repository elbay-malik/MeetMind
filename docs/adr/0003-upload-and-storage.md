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
- A presigned URL cannot cap an object's size with a range: R2 has no POST-policy
  equivalent (`content-length-range`). It can only pin an exact length and media
  type, by signing those headers, which aws4fetch leaves out unless asked.

## Decision

1. **Audio blobs go to Cloudflare R2 through its S3 API, uploaded directly by the
   browser to a time-limited presigned PUT URL** minted by `POST /api/meetings` with
   [aws4fetch](https://github.com/mhart/aws4fetch) (SigV4 on Web Crypto — runs
   unchanged on Node and Workers; it is Cloudflare's own recommended client).
   Path-style endpoint `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`,
   region `auto`, `X-Amz-Expires` = 5 minutes. The signature covers `content-length`,
   `content-type` and `host`, so R2 refuses a PUT whose length is not the byte count
   the meeting registered or whose type is not `audio/ogg`. The browser sets the type
   from the headers it is handed and the length from the Blob it sends, whose size is
   the byte count it registered. The server never
   proxies audio bytes in production; it only HEADs and DELETEs objects.

2. **Three-step protocol with server-side verification.** The client registers the
   meeting (row `pending_upload`, declares the byte count), PUTs the blob, then calls
   `POST /api/meetings/:id/complete`. The URL is time-limited, not single-use: like any
   presigned URL it can be replayed until it expires, so the object can still be
   replaced within that window, including after verification. Overwriting only ever
   affects the uploader's own meeting, only with bytes of the same length and type,
   and the 5-minute lifetime bounds it. R2 checks the expiry when a PUT starts, so a
   large upload on a slow link only has to begin inside it. The server HEADs the object and accepts it only
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

5. **The privacy invariant is structural, and checked as far as it can be.** No
   server route ever receives video: the only bodies the server takes are a small JSON
   payload and, on the local driver, a PUT whose media type must be `audio/ogg` and
   whose length must match the grant. On R2 the browser uploads to the bucket directly,
   under a signature that pins the same length and media type, and the completion step
   still verifies the object's size and reported media type and deletes anything that
   fails. What it does **not** do is inspect the bytes: a client that
   deliberately sent video labelled `audio/ogg` at exactly the declared length would
   pass. That is a self-inflicted leak by the uploader rather than something the product
   does behind the user's back, and transcoding would be the only real defence.

## Consequences

- Development, CI and the headless acceptance script run with zero credentials. The
  price is that the R2 and Supabase drivers are exercised only where those settings
  exist — **verifying them against real accounts is an open follow-up** (see below).
  Pointing `NUXT_SUPABASE_URL` at a dead endpoint does confirm driver *selection* and
  the failure path (a clear server-side message, a generic 500 to the client that
  leaks no endpoint), but says nothing about query correctness.
- Two implementations sit behind each of two small interfaces (`AudioStore`,
  `MeetingRepository`); the routes are driver-agnostic.
- Per meeting R2 costs one Class A op (the PUT) and one Class B op (the HEAD);
  deletes are free. Negligible against the 1M/10M monthly free allowances.
- Abandoned `pending_upload` rows (browser closed mid-upload) accumulate; a sweep
  belongs with rate limiting in Phase 10.
- R2 returns expired-URL errors without CORS headers, so the browser cannot read the
  status and the request surfaces as a network failure rather than an HTTP error. The
  UI reports "Network error while uploading audio" and lets the user retry. The
  browser starts the PUT as soon as registration answers, and only the start has to
  fall inside the 5-minute lifetime, so this should be rare.
- The local drivers import `node:fs` lazily (dynamic `import()` of unstorage's fs
  driver) so the Cloudflare bundle never evaluates it; confirm in Phase 13.
- A half-configured service is rejected at request time rather than falling back to the
  local drivers, so a deployment missing one of the four R2 settings fails loudly
  instead of quietly writing audio to a container filesystem.
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
- **A host-only signature, with size and type checked only after the upload** — what
  this ADR first chose, because a signed length pins an exact value rather than a
  maximum and R2's handling of it on presigned PUTs is not documented. But the exact
  value is known before the URL is minted, as the byte count the meeting registers, so
  pinning it costs nothing, and the URL then cannot store anything but bytes of that
  length and type while it lives. The post-upload HEAD stays, so the check does not
  rest on R2 honouring the signature, and `pnpm test:services` checks that it does.
- **Resumable/multipart uploads (tus)** — unnecessary below 25 MB.
- **Nitro `useStorage()` mounts for the local drivers** — bakes the fs driver into
  every preset's config; explicit drivers keep the Cloudflare build clean and let tests
  redirect the data root at runtime via `NUXT_DATA_DIR`.
- **Running Supabase locally (CLI + Docker) for development** — heavy for Phase 3;
  revisit when pgvector work starts in Phase 7.

## Follow-ups

- Run the flow once against a real R2 bucket and Supabase project (set the six
  `NUXT_*` variables, apply the migration, `pnpm dev`, upload the 30 s fixture) and
  record the result here. `pnpm test:services` now checks the driver-level contracts
  automatically, including the CORS rule that only fails inside a browser.
- Sweep stale `pending_upload` rows and their (absent) objects — Phase 10.
