# API v1

Base URL: `https://<ref>.supabase.co/functions/v1/api/v1`

The website and the OpenClaw bot use the same endpoints, so validation and business rules live in
one place (`supabase/functions/api`).

## Authentication

| Principal | Header | Notes |
| --- | --- | --- |
| Website session | `Authorization: Bearer <Supabase JWT>` | GitHub login must equal `app_owner.github_login`; otherwise `403 not_owner`. Full scopes. |
| Integration token | `Authorization: Bearer rap_…` | Created in Preferences. Only the SHA-256 hash is stored. Carries scopes. |

Scopes: `read`, `library:write`, `feedback:write`, `preferences:write`, `generation`, `admin`.
`admin` (token management, permanent deletion) is never granted to tokens.

## Conventions

- **Idempotency.** `POST` creates accept `Idempotency-Key`. Integration tokens must send one
  (`428` otherwise). The same key with the same body replays the stored response
  (`Idempotent-Replayed: true`); the same key with a different body is `422 idempotency_key_reused`.
- **Optimistic concurrency.** Every record has an integer `version` bumped on each update. Send
  `version` in a `PATCH` body to get `409 version_conflict` instead of silently overwriting.
- **Errors.** `{ "error": { "code", "message", "details" }, "requestId" }`.
  Codes: `unauthenticated`, `invalid_token`, `token_revoked`, `token_expired`, `not_owner`,
  `insufficient_scope`, `validation_failed`, `not_found`, `conflict`, `version_conflict`,
  `idempotency_key_required`, `idempotency_key_reused`, `internal`.
- **Dates.** Calendar dates are `YYYY-MM-DD` and may be `null` (unknown). Instants are ISO-8601 UTC.
- **Ratings.** `0`–`10` inclusive, one decimal; `null` = unrated (distinct from `0`).
- **Statuses.** Books: `want_to_read`, `reading`, `finished`, `stopped`, `unknown`. Sessions: `reading`, `finished`, `stopped`, `unknown`. `unknown` is for historical records whose completion is not known; nothing is inferred from a year heading or a rating.
- **Provenance.** Imported records may carry `import_source` (workbook, worksheet, source ids, raw values). It is kept apart from the user's own notes.
- **Lists.** `{ items, total, limit, offset }`; `limit` ≤ 500.
- **Links.** Records include `app_link`, a canonical URL into the website.

## Endpoints

### Books

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/books` | read | `q`, `status`, `topic`, `min_rating`, `archived=true`, `sort` (`updated`,`created`,`rating`,`title`,`finished`,`started`), `order` |
| POST | `/books` | library:write | `title`, `authors[]` or `author_unknown`, optional `library_status`, `started_on`, `finished_on`, `rating`, `topics[]`, `isbn`, `edition`, `cover_url`, `description`, `recommended_by`, `why_read`, `notes`. Returns `200 { …, existing: true }` if a matching book exists (same ISBN, or same title and a shared author); pass `allow_duplicate: true` to force. |
| GET | `/books/{id}` | read | Includes `sessions[]`, newest first. |
| PATCH | `/books/{id}` | library:write | Any field above, `archived: true|false`, `version`. Changing `library_status` keeps the latest session in step: `reading` after `finished` opens a new session (a reread); `finished` sets `finished_on` (may be `null` = unknown) and `rating`; `stopped` closes; `session_notes` writes "what stayed with me". |
| DELETE | `/books/{id}` | admin | Permanent. Archive is the default removal. |
| POST | `/books/{id}/sessions` | library:write | New reading session (`started_on`, `finished_on`, `rating`, `session_status`). |
| PATCH | `/reading-sessions/{id}` | library:write | `started_on`, `finished_on`, `status`, `rating`, `notes`, `version`. `finished_on` may not precede `started_on`. |

### Saved readings

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/readings` | read | `q`, `status`, `topic`, `include_archived`. Discovery candidates (`queue_status = candidate`) are excluded unless requested by status. |
| POST | `/readings` | library:write | `url` **or** `title`; optional `notes`, `topics[]`, `authors[]`, `publisher`, `published_on`, `published_precision`, `item_type`, `access_class`, `duration_minutes`, `enrich: false`. URLs are canonicalised (tracking params, fragments, `www` removed). An existing URL returns `200 { …, existing: true }`. Metadata enrichment runs synchronously with a 6 s cap and refuses private-network destinations. |
| GET | `/readings/{id}` | read | |
| PATCH | `/readings/{id}` | library:write | Any bibliographic field, `queue_status`, `notes`, `archived`, `version`. |
| DELETE | `/readings/{id}` | admin | Permanent. |

