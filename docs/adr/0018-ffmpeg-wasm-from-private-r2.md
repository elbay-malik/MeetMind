# ADR-0018: A Worker serves ffmpeg's wasm from the private bucket, at the same path

- **Status:** Accepted, and **deployed on 2026-11-06**
- **Date:** 2026-11-04
- **Supersedes:** Nothing whole. Settles what ADR-0009's finding 3 left open (where the wasm goes). Amends ADR-0010 (the bucket now holds one object the lifecycle rule and the budget are not about).

## Context

`ffmpeg-core.wasm` is 32,232,419 bytes, and Workers static assets stop at 25 MiB, so `wrangler` refuses the whole deploy while the file is in `.output/public`. The browser needs the file the moment someone uploads.

The bucket `meet-mind` holds every meeting's audio and raw Whisper reply, reached only through the Worker or a presigned PUT. Making it public, even for one prefix, is not something to do for a tool.

## Decision

**A route streams one hardcoded object from the private bucket, at the path the file has always had.** `server/routes/ffmpeg/ffmpeg-core.wasm.get.ts` reads `assets/ffmpeg/<version>/ffmpeg-core.wasm` through the store's `openRange` and returns a plain `Response`, so the runtime pipes the bytes and the Worker spends no CPU copying them.

- **It takes nothing from the request.** No request can make it read another object. `scripts/verify-worker-streams.mjs` asks with a query and a path naming a meeting's audio, and checks what the fake R2 was asked for.
- **Its headers are pinned, never reflected from R2:** `application/wasm`, `nosniff`, and `public, max-age=31536000, immutable`. An object's type is whatever whoever put it there said.
- **A failure is a plain sentence of ours.** A 404 if the file was never put there, a 503 if R2 fails, with none of R2's words and `no-store`. The log has the rest.
- **No Range.** The browser reads the whole file once.

**The build deletes the file, and only a Worker build.** The `nitro:build:public-assets` hook in `nuxt.config.ts` removes it when the preset starts with `cloudflare`. A `.assetsignore` alone is not enough: the path stays in Nitro's asset manifest, the Worker hands it to the assets binding, and that answers 404 with the route never run. A Node build and `pnpm dev` keep the public file, which is found before the route, so the e2e and browser jobs are unchanged.

**The version is in the key and the URL.** The browser asks for `/ffmpeg/ffmpeg-core.wasm?v=<version>`. The script glue ships with a deploy and the wasm does not, and the answer is cached as immutable, so a version that moved in one place only would serve a stale file silently. `shared/utils/ffmpeg-core.ts` has the version, `tests/unit/ffmpeg-core.spec.ts` holds it to the installed `@ffmpeg/core`, and `pnpm upload:ffmpeg-wasm` refuses a difference.

**To upgrade:** upload the new key first, then deploy, and leave the old key there so a rollback still finds its file.

**What else touches the object: nothing.** No store can list a bucket. Admin delete and the purge delete keys from a row or built from a meeting's id, all under `meetings/`. The storage budget adds up rows, so it does not count these bytes, and its 8 GiB ceiling leaves over a gigabyte under R2's free 10 GB for this and for the estimate being behind. The lifecycle rule is scoped to `meetings/`.

## Consequences

- A cost of the bucket staying private is a Worker invocation and an R2 Class B read for each browser that fetches the file. Only someone uploading needs it, which takes an invite code to get any further, but **the route itself is open**, so a loop can ask for it. That is bounded like everything else by the free plan's 100,000 requests a day, about 3 million reads a month against R2's 10 million free, and by the rate rule.
- A deploy of a new version with no upload before it answers 404 at the new key, and uploads stop working, plainly. `/ffmpeg/ffmpeg-core.js` is an ordinary asset and is deployed with the Worker.
- Each job makes a fresh ffmpeg instance, so without `immutable` every upload would download 30.7 MiB again.

## What stays unproven

On the live site since 2026-11-06, `/ffmpeg/ffmpeg-core.wasm` answers 200 with `application/wasm` (README's step 8). Nothing else here was measured there: the points below have run only under local workerd, against a fake R2, with no limit enforced. `scripts/verify-worker-streams.mjs` shows the bytes streaming before the fake R2 has finished.

- Cold-isolate CPU against the free plan's 10 ms, and whether Cloudflare counts piping 31 MB as CPU. Locally it is `ps` on a Mac, at about 0.02 s uncompressed.
- That a Worker on the free plan can stream the whole object from `*.r2.cloudflarestorage.com` without being cut off.
- Whether the edge compresses `application/wasm`, so 30.7 MiB or about 10 MiB on the wire. Local workerd gzips it when asked, which costs it about 0.4 s of CPU; at the edge that would not be the Worker's.
- That `immutable` survives and browsers reuse the file.
- That a real browser takes the file from the deployed route: the browser job runs against the Node build's public file.

## Alternatives considered

- **A public bucket, or a public prefix.** Exposes a second surface, needs a CORS rule for GET and a base URL reaching a Web Worker that has no Nuxt config, and `r2.dev` is rate limited, not for production, and uncapped by anything here. Making `meet-mind` public would expose every meeting's audio.
- **A presigned GET after the invite check.** Keeps strangers off the route, at the cost of CORS and client plumbing, for a file that is public on npm anyway.
- **Shipping it gzipped as an asset and inflating it in the browser.** About 10 MB, no Worker invocation, and it deploys atomically with its glue. A real option if the route misbehaves at the edge, at the cost of a client change and a copy step.
