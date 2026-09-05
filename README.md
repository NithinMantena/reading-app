# Reading

**App: https://nithinmantena.github.io/reading-app/**

A personal reading home: a log of books read, a wishlist, a queue of saved articles and papers,
and five discovery shelves that recommend worthwhile readings published in the immediately
preceding day, week, month, year, and decade. It learns from explicit feedback while keeping one
slot in every batch deliberately outside the usual reading.

The source code and the website shell are public. The reading data is private to the owner:
only the configured GitHub account can sign in and read or change anything.

## How it is built

| Layer | Choice |
| --- | --- |
| Frontend | TypeScript + React (Vite), static build on GitHub Pages |
| Backend | Supabase: Postgres with row-level security, GitHub sign-in, one Edge Function serving the versioned `/v1` API, scheduled jobs (Phase 2) |
| Bot | `bot/reading.mjs` CLI + OpenClaw skill, authenticated with revocable scoped tokens |
| Shared logic | `supabase/functions/_shared/periods.ts` computes publication windows for both the site and the API |

```
src/                     React app (views: Home, Library, Discover, Reading queue, Preferences)
supabase/migrations/     Schema, RLS policies, realtime publication
supabase/functions/api/  /v1 API (books, sessions, readings, recommendations, feedback,
                         preferences, jobs, tokens, export/import)
bot/                     OpenClaw CLI
openclaw/skills/         OpenClaw skill file
docs/                    API contract, deployment, OpenClaw setup
tests/                   Unit tests for period windows and URL canonicalisation
```

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 · Shared foundation | Repo and app link, owner auth, database, book log, wishlist, saved readings, export/import, API, bot add/list/update | **Built; awaiting Supabase project configuration** (see `docs/DEPLOY.md`) |
| 2 · Discovery | Retrieval and validation pipeline, five shelves, surprise slot, scheduling, edition history, cost visibility | Schema and API contract in place; worker not yet implemented |
| 3 · Personalisation | Feedback-aware search, derived preference summaries, bot feedback/generation, recovery | Feedback storage and API in place; summaries and ranking not yet implemented |

The product requirements are in `Reading-App-PRD.md` in the parent folder of this repository
(kept outside the public repo).

## Run locally

```bash
cp .env.example .env   # add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev
npm test
```

## Documentation

- [Deployment](docs/DEPLOY.md) — Supabase project, GitHub OAuth, Actions variables, Pages
- [API v1](docs/API.md) — endpoints, auth, idempotency, versioning
- [OpenClaw](docs/OPENCLAW.md) — install the skill and configure the bot token

## Principles carried into the code

- Publication windows are half-open intervals computed in the owner's time zone; ambiguous dates
  are admitted only when the whole possible interval fits.
- Never fabricate dates: start and finish dates may be unknown; nothing defaults them.
- Ratings are 0–10 with one decimal; unrated is distinct from 0.
- Archive is the default removal; permanent deletion is website-only.
- Every create is idempotent; every edit is version-checked.
- Fetched pages are untrusted content: the enricher refuses private networks, re-checks redirects,
  and caps size and time.

## License

MIT for the code. Personal data is never part of this repository.
