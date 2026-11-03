# ADR-0016: A deployment runs on the real services or not at all

- **Status:** Accepted
- **Date:** 2026-11-03
- **Supersedes:** Nothing whole. Amends ADR-0015 (`POST /api/invite-check` also says when this server could not take the upload). Closes SEC-16 of the security audit.

## Context

Half a group of settings used to throw, and a whole group absent selected a stub or a local
store with one `console.info`. ADR-0009 found that a Worker with nothing set fails loudly,
because the local stores have no filesystem. That left the case that does harm: a real database,
real audio, and one provider's key missing.

ADR-0012's steps 8 and 9 made that case worse. With the Workers AI settings missing, the stub
embedder counts as another model, so one `POST .../search-index` overwrites up to 16 real windows
and stops questions. With Groq missing, `POST .../advance` stores a fake transcript that is never
replaced. Step 10 will call `/advance` by itself when a page opens.

## Decision

### 1. Stand-ins need an opt-in, on a server that is not a Worker.

`server/utils/drivers.ts` is the one place this is decided. The settings it requires are
`NUXT_GROQ_API_KEY`, `NUXT_WORKERS_AI_ACCOUNT_ID`, `NUXT_WORKERS_AI_API_TOKEN`, `NUXT_SUPABASE_URL`,
`NUXT_SUPABASE_SERVICE_KEY`, `NUXT_R2_ACCOUNT_ID`, `NUXT_R2_ACCESS_KEY_ID`,
`NUXT_R2_SECRET_ACCESS_KEY` and `NUXT_R2_BUCKET`. With all nine present, it selects the real
services and asks for nothing else.

With any missing, a built server refuses unless `NUXT_ALLOW_LOCAL_DRIVERS` is exactly `true`.
A value of `1` or `yes` opens nothing. `pnpm dev` needs no flag, because `import.meta.dev` is
a build constant that nothing set on a built server can change. It is not keyed on `NODE_ENV`, since
the e2e and browser jobs run a real production build on local drivers. Those harnesses set the
opt-in themselves and blank all nine settings, in case a shell exported them.

### 2. A Worker ignores the opt-in.

The opt-in is not read on a Worker, so a stray variable cannot turn stubs on. A Worker is known by
any one of three signals, none of which a variable or a request can set: `import.meta.preset` (a
build constant, `cloudflare-module` here), `event.context.cloudflare` (what Nitro's Cloudflare
handler gives each request) and `navigator.userAgent` being `Cloudflare-Workers`.

This is decided per request, and not at startup as the audit proposed, because a Worker has
no startup with its settings available.

### 3. A real database or bucket means everything is real, opt-in or not.

This is the rule that stops the hazard itself, and it holds under `pnpm dev` too: a developer with
a real database and a missing key who clicks index is refused. Half of any group is refused the
same way, rather than throwing a different error.

The two stores also go together, which goes further than the audit asked. A real bucket on a local
database would write objects that the real database has no rows for, and the storage budget
counts rows (ADR-0010), so R2's only spending limit would not see them.

**A local database with real provider keys is allowed.** The hazard is a stand-in's output stored
for good, and real output in a throwaway store has no such consequence. It spends quota, which is
what whoever set the key asked for, and it is how a provider gets tried without touching real data.
A developer's `.env` holds every real key, so `pnpm dev` there runs entirely on the real services, as
it did. So does `pnpm preview`, because `nuxt preview` loads `.env` into the server it starts. The test
tiers do not see that file: the Nuxt test config loads `.env.test`, `node .output/server/index.mjs` reads
no dotenv file and none of them runs preview, and `nuxt build` bakes none of the values into its output,
which was checked by searching the output of both presets for them.

### 4. The refusal comes before anything happens, and says nothing.

Every driver is built through `selectDriver`, which reads only the runtime config, so the first
selection a route makes refuses before any claim, slot, provider call or write. That includes the
read routes: one rule, with nothing to reason about per route. Each answers 503 with
`MeetMind is not available at the moment. Try again later.`

The names of what is missing go to the log once for each process or isolate, never a value.
`withoutInternals` lets this one error through, or the pipeline routes would turn it into a 500 and
log it per request. `POST /api/invite-check` and `POST /api/meetings` ask right after the invite
code, so a wrong code hears only that it is wrong, and a right one hears before minutes of extraction
rather than after. ADR-0015's guards, and the admin route's, come first and are unchanged. Meeting pages
show Nuxt's error page with `503` and "Could not load meeting". `/api/health` stays 200, which ADR-0009
requires of it.

### 5. The stub flags do nothing without it.

The five `NUXT_*` stub flags and the local stores' settings are read only inside `selectDriver`'s
`local` branch. A test hands the real path a config that throws when any of them is read.

### 6. A new provider has to say what it is.

