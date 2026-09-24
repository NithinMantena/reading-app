# Discovery generation (Phase 2)

How a shelf edition is produced, what it costs, and how to operate it.

## Pipeline

One job per (horizon, period). The worker function advances a job through stages and writes a
checkpoint after each, so a run survives Edge Function time limits and resumes where it stopped.

| Stage | What happens | Hard rules enforced |
| --- | --- | --- |
| context | Load interests, exclusions, length and access preferences, trusted feeds, recent feedback, the derived preference summary, everything already surfaced or saved, finished books. Check the monthly budget. | Cap of 0 or exceeded cap fails the job with a clear message; nothing is spent. |
| retrieve | Generate search queries (helper model) from interests plus exploration topics. Query the sources for the horizon. Dedupe by canonical URL. | Known/saved/previously-surfaced URLs, blocked hosts, NYT without the exception are dropped. Candidate cap (default 70). |
| validate | Fetch each page safely (private networks refused, redirects re-checked, size and time capped). Extract metadata and main text. Resolve the publication date from publisher-grade evidence (Crossref, arXiv, OpenAlex, page metadata) and check it fits the window given its precision. Classify access. | Ambiguous dates (sources disagree) are rejected. Year- or month-only dates must fit entirely inside the window. Modified timestamps are never used as publication dates. Excluded publishers/authors rejected. |
| assess | Borderline access cases (at most 25 per run) go to TypeSafe Jev, which answers typed questions about the extracted text: full text / abstract / teaser / not an article, and whether it is gated. Code accepts only clear full texts (P ≥ 0.75, gated < 0.5) and rejects only clear teasers (P ≥ 0.8). Everything in between, up to 10 items, goes to the helper model in one request. Without a Jev key the helper model checks up to 25 items in one request, as before. | Anything still unverified is rejected. Title-only candidates are rejected (no content evidence). Jev's probabilities are kept on each candidate (`accessEvidence.jev`) for later threshold tuning. |
| rank | The main model sees only validated candidates (id, metadata, evidence depth, excerpt) and returns scored selections with two rationales, topics, and a surprise flag. | Output ids must be candidate ids; anything else is discarded. |
| compose | Enforce ≤2 per publisher (different publishers for the monthly pair), exactly one surprise slot in five-item batches, hard topic exclusions, minimum quality. | The surprise slot is left empty rather than backfilled; a short batch carries an explanation. |
| publish | Insert reading items as `candidate` (reused if already saved), a new batch version, its entries; flip status to `published`/`partial` last. | Old editions are never modified. Failed runs never create a batch; the last good edition stays visible. |

Sources by horizon:

| Horizon | Free sources | With a search key |
| --- | --- | --- |
| daily | Hacker News (points ≥ 80), your RSS feeds | Exa or Brave with date filters |
| weekly | HN (≥ 200), arXiv, feeds | Exa/Brave |
| monthly | HN (≥ 400), arXiv, OpenAlex (relevance), feeds, model leads | Exa/Brave |
| yearly | arXiv, OpenAlex (most cited, open access), feeds, model leads | Exa/Brave |
| decade | OpenAlex (most cited, open access), feeds, model leads | Exa/Brave |

"Model leads" are titles the ranker suggests from its own knowledge for long horizons. They are
treated as unverified hints: a lead without a working URL, publisher-grade date evidence, and
verified free access is dropped like any other candidate.

## Scheduling

- `reading-worker-step` (pg_cron, every minute) calls the worker, which claims one runnable job
  and advances it within a ~95 s budget.
