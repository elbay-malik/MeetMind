# ADR-0013: A meeting is reached only through its unguessable link

- **Status:** Accepted
- **Date:** 2026-11-02
- **Supersedes:** ADR-0008 decisions 1, 3, 4, 5, 6 and 7 (cross-meeting search is gone, along with its route, repository method and UI) and PLAYBOOK Phase 8's archive and cross-meeting search. ADR-0008's decision 2 no longer has anything to apply to. Amends ADR-0010 (the search endpoint was its pressing case for rate limiting), ADR-0011 (how an operator finds a meeting, and what a leaked link means) and ADR-0012's note that cross-meeting search reads `meeting_index_state`.

## Context

The 2026-10-26 security audit rated SEC-01 critical. `GET /api/meetings` listed the
newest meetings to anyone, and each listed id opened the audio, transcript and summary.
`GET /api/meetings/search` went further: it returned verbatim passages from every
indexed meeting, including those older than the list reached, with nothing to know in
advance. The UUIDs were unguessable, and that protected nothing, because the API handed
them out.

The audit's full fix is accounts: an `owner_id` on every table, enforced in every query.
MeetMind is a portfolio demo. It has no users to give accounts to, and a login in front
of a demo is mostly a reason not to try it. The decision, taken on 2026-11-01, is that
the app stays accountless and stops handing out ids.

## Decision

### 1. The meeting id is the capability. There is no second token.

`POST /api/meetings` mints the id with `crypto.randomUUID()`: 122 random bits, from the
platform's secure generator, far past anything guessing can reach even with no rate
limit at all. The audit's interim suggestion was a per-meeting secret separate from the
id, which would matter if the id leaked somewhere the secret did not. So every place an
id could leave was checked (see "Where ids can go" below). None of them hands one to
someone who does not already hold it, so a second token would travel the same paths as
the id and add a migration for nothing.

### 2. No route returns more than one meeting.

`GET /api/meetings` and `GET /api/meetings/search` are removed, with what only they
used: `MeetingRepository.list`, `searchAcrossMeetings` on both window drivers,
`server/utils/qa/search.ts` and its schema and types. `POST /api/meetings` stays.
Per-meeting questions and their index stay.

The storage budget never used `list`: `stored_audio_bytes` on Supabase and
`storedAudioBytes` on the local driver each return one number, and neither is exposed
except as that sum.

With the handlers gone, a GET on `/api/meetings` matches no API route and falls through
to the page renderer, which answers 404. `/api/meetings/search` now reaches the `[id]`
route, whose id check answers 404.

### 3. "Your meetings" lives in this browser.

`/meetings` renders from `localStorage` and nothing else: `{ id, title, createdAt }` per
meeting, written the moment an upload registers. That is before the PUT, because the row
exists from then on, and a failed or abandoned upload still has a link that shows what
happened to it. Such an entry also carries `unfinished: true`, shown on its row, until the
upload is confirmed.

Each attempt registers a new meeting, so retrying the same recording from the upload page
replaces the earlier attempt's entry rather than adding a look-alike. The server's row for
that attempt stays, as abandoned `pending_upload` rows already do (ADR-0003), with its link
forgotten. Every row has a remove control. It takes the link off this list and deletes
nothing, which is also how a meeting an operator deleted, whose link opens a 404, leaves
the list. Nothing removes one of those on its own, because the list never asks the server.

The server renders the page's explanation and never a list, and the list is read after
mounting, so the server and the first client render always agree. Storage that is
refused says so, whether it refuses reads or only writes, on the list and on the page of
the meeting it could not remember. Corrupt storage counts as empty, one bad entry costs only itself, and
a stored id must look like a UUID before it becomes a link.

### 4. People are told, before and after they upload.

The upload page says this is a demo, not to upload anything sensitive, who receives what
(audio to Groq; the transcript to Groq and Google), that anyone with the link can view
it, that the original file's name, size and type go with the audio, and that they cannot
delete it themselves. The old line, "only a small audio file is
sent for transcription", was true of the video and read as if nothing else left.

It does not promise deletion. The R2 lifecycle rule expires audio, but nothing purges
transcripts, summaries or embeddings yet (SEC-11), so a retention claim would be false.

The meeting and progress pages tell the holder to keep the link, offer to copy it, and
repeat who can read it. The link copied is always the meeting page's, with no query
string, whichever page offers it. The demo meeting (decision 5) is the exception: anyone
can reach it from the home page, so its notice says that instead.

### 5. One meeting may be public: the demo.

`NUXT_PUBLIC_DEMO_MEETING_ID`, empty by default, makes the home page link to that
meeting. No demo meeting is created here. This is public runtime config, so the id is in
every page's payload by design; it must only ever name a meeting meant to be seen.

### 6. `Referrer-Policy: same-origin` on every route.