`source-hygiene.spec.ts` fails if a stub, local driver or real driver is built anywhere but the
matching branch of `selectDriver`, or is renamed, re-exported or imported in a way that would hide it
from that check. It goes by what the source does, and it knows a driver by its name, so the names are
a rule this decision relies on: a stand-in is `createStub*` or `createLocal*`, in a module named
`stub*`, `local` or `*-local`, and a real driver is `create<Provider>*`, for a provider on that test's list.
A `create*` function under `server/` that fits neither fails the test until it is added or has a
written reason why it is not a driver, so `createFakeReranker` or `createCohereReranker` cannot pass unseen.

`driver-gate.spec.ts` (unit) finds every `use*` exported under `server/`, so a selector is covered
without being named, in a new module too. Each one has to refuse in every refused case, and with all
nine settings present it has to hold no driver whose `kind` is `stub` or `local`. The same spec fails on a
key in `runtimeConfig` that is neither required nor explained. `driver-gate.spec.ts` (e2e) fails on a route
under `server/api` that is missing from its table.

These read source and walk exports. They do not prove anything about code that avoids both rules:
a factory not called `create*`, used on a route that a gated selector has already let through, with no
`kind` to look at, gets past all of them and is left to review.

## NUXT_UPLOAD_TOKEN_SECRET and NUXT_ADMIN_TOKEN

Neither is required. Only the local store reads the upload secret, so R2 never reaches the random
per-process fallback, and a deployment has no local store. Without an admin token the admin
routes answer 404, and a short one is refused, as ADR-0011 has it. `NUXT_INVITE_CODE` closes uploads
by itself (ADR-0015), and a server can be read without one, so it is not required either.

## What was checked, and where

Checked on 2026-11-03, on this machine.

| Where | How | What it showed |
| --- | --- | --- |
| A production Node build | `tests/e2e/driver-gate.spec.ts`, against a fake database that counts requests | With each group absent in turn, opt-in or not: every route answers the one 503, the fake gets no requests and the data directory stays empty. With all nine: the same routes reach the fake |
| `nuxt dev` | By hand, with no `.env` loaded | With nothing set, or only Groq: stand-ins. With Supabase alone, or half of R2: 503 |
| Local `workerd`, through `wrangler dev` | `scripts/verify-worker-gate.mjs` | With the opt-in and every flag: the one 503 on every route, reaching no local driver. With all nine and no opt-in: routes reach the fake, read from `.dev.vars` through `useRuntimeConfig(event)` |
| The same, with signals removed from the bundle | By hand | Any one of the three signals alone still refuses. With all three removed, stubs and local stores are selected, so the check can fail |

`pnpm test:services`' Workers AI group builds its driver directly, so it says nothing about this
gate, only that the driver still works.

## What stays unproven until Phase 13

No deployed Worker has run any of this. Everything above ran on this machine, against fake services.

- That values from `wrangler secret put` reach `useRuntimeConfig(event)` as `.dev.vars` did.
- That all three signals hold on a deployed Worker. Local `workerd` shows them there, and the first
  depends on the deployed build having been made with `NITRO_PRESET=cloudflare_module`.
- How often the log line appears. It is once per isolate, and how many isolates there will be is
  not known, nor is it certain how the line reads in `wrangler tail` or in the observability logs.
- What this costs against the free plan's 10 ms of CPU. It reads the config and compares a few
  strings, and nothing has measured it there.

## Consequences

Honest limits, all accepted:

- **It checks presence, not validity.** A wrong key passes, and fails at the provider as any
  provider error does. It never produces a stand-in's output.
- **One missing key takes everything down, reading included.** With Groq's key gone, the demo meeting
  cannot be read either, though nothing about reading needs Groq. Refusing only what would use the
  missing provider would leave a half-working site, and a rule to get right for every route.
- **Nothing warns until someone tries,** as with the invite code. There is no startup to warn at, and
  `/api/health` stays 200, so a health check will not notice a refusing server.
- **Each refused page view logs a stack trace.** Nitro does this for a fatal page error, and the
  meeting pages' errors are fatal. It names no setting, and it is one line a view, but it can
  outnumber the one line that says why.
- **A server on another host can still choose stubs,** by setting the opt-in. That is what it is for,
  and the rule in decision 3 limits what it can reach.
- **It repairs nothing.** A fake transcript or index already stored stays there.

## Alternatives considered

- **Throw at startup, as the audit proposed.** A Worker has no startup with its settings available.
- **`NUXT_REQUIRE_REAL_DRIVERS`, also from the audit.** It fails open: forgetting it is the same
  mistake as forgetting a key.
- **A Nitro middleware on `/api`.** It would answer before ADR-0015's and the admin route's guards,
  and it would not stop a driver being built outside it.
- **Report this from `/api/health`.** ADR-0009 needs it at 200 for liveness, and the browser job waits on it.
- **Leave the local drivers out of the Worker bundle at build time.** It would make the stand-ins
  impossible there rather than refused, and could drop `nodejs_compat`. Worth doing in Phase 13 if the
  bundle's size calls for it; this decision does not depend on it.