### Recommendations

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/recommendations` | read | `horizon` (`daily`,`weekly`,`monthly`,`yearly`,`decade`), `period` (e.g. `2026-W35`), `version`. Without `horizon` returns `{ shelves: [...] }` for all five. Each shelf carries the exact eligible `window`, `targetCount`, the `batch` (or `null`), `entries[]` with embedded `reading`, and any `activeJob`. |
| GET | `/recommendations/archive` | read | `horizon`; every edition newest first. |
| PATCH | `/recommendation-entries/{id}` | library:write | `state`: `saved` (enters the queue), `read`, `dismissed`, `active`. |

### Feedback and preferences

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/feedback` | read | `reading_id`, `book_id`. Soft-deleted events are excluded. |
| POST | `/feedback` | feedback:write | `action` (see below), `scope` (`item`,`topic`,`author`,`publisher`), `text`, `reading_id`, `book_id`, `recommendation_entry_id`, `quality_rating`. Topics and publisher are denormalised from the item. `source` is set from the principal (`website` or `openclaw`). |
| PATCH | `/feedback/{id}` | feedback:write | `action`, `scope`, `text`, `quality_rating`, `version`. |
| DELETE | `/feedback/{id}` | feedback:write | Soft delete; excluded from all future recommendation context. |
| GET | `/preferences` | read | Time zone, language, interests, exclusions, length preferences, access exceptions, budget, trusted `sources` (RSS/Atom feeds). |
| PATCH | `/preferences` | preferences:write | Same fields, `version`. Time zone must be a valid IANA name; `sources[].url` must be http(s). |
| GET | `/preference-summary` | read | Explicit settings plus the latest derived summary with supporting feedback ids (Phase 3). |

Feedback actions: `more_like_this`, `less_like_this`, `already_know`, `too_superficial`,
`too_technical`, `too_long`, `wrong_topic`, `unreliable_source`, `cannot_access`, `note`, `quality_rating`.

### Generation jobs

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| POST | `/recommendation-jobs` | generation | `kind` (`initial`, `alternatives`, `fill_missing`, `scheduled`, `model_comparison`), `horizon` (required except for `initial`). Returns `202 { jobs[], warnings[] }`. One active job per owner/horizon/period; duplicates return the existing job with `existing: true`. The worker starts within a minute (cron) or immediately when the website drives it. |
| GET | `/generation-config` | read | Provider and models in use, list prices, search provider, per-run estimates, month-to-date spend vs cap, cron job status, trusted sources. Never returns keys. |
| GET | `/jobs` | read | Newest first. |
| GET | `/jobs/{id}` | read | `status`, `stage`, `attempts`, `cost`, `error`. |

### Integration tokens (website only)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/integration-tokens` | Metadata only (name, prefix, scopes, last used, revoked). |
| POST | `/integration-tokens` | `name`, `scopes[]` (default: everything except `admin`), `expires_in_days`. The plaintext token is returned once. |
| DELETE | `/integration-tokens/{id}` | Revoke. Takes effect on the next request. |

### Data transfer

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/export` | read | JSON of preferences, books, sessions, readings, feedback, summaries, batches, entries. Never includes tokens. |
| GET | `/export/books.csv` | read | Books with their latest session. |
| POST | `/import` | library:write | `{ mode: "preview" | "commit", data }`. Existing ids, duplicate books (ISBN or title+author), and duplicate URLs are skipped; nothing is overwritten. |

### Misc

`GET /me` — principal, scopes, time zone, and the current eligible window for every horizon.
`GET /health` — unauthenticated liveness check.

## Example: bot saves a URL, then marks a book finished

```bash
curl -s -X POST "$API/readings" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{"url":"https://example.org/essay","notes":"from the newsletter"}'

curl -s -X PATCH "$API/books/6e1c…" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"version":3,"library_status":"finished","finished_on":"2026-09-05","rating":8.5}'
```
