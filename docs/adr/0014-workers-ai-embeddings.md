# ADR-0014: Embeddings come from Cloudflare Workers AI, not Gemini

- **Status:** Accepted
- **Date:** 2026-11-02
- **Supersedes:** ADR-0007 decision 1 (`gemini-embedding-2` at 768 dimensions). Amends ADR-0008 (its SQL function is now dropped), ADR-0012 (the `gemini-embed` slot, and what step 8 inherits) and ADR-0013 (who receives a transcript; its decision 7's cleanup is done here).

## Context

Gemini's terms say:

> You may use only Paid Services when making API Clients available to users in the
> European Economic Area, Switzerland, or the United Kingdom

MeetMind is a public demo, open to visitors from those places, on free tiers by design, and
its owner will not set up billing. So the free Gemini API may not serve this app. A notice
cannot cure that, and neither can keeping Gemini behind a setting, so it is removed
altogether rather than kept as a paid or optional provider.

Nothing is lost by moving: the real database held 0 meetings and 0 `transcript_windows`
when this was decided.

## Decision

### 1. `@cf/baai/bge-m3` at 1024 dimensions.

MeetMind transcribes whatever language is spoken, so an English-only model is not enough,
and German was the test of that. Measured against the real API on 2026-11-02, on made-up
text, with paraphrased questions, counting the right passage ranked first:

| Model | English (8 questions) | German (8 questions) |
| --- | --- | --- |
| Gemini `gemini-embedding-2` (the outgoing model) | 8 of 8 | 8 of 8 |
| `@cf/baai/bge-m3` (chosen) | 7 of 8 | 8 of 8 |
| `@cf/baai/bge-base-en-v1.5` (rejected) | not recorded | 1 of 8 |

The sample is small: 8 questions each, made-up text, short passages, not real
transcripts. It separates the models by a wide margin in German and says little beyond
that. In particular, 7 of 8 against 8 of 8 in English is one question.

`tests/services/real-services.spec.ts` keeps a smaller check of the same kind, with 4
questions per language: bge-m3 finds 4 of 4 in both, and bge-base 4 of 4 in English and
3 of 4 in German. So swapping an English-only model in fails that group.

Also measured on bge-m3:

- **Shape.** 1024 values per input, `shape: [n, 1024]`, length within about 0.0003 of 1.
- **No truncation.** Up to 8,192 tokens per input, with different endings giving different
  vectors (0.9992 similar at about 6,700 tokens). bge-base silently cuts at 512.
- **No prefix.** Both a question and a window are sent as they are, in `text`. This
  model's `query` and `contexts` parameters ask for reranking instead.

`EMBEDDING_DIMENSIONS` stays the single source of truth, and `verify-migrations.sh` reads
it from the code to check the column.

### 2. REST, not the `env.AI` binding.

`POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/baai/bge-m3`
with a Bearer token, through plain `fetch`, as every other driver here works. It follows
the driver pattern, runs under `pnpm test:services` and `pnpm dev` with no deploy, and
needs only a token scoped to Workers AI.

What it costs: one more secret to hold and rotate, which a binding would not need, and one
more subrequest per call once this runs on Workers. `NUXT_WORKERS_AI_ACCOUNT_ID` and
`NUXT_WORKERS_AI_API_TOKEN` are required together, like the R2 settings.

### 3. A batch is bounded by estimated tokens as well as by count.

The model page's "Context Window 60,000 tokens" turned out to bound a whole request, twice
over, which is what this measurement was for:

| Request | Our estimate | Provider's count | Real tokens | Result |
| --- | --- | --- | --- | --- |
| 20 windows of about 1,500 estimated tokens | 30,220 | | 27,100 | 200, 2.1 s |
| 39 such windows | 60,031 | | 54,483 | 200, 3.5 s |
| 40 such windows | 60,373 | 60,238 | not reached | 413, code 5021 |
| 100 such windows | 150,948 | 150,597 | not reached | 413, code 5021 |
| 20 inputs of 6,000 punctuation marks | 30,100 | 107,960 | 107,960 | 400, code 8007 |
| 100 short texts | 4,437 | | 4,300 | 200, 1.1 s |

- **First gate, before tokenizing.** It takes the JSON body's length in characters over 4.
  In seven languages its stated count matched that within 6, including Chinese, Thai and
  Hindi, so it counts characters and not bytes. Over 60,000: HTTP 413, code 5021.
- **Second gate, on the real count.** Over 60,000 real tokens: HTTP 400, code 8007, "Max
  context reached 107960 tokens but model supports only 60000". The last row passes the
  first gate and fails this one.

So `MAX_BATCH_TOKENS` is **12,000** by `estimateTokens`, beside `MAX_BATCH` of 100. The
estimate never drops below a character count over 4, which keeps the first gate well away.
For the second, the worst measured ratio of real to estimated tokens is 3.94 (below), so
12,000 stays under about 47,300 real tokens. That is conservative for speech: at Korean's
1.39, the worst real language measured, a batch is about 16,700 real tokens.

It costs little. A one-hour meeting is about 25,000 estimated tokens (ADR-0012's 9 chunks
of 2,500, plus overlap), so about 3 requests, at about a second each for this size. Indexing
stores each batch as soon as it is embedded, through the same `planEmbeddingBatches` the
driver uses, so a batch is exactly one request and resuming still loses at most one.

### 4. The estimate's margin holds, and only a lone oversize segment can pass the limit.

Windows close at `WINDOW_TOKEN_BUDGET` = 1,500 estimated tokens. Real counts at that size,
from the `input_tokens` the reply reports, one window each:

| Text | Estimated | Real | Real / estimated |
| --- | --- | --- | --- |
| Thai | 1,613 | 338 | 0.21 |
| Japanese | 1,555 | 860 | 0.55 |
| Chinese | 1,505 | 870 | 0.58 |
| English | 1,505 | 1,154 | 0.77 |
| German, with long compounds | 1,516 | 1,198 | 0.79 |
| Russian | 1,542 | 1,262 | 0.82 |
| Turkish | 1,520 | 1,289 | 0.85 |
| Hindi | 1,529 | 1,355 | 0.89 |
| Arabic | 1,533 | 1,484 | 0.97 |
| Korean | 1,514 | 2,109 | 1.39 |
| Digits with no spaces | 1,504 | 2,341 | 1.56 |
| Random base64 | 1,504 | 4,518 | 3.00 |
| Punctuation only | 1,504 | 5,351 | 3.56 |
| Emoji only | 1,504 | 5,923 | 3.94 |

The estimate does not undercount German; it overcounts it. Korean is the one real language
it undercounts, and 8,192 is still nearly 3.9 times what that came to. Even the worst text here
stays under the limit, since at about one token per character the estimate's floor of a
quarter token per character caps a window near 6,000 tokens.

So only a single segment over the budget can reach 8,192, since a segment is never split
(ADR-0007 decision 2). Whisper's segments are a few seconds long, so this should not come
up, but a transcript is data and the path has to be right.

**Such an input fails clearly, and the meeting stays without questions.** The provider
refuses it with HTTP 400, code 8007, "Sequence too long: 9223 > 8192", and refuses the
whole request with it. The driver raises `EmbeddingInputTooLongError` with that count, the
route answers 422 and says so plainly, and it does not offer "indexing again resumes",
which would be false. Nothing is lost: the transcript and summary still hold every word.

Handling it instead, by splitting the text and averaging the pieces' vectors, was rejected.
It builds retrieval quality nobody has measured for a case that should not occur. And a
question that retrieves that window would still fail, because the answering model's prompt
could not hold it (ADR-0006).

### 5. At the daily limit a visitor is told so, plainly, and indexing resumes.

The Free plan has 10,000 neurons a day, resetting at 00:00 UTC, after which operations fail.
That is documented, as is 1,075 neurons per million tokens, which the replies match (29.12
neurons for 27,100 tokens). That makes about 9.3 million tokens a day: some 370 one-hour
meetings by the estimate above, far past Groq's 40 to 45 (ADR-0012), or hundreds of thousands
of short questions. Groq should bind first, but anyone with a link can spend this.

- **What counts.** A 429, codes 3036 and 4006, or the words "daily free allocation", on any
  status. The error page lists 3036, and 4006 is from memory. **None of this has been seen
  against the real API**, because that takes spending the whole allocation.
- **What a visitor gets.** HTTP 429 and `Retry-After`, with "The free daily limit for
  indexing and questions has been reached. It resets at 00:00 UTC." Asking, the question
  form holds until then and names the time on the visitor's own clock. Indexing, it adds
  that passages so far are kept and indexing again resumes, which is true: every batch
  before the refusal is stored. Never a generic 502, and no page depends on this call.
- **Never retried in place.** The allocation does not come back within a request.
- **One exception.** Code 3040 is also a 429, documented as "Capacity temporarily exceeded,
  please try again". Saying "until midnight" over that would be false, so it answers 503,
  "Try again shortly", with no hold. Nor is it retried in place.

Every other failure keeps the shape it had. A 5xx or a network failure is retried once, and
any other refusal is final. A 408 is the one addition to what is retried: the error page lists
Timeout (3007) and Aborted (3008) under it, none has been seen against the real API, and our
own timeout was already retried. No message carries the token or the account id, including text
the provider echoes back, because these messages reach visitors.

### 6. The migration deletes the rows and changes the column.

`20261102120000_workers_ai_embeddings.sql` deletes every window, since a cast from 768 to
1024 is impossible and these rows are derivable. It changes the column to `vector(1024)`,
recreates `match_transcript_windows` with the same body and privileges, drops any index on
the column, and drops `match_transcript_windows_across_meetings`, which ADR-0013 decision 7
left for a cleanup migration. It is safe to run twice: the delete runs only while the column
is not yet 1024.

The app and the column have to change together: old code cannot write to the new column, or
new code to the old one. With 0 rows and nothing published, apply the migration, then run the
new code.

The stub's model name moves to `stub-hashed-tokens-v2`. It went to 1024 dimensions too, and
the name is what tells a stored index apart: a local `.data/` index built at 768 now reads
as another model's and is offered for indexing, rather than failing its first question on
the sizes.

### 7. The CPU concern, recorded for ADR-0012 step 8.

A 1024-dimension reply is about a third larger than a 768 one, at about 19.4 KB per vector.
Under the Workers free plan's 10 ms of CPU, step 8's index batch may not fit. Measured
**locally: Node 24.18 on an Apple M5, on real reply bodies. These are not Workers numbers,**
and a Worker on shared hardware may be several times slower.

| Vectors | Reply | `JSON.parse`, median of 300 | First run in a fresh process: parse | validate | `JSON.stringify` of the upsert |
| --- | --- | --- | --- | --- | --- |
| 1 | 19,687 B | 0.02 ms | 0.04 ms | | |
| 16 | 311,288 B | 0.38 ms | 0.42 ms | 0.27 ms | 1.02 ms |
| 100 | 1,942,585 B | 2.48 ms | 2.84 ms | 0.87 ms | 5.61 ms |
| 100, cut to 768 for comparison | 1,457,142 B | 1.81 ms | 2.11 ms | | |

The first run is the honest column, since a Worker may well be cold. Writing the rows costs
twice what parsing the reply does, which nobody had been counting: 100 vectors come to about
9.3 ms here before any of the step's other work, which leaves no room on a slower machine. At
16 vectors it is about 1.7 ms.

`MAX_BATCH` stays at 100, because this does not clearly call for lowering it now. No route
runs under the CPU limit yet, and step 8's `INDEX_BATCH` of 16 (ADR-0012) already answers it.
Step 8 should measure it on real Workers CPU, and its batches also have to stay within
`MAX_BATCH_TOKENS`. A batch of 16 windows at the full budget would not.

## Consequences

- **A transcript and each question now go to Cloudflare.** The upload page, the question form
  and the README say so. Cloudflare already held the audio. Its service-specific terms for Workers AI, as read on
  2026-11-02, state no geographic limit on unpaid use and say it does not use customer content
  to train generative AI. That was a reading, not a legal review.
- **Every indexed meeting must be indexed again.** Today that is none.
- **One credential for embeddings can be scoped narrowly**, separately from wrangler's token
  and the R2 keys.
- **Provider and storage now share one vendor.** A Cloudflare account problem takes out audio
  and questions together.

## What stays untested

- **Real transcripts.** All retrieval numbers come from made-up short passages. Real windows
  are longer and messier, and Whisper's errors are in them.
- **Real Workers CPU**, in decision 7, and a REST call made from inside a Worker.
- **The real refusal at the daily limit**, in decision 5.
- **The migration on the real project.** It has run only on the throwaway Postgres in
  `verify-migrations.sh`, including with a stored row and hand-built indexes in the way.

## Alternatives considered

- **`@cf/baai/bge-base-en-v1.5`**: found 1 of 8 German questions, and silently truncates at
  512 tokens per input. Text lost without a word is exactly what this has to avoid.
- **Gemini with billing**: the terms would then allow it, but the owner will not set up
  billing on a demo meant to cost nothing.
- **Keyword search instead of embeddings**: no provider and no quota, and no answers to a
  question worded unlike the transcript, which is the feature. It would also need an answer
  for every language's stemming.
- **Keeping Gemini with a notice**: the terms restrict what is made available, not what is
  disclosed, so telling visitors changes nothing.
- **Splitting an oversize window and averaging**: see decision 4.
- **The `env.AI` binding**: one less secret, but no use under `test:services` or local dev
  without a deploy, and a different shape from every other driver. See decision 2.
