# Discovery generation (Phase 2)

How a shelf edition is produced, what it costs, and how to operate it.

## Pipeline

One job per (horizon, period). The worker function advances a job through stages and writes a
checkpoint after each, so a run survives Edge Function time limits and resumes where it stopped.

| Stage | What happens | Hard rules enforced |
| --- | --- | --- |
| context | Load interests, exclusions, length and access preferences, trusted feeds, recent feedback, the derived preference summary, everything already surfaced or saved, finished books. Check the monthly budget. | Cap of 0 or exceeded cap fails the job with a clear message; nothing is spent. |
| retrieve | Generate search queries (Haiku) from interests plus exploration topics. Query the sources for the horizon. Dedupe by canonical URL. | Known/saved/previously-surfaced URLs, blocked hosts, NYT without the exception are dropped. Candidate cap (default 70). |
| validate | Fetch each page safely (private networks refused, redirects re-checked, size and time capped). Extract metadata and main text. Resolve the publication date from publisher-grade evidence (Crossref, arXiv, OpenAlex, page metadata) and check it fits the window given its precision. Classify access. | Ambiguous dates (sources disagree) are rejected. Year- or month-only dates must fit entirely inside the window. Modified timestamps are never used as publication dates. Excluded publishers/authors rejected. |
| assess | Borderline access cases go to the cheap classifier: complete text, abstract, or teaser. | Anything still unverified is rejected. Title-only candidates are rejected (no content evidence). |
| rank | Claude Opus 5 sees only validated candidates (id, metadata, evidence depth, excerpt) and returns scored selections with two rationales, topics, and a surprise flag. | Output ids must be candidate ids; anything else is discarded. |
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
  published edition and no active job. It never back-fills historical periods. A period that
  failed today is not retried until tomorrow.
- The website also drives the worker directly after you press Generate, so shelves fill in
  without waiting for cron.
- The cron → worker call carries a random secret generated inside the database at migration
  time. It is never written to a file or a repository.

## Configuration

Function secrets (set via the deploy workflow from repository secrets, or `supabase secrets set`):

| Secret | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes, for any generation | Ranking (`claude-opus-5`) and classification (`claude-haiku-4-5`) |
| `EXA_API_KEY` | optional | Neural web search with publication-date filters. Recommended for daily/weekly quality. |
| `BRAVE_API_KEY` | optional | Alternative web search (used only if Exa is absent). |
| `OPENALEX_MAILTO` | optional | Polite-pool email for OpenAlex/Crossref requests. |
| `RANKER_MODEL`, `CLASSIFIER_MODEL`, `COMPARISON_MODEL` | optional | Override defaults. |
| `MAX_CANDIDATES`, `MAX_FETCHES`, `WORKER_TIME_BUDGET_MS` | optional | Per-run limits (defaults 70, 80, 95000). |

Preferences → Generation budget shows the configured provider, models and list prices,
month-to-date spend, the cap, and the cron jobs with their last run.

## Cost

Each run records actual token usage priced at list rates in `generation_jobs.cost` and on the
batch. Reservation estimates before a run: daily ≈ $0.35, weekly/monthly ≈ $0.60,
yearly/decade ≈ $0.90. A typical month (daily + weekly + one monthly) is on the order of
$15–25 in model calls, before any search-provider fees. The cap in Preferences is enforced
before every run; when reached, existing lists and the library keep working.

## Model comparison (PRD §7.4)

Queue `POST /v1/recommendation-jobs { kind: "model_comparison", horizon }` (or the bot's
`jobs create --kind model_comparison --horizon weekly`). The run retrieves and validates as
usual, then ranks the same candidate set with the ranker and `COMPARISON_MODEL` (default
`claude-sonnet-5`), stores both results in the job checkpoint, and publishes nothing. Inspect
`GET /v1/jobs/{id}` → `checkpoint.comparison` to judge reasoning against evidence and cost.

## Operating notes

- Alternatives: `Find alternatives` creates a new version for the same period and avoids items
  shown in earlier versions. Earlier versions stay in the archive.
- Fill missing slots: keeps existing entries and adds new ones in a new version.
- Everything the ranker sees is logged in the job checkpoint (`checkpoint.log`, candidates
  with reject reasons). Preferences → Generation runs lists jobs; `GET /v1/jobs/{id}` has the detail.
