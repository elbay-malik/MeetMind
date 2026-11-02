# ADR-0015: Visitors get the demo meeting, and uploading takes an invite code

- **Status:** Accepted
- **Date:** 2026-11-02
- **Supersedes:** Nothing whole. Amends ADR-0010 (open registration is no longer what is left for rate limiting to cover), ADR-0012 (a question takes its request slot before it is embedded) and ADR-0013 (registration is closed, and its decision 5's demo meeting can now only be read and asked).

## Context

ADR-0013 left registration open: anyone could upload, and only the meeting's link was
private. Two things make that the wrong default for a public portfolio demo.

Groq's Services Agreement says the services are "not for consumer use" and makes the
developer warrant "all necessary consents" for what is submitted (section 6.2). That
cannot be vouched for with anonymous strangers' recordings.

Anonymous uploads also spend what everyone shares: Groq's and Workers AI's daily limits,
and R2 storage, which has no spending cap (ADR-0010).

Accounts are still more than a demo needs, for ADR-0013's reasons. The decision, taken on
2026-11-02, is that public visitors get the demo meeting only, and uploading needs an
invite code.

## Decision

### 1. `POST /api/meetings` needs `NUXT_INVITE_CODE`, before it does anything else.

The code is sent as `Authorization: Bearer <code>`, never in a URL or query string, because
URLs land in logs and history. It is the header the admin routes already use, and the one log
tools are most likely to treat as a credential, where a custom header would read as data.

`requireInviteCode` is the handler's first line, so a refused caller costs no body parsing,
budget check, storage or provider call. It reuses the admin token's constant-time comparison
and its 32-character minimum. A missing code, a wrong one and a nearly right one get the same
401 in the same words, so a refusal says nothing about how close a guess was.

Nothing else creates a meeting, and everything that spends quota needs a meeting, so this
one gate also closes transcription, extraction and indexing to anyone without a code.

### 2. An unset or short code closes uploads for everyone.

This is a deliberate exception to the repo's habit of absent config selecting a stub: a
missing code must never read as open. Unset, empty, whitespace or under 32 characters answers
503 with a plain message and logs a warning naming the setting, never its value. Someone
presenting a too-short configured code exactly is refused too, as `requireAdmin` refuses a
short admin token. It is a 503 here and not the admin route's 500 because a visitor reads
this one, and because being closed is a state the page has to explain.

There is no test bypass. The tests start the server with a code in its environment, as any
deployment does.

### 3. The page checks the code before the browser touches a recording.

`POST /api/invite-check` answers 204 or the same refusal as the real route. It is the same
guard and nothing else, so it is no cheaper to guess against, and it reads and writes nothing.
The home page renders no file input until it has answered 204, so a wrong code fails at once
rather than after minutes of extraction.

The code stays in the page's memory: not the URL, not `localStorage`, not `sessionStorage`,
not a log. It goes when the page does, so a second upload after leaving the page asks again.
The field has no `name`, because a form submitted before the page is interactive sends named
fields in the URL. If the server stops accepting the code during an upload, because it was
rotated, the page asks again and keeps the extracted audio.

### 4. The demo meeting can be read and asked. Nothing else.

ADR-0012 lets anyone holding a meeting's id drive its pipeline, and ADR-0013 makes that id the
capability. The demo's id is on the home page, so for this one meeting that capability is
held by everyone. `refuseOnPublicDemo` answers 403 on the four routes that could move it along,
and on `POST .../advance` (ADR-0012's step 9), which takes whichever of their steps comes next,
before they read anything. Asking stays open, because asking is the showcase.

This was tested against the routes before the guard was added, with an anonymous `POST`:

| The demo was | Route | What happened |
| --- | --- | --- |
| `ready`, with its summary and a complete index | all four | Nothing: 200 or 409, no writes and no provider call |
| `ready`, with no summary row | `summarize` | Started a new extraction and moved to `indexing`, away from `ready`. Each further call spends Groq quota |
| `ready`, index incomplete | `search-index` | Embedded what was missing: Workers AI quota spent |
| `ready`, index from another model | `search-index` | Deleted the windows and embedded them again |
| `uploaded` | `transcribe` | Started Whisper: audio quota spent |
| `failed` in transcription, past its cooldown | `transcribe` | Retried: audio quota spent, if the failed step was Whisper's |
| `failed` in extraction, past its cooldown | `summarize` | Resumed: Groq quota spent, or `ready` if no chunk was left |
| `pending_upload` | `complete` | Marked `uploaded`, if the object was there |

So a finished demo was safe, but only for as long as it stayed finished. A new embedding
model, which ADR-0014 has already done once, was enough to let any visitor re-spend the index.
The guard does not depend on the meeting's state.

The ids are compared in lower case. `requireMeetingId` accepts a UUID in capitals, the column
is `uuid` so Postgres finds the same row, and a comparison of the strings would have been a
way around this. A percent-encoded id reaches the handler decoded, so it needs nothing extra.
The configured id is trimmed first, as the invite code is: a stored newline would otherwise turn
the guard off.

The invite code makes no difference on the demo. It is for uploading, and a second meaning
would be a second route to guess it against. An operator finishes or repairs the meeting
with the variable unset (see below).

## What guards each route

Checked against the code on 2026-11-02. `tests/unit/adr-consistency.spec.ts` fails if a file under
`server/api` that is not a `GET` is missing here, including one with no method in its name, which
answers every method. No `GET` route writes anything.

| Route | Guard | What it can write or spend | On the demo |
| --- | --- | --- | --- |
| `POST /api/meetings` | Invite code, first | A `pending_upload` row and an upload grant | Same. The id is minted here, and a body naming one is refused |
| `POST /api/invite-check` | Invite code, and nothing else | Nothing | Same |
| `PUT /api/uploads/:token` | Signed grant for one key, type and byte count, 15 minutes. Local store only: 404 with R2 | The grant's audio object | Same. Only whoever registered a meeting ever holds its grant |
| R2's presigned `PUT` (not our route) | Signed URL, 15 minutes, handed only to whoever registered. Signs the host alone, so size and type are checked at `complete` | The audio object | Same |
| `POST /api/meetings/:id/complete` | Meeting id, and the row must be `pending_upload` | The row's status; deletes an object that fails verification | **Refused, 403** |
| `POST /api/meetings/:id/transcribe` | Meeting id, a transcribable status, a claim per step | Whisper quota, the raw reply, the transcript, the row | **Refused, 403** |
| `POST /api/meetings/:id/summarize` | Meeting id, a finished transcript, a claim per step | Groq quota, the chunk ledger, the summary, the row | **Refused, 403** |
| `POST /api/meetings/:id/search-index` | Meeting id, a finished transcript | Workers AI quota; writes windows, deletes stale ones | **Refused, 403** |
| `POST /api/meetings/:id/advance` | Meeting id, whatever the step it takes needs, a claim per step. Never replaces an index holding another model's or transcript's work, and never repairs a `ready` meeting with no summary | Whatever its one step spends: Whisper, Groq or Workers AI quota, or nothing | **Refused, 403** |
| `POST /api/meetings/:id/ask` | Meeting id, a finished transcript, a complete index, a 4 KB body | Workers AI and Groq quota, and the shared Groq slot. Nothing about the meeting | **Open, on purpose** |
| `DELETE /api/meetings/:id` | `NUXT_ADMIN_TOKEN` (ADR-0011) | Removes everything stored for the meeting | Same. This is how an operator removes it |

## Creating the demo meeting

1. Pick a recording you may publish, with the consent of everyone on it. Section 6.2 applies to
   this one too, and anyone will be able to read and play it.
2. Set `NUXT_INVITE_CODE` (`openssl rand -hex 24`; on Workers, `wrangler secret put`). Leave
   `NUXT_PUBLIC_DEMO_MEETING_ID` empty: while it names a meeting, that meeting's pipeline refuses.
3. Open the home page, enter the code and extract the audio. Use **Download audio** to keep a copy
   before uploading (see below), then upload. On the progress page start transcription, then
   extraction, then indexing, until it says it is ready for questions.
4. Take the id from the meeting's link and set it with `wrangler secret put NUXT_PUBLIC_DEMO_MEETING_ID`,
   as for the code in step 2, and not as a dashboard variable. `wrangler deploy` deletes a plain
   variable that `wrangler.jsonc` does not list, and with it would go the home page's link and the
   read-only guard, with nothing logged. A secret stays across deploys, and its value is still public.
5. Open it from the home page in a private window and ask it something.

The demo's audio expires like any other. README step 3's `expire-meeting-audio-30d` rule covers all
of `meetings/`, a rule goes by prefix so it cannot leave out one key, and nothing in the app can
upload to an existing meeting again. The transcript, summary and questions live in Postgres and
carry on, but the player and citation seeks stop working 30 days after upload. Before then, and
again every time, put the same file back, which restarts the object's age:
`wrangler r2 object put <bucket>/meetings/<id>/audio.ogg --file meeting-audio.ogg --content-type audio/ogg --remote`.
The bytes must be the ones uploaded, because the row holds their length. `wrangler r2 object get --remote`
fetches a copy while the object still exists. This has not yet been run against a real bucket. The
alternative is to create a new demo and change the id. The storage budget's estimate stops counting
the object after `NUXT_R2_RETENTION_DAYS`, which for one recording is small enough to ignore.

To repair or replace it, clear the variable with `wrangler secret delete NUXT_PUBLIC_DEMO_MEETING_ID`,
finish the work and set it again. A change of embedding model needs this, since questions are
refused until the index is rebuilt. To remove it, use the admin delete (ADR-0011, refused for 30
minutes after registration), and clear the variable, or the home page goes on linking to a 404.

## Consequences

Honest limits, all accepted for a demo:

- **One shared code.** There is no per-person revocation and no record of who uploaded what. A
  leaked code can only be replaced, for everyone.
- **Rotating it locks everyone out** until they have the new one. Nothing else changes.
- **Existing links keep working.** The code guards creating a meeting, not reading one. A meeting
  registered before this change can still be driven by whoever holds its link, and spends quota.
- **Whoever holds the code has what any visitor used to have.** SEC-02, SEC-03 and SEC-05 are
  closed to strangers and remain for them, including overwriting their own object with its grant
  for 15 minutes. They are trusted, and the storage budget still applies.
- **Questions on the demo still spend quota, and nothing limits how many are sent.** A script
  asking in a loop can take every free slot on the shared Groq chat, which stalls extraction for
  invited uploads for as long as it runs (SEC-04). A question takes its slot before it is embedded,
  so a refused one spends nothing, and Workers AI spend follows the slot's pace: at the default of
  one a minute, 1,440 questions of at most 500 tokens, about 8% of the day's allocation. No rate
  limiter is added here (SEC-07). A Cloudflare rate-limit rule on this route is the cheapest bound
  to add at deployment.
- **What a visitor types goes to Cloudflare and Groq.** The question form says so before it is
  sent. Groq's section 6.2 applies to it too, and nobody can vouch for what a stranger types.
- **Guessing is limited only by the code's length.** Each attempt costs one MAC and nothing locks
  out. At 192 random bits that is enough; it is why the minimum is enforced.
- **Nothing warns until someone tries.** The closed warning is logged per refused request, not at
  startup, so a deployment that nobody has tried to upload to has said nothing.
- **The demo's audio expires like any other.** Nothing warns the operator, and visitors see the
  player's "Audio unavailable" alert until the object is put back (see "Creating the demo meeting").
- **Who else sees the code.** Cloudflare terminates TLS, so it sees the header. Whether its logs
  (`observability.enabled` in `wrangler.jsonc`) record request headers is not settled by its
  documentation, so look at one invocation log on the first deployment. Any script running in the
  page can read the field, and there is no CSP yet (SEC-18).
- **The pipeline page still offers its buttons on a demo that is not finished.** They answer with
  the read-only message. A demo left in that state is the operator's to fix. `GET .../pipeline`
  does not offer them too: there it answers `wait` with no time, not `continue` (ADR-0012's step 9
  addendum).

## Alternatives considered

- **Accounts, or Cloudflare Access.** The right answer for real users' data; ADR-0013's reasons
  for not doing it still hold, and a per-person record is not what a portfolio demo needs.
- **One code per person, in a table.** Would allow revoking one person. It needs a migration and
  a way to issue them. Reconsider if this stops being a handful of people.
- **No uploads at all, only the demo.** Simplest, but it removes the part of the app worth showing
  to someone who is interested enough to ask.
- **The code in a query string, or a cookie.** A URL lands in logs and history. A cookie is sent on
  every request, to routes that have no use for it, and persists past the page.
- **`sessionStorage` for the code.** Would survive a reload at the price of a place to read it
  from later. Re-entering it costs a demo's few uploaders very little.
- **Let the invite code drive the demo's pipeline.** Convenient for repairs, but it gives the code
  a second meaning and a second route to guess it on, and its refusals would read oddly there.
- **Make each pipeline route check the demo's state instead of its id.** They already do what a
  finished meeting allows, and the table above shows why that was not enough.
- **A rate limiter.** The real answer to the questions above, and out of scope here by decision.