A meeting's URL is now a secret, and browsers send the page's URL in `Referer` on
requests to other origins. That includes requests a page makes on its own, such as icons
fetched from `api.iconify.design` (SEC-19). The header is set in `routeRules` on `/**`.

### 7. The SQL function stays, unused, until a cleanup migration.

`match_transcript_windows_across_meetings` stays in the database. It is executable only
by `service_role`, like every function here, and now nothing calls it. This change adds
no migration because a step 7 migration is being applied separately, and a new file in
`supabase/migrations` could be applied early by mistake. The later cleanup migration
should drop the function and remove its checks from `scripts/verify-migrations.sh`, its
line in `scripts/apply-migrations.sh`, and its entry in `database.types.ts`.

## Where ids can go

Checked against the code on 2026-11-02:

| Place | Finding |
| --- | --- |
| Routes returning several meetings | None left. Every other route takes one id in its path. |
| Server queries with no meeting filter | Only `stored_audio_bytes` and the local driver's equivalent, which return a sum. |
| SSR payloads | `/` and `/meetings` carry none (tested). Meeting pages carry only their own. |
| Nav and other links | Only the page's own id, and the configured demo. |
| Sitemap, canonical, `og:url` | None exist. `robots.txt` and `X-Robots-Tag` already refuse crawlers. |
| The 507 from the storage budget | Byte totals (SEC-25), no id. |
| Error messages | R2 failures name the object key, which contains the id, and can reach the client (SEC-15). Only on routes already holding that id. |
| Requests to Groq and Google | No id: the audio goes as `audio.ogg`, and prompts and embeddings carry transcript text only. |
| Upload URLs | Contain the id, and are returned only to the caller who just created the meeting. Cloudflare sees them as it sees everything. |
| Application logs | Startup driver notes and rate-limit warnings. R2 errors can include the key. Operator-only. |
| Cross-origin `Referer` | Closed by decision 6. |

## Consequences

Honest limits, all accepted for a demo:

- **A leaked link cannot be revoked.** There is no rotating an id. The only remedy is the
  admin delete (ADR-0011), which removes the meeting for everyone and is refused for the
  first 30 minutes after registration. An uploader cannot do it themselves.
- **Losing the link loses the meeting.** Clearing site data, a different browser or a new
  device leaves no way back. Nothing recovers it, short of an operator finding the row.
- **The URL is stored in places this app does not control.** Browser history, bookmarks
  and sync, Cloudflare's logs (`observability.enabled` in `wrangler.jsonc`), and anything
  a person pastes it into. Whoever can read those can read the meeting.
- **The list is readable in the browser.** Anyone using the same browser profile, any
  extension with access to the page, and any script injected into the origin can read
  `localStorage`. There is no CSP yet (SEC-18).
- **There is no per-user rate limit.** Removing search takes away the only route that
  spent embedding quota with no id at all (ADR-0008 decision 7), but registration is still
  open, and anyone with a link can spend quota on that meeting. SEC-02 to SEC-07 are not
  addressed here.
- **The demo meeting is the exception.** Its id is public, so anyone can spend Groq and
  Gemini quota asking it questions.
- **An operator cannot list meetings through the API.** ADR-0011's delete needs an id,
  which now comes from whoever reports the meeting, or from the Supabase table.
- **Meetings uploaded before this change are in nobody's list**, and any id handed out by
  a deployment that still had the list stays valid. Nothing has been published yet, so
  today this only means local data.
- **`?t=&seg=` is no longer linked from anywhere in the app.** Search results were what
  produced it; citations seek within the page. It stays as a way to share a moment, and
  `scripts/drive-player.mjs` now covers it, since `scripts/drive-search.mjs` is gone.
- **Filenames are still stored and returned** (SEC-20), and the title still defaults to
  one. Now only a link holder sees them.
- **SEC-34 is closed by removal.** No route takes a search query in its URL any more.

## Alternatives considered

- **Accounts (Supabase Auth or Cloudflare Access), the audit's full fix.** The right answer
  for real users' data. Rejected for a demo with none: it adds a sign-in in front of the
  thing being shown, an `owner_id` migration, and an auth check in every query.
- **A per-meeting secret alongside the id.** Would help only if the id were exposed where
  the secret is not, and the search above found no such place. Reconsider if a route ever
  needs to show ids to someone other than their holder.
- **Keep the list, filtered to "this visitor's" meetings, on the server.** That needs an
  identity to filter on, which is accounts again, or a cookie that is a weaker version of
  them.
- **Keep search, scoped to the ids in this browser's list.** A real feature, but one more
  route that spends embedding quota for a demo whose list is usually one meeting long. The
  per-meeting question box already covers that case.
- **Drop the function now, in a migration.** Tidier, but ruled out while the step 7
  migration is being applied. Decision 7.