- `reading-dispatch` (every 10 minutes) checks each horizon's current window in the owner's
  time zone and, from 07:00 local, queues a `scheduled` job for any period that has no
  published edition, no active job, and no earlier successful run. It never back-fills
  historical periods. A period that failed today is not retried until tomorrow. If either
  lookup errors, the period is skipped until the next tick (an error once read as "no
  edition", which re-ran some periods two to four times in September 2026), and a scheduled
  job re-checks for an existing edition before spending anything.
- The website also drives the worker directly after you press Generate, so shelves fill in
  without waiting for cron.
- The cron → worker call carries a random secret generated inside the database at migration
  time. It is never written to a file or a repository.

## Configuration

### Models (Preferences → AI models)

| Role | Default | Used for |
| --- | --- | --- |
| Main model | `gemini-3.8-flash` (Google) or `claude-opus-5` (Claude) | Ranking and, for long horizons, reading leads. This is where quality comes from. |
| Helper model | `gemini-3.8-flash` or `claude-haiku-4-5` | Search queries; access checks Jev is unsure about. |
| Access check | `jev-latest` when a Jev key is saved | Borderline access (see the assess stage). |

Choose the provider, type the model names, and paste API keys on the Preferences page. Keys go to
Supabase Vault through `set_provider_key` and are never returned; the page shows only the last
four characters. Only a signed-in browser session can change them, not integration tokens.
Edge-function secrets `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `TYPESAFE_API_KEY` still work
as fallbacks when no key is saved in the app.

Function secrets (set via the deploy workflow from repository secrets, or `supabase secrets set`):

| Secret | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `TYPESAFE_API_KEY` | optional | Fallback keys when none is saved in Preferences → AI models |
| `EXA_API_KEY` | optional | Neural web search with publication-date filters. Recommended for daily/weekly quality. |
| `BRAVE_API_KEY` | optional | Alternative web search (used only if Exa is absent). |
| `OPENALEX_MAILTO` | optional | Polite-pool email for OpenAlex/Crossref requests. |
| `RANKER_MODEL`, `CLASSIFIER_MODEL` | optional | Override the Claude defaults when no models are saved in the app. |
| `MAX_CANDIDATES`, `MAX_FETCHES`, `WORKER_TIME_BUDGET_MS` | optional | Per-run limits (defaults 70, 80, 95000). |

Preferences → Generation budget shows the configured provider, models and list prices,
month-to-date spend, the cap, and the cron jobs with their last run.

## Cost

Each run records actual token usage priced at list rates in `generation_jobs.cost` and on the
batch. Before a run the budget reserves an estimate scaled from Opus-era figures (daily $0.35,
weekly/monthly $0.60, yearly/decade $0.90) by the main model's price: about $0.05 for a daily
run on Gemini 3.8 Flash. Measured Opus runs cost $0.04–0.16 (daily) and $0.16–0.19 (weekly).
Gemini 3.8 Flash is $0.75/$3.75 per million tokens through 2026 and $1.50/$7.50 from
January 1, 2027. Jev costs $0.042 per million input tokens, which is effectively nothing here. The cap in Preferences is enforced
before every run; when reached, existing lists and the library keep working.

## Model comparison (PRD §7.4)

Preferences → Compare ranking models (or `POST /v1/recommendation-jobs { kind: "model_comparison", horizon }`).
The run retrieves and validates as usual, then ranks the same candidate set with every model in
"Models to compare" (default `anthropic:claude-opus-5`, `google:gemini-3.8-flash`,
`anthropic:claude-sonnet-5`; entries without a key are skipped), stores the results in the job
checkpoint, and publishes nothing. Unlike other runs it does not exclude what the period's
edition already shows, so the models choose from the same pool the real edition came from.
The Preferences page shows the lists side by side with scores, rationale and cost.

## Operating notes

- Alternatives: `Find alternatives` creates a new version for the same period and avoids items
  shown in earlier versions. Earlier versions stay in the archive.
- Fill missing slots: keeps existing entries and adds new ones in a new version.
- Everything the ranker sees is logged in the job checkpoint (`checkpoint.log`, candidates
  with reject reasons). Preferences → Generation runs lists jobs; `GET /v1/jobs/{id}` has the detail.
