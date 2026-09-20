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

- **Idempotency.** Book/session, reading, feedback, recommendation-job creates and interest upserts accept `Idempotency-Key`. Integration tokens must send one on these endpoints
  (`428` otherwise). The same key with the same body replays the stored response
  (`Idempotent-Replayed: true`); the same key with a different body is `422 idempotency_key_reused`.
- **Optimistic concurrency.** Books, sessions, readings, settings, and feedback have an integer
  `version` bumped on update. Send it in a `PATCH` body to detect stale writes with
  `409 version_conflict`. Recommendation entry states do not have a version field.
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
| GET | `/recommendation-entries/{id}` | read | One entry with embedded `reading` and `batch`; only published/partial editions. |
| PATCH | `/recommendation-entries/{id}` | library:write | `state`: `saved`, `read`, `dismissed`, `active`. Save promotes candidates or restores archived readings and records the source entry/batch. It preserves a reading already saved, in progress, or finished. `read` marks the reading finished. |

`period` and `version` require `horizon`. Explicit edition lookups return `404` if missing.
The returned `window` uses the edition's stored bounds and original time zone, including for
archives. Archive listings exclude unpublished batches. Readings include metadata, links,
descriptions and rationales; the API does not serve the publisher's complete article text.

### Feedback and preferences

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/feedback` | read | `reading_id`, `book_id`. Soft-deleted events are excluded. |
| POST | `/feedback` | feedback:write | `action` (see below), `scope` (`item`,`topic`,`author`,`publisher`), `text`, `reading_id`, `book_id`, `recommendation_entry_id`, `quality_rating`. An entry ID alone resolves its reading, topics, and publisher. Conflicting target IDs are rejected. `source` is set from the principal (`website` or `openclaw`). |
| PATCH | `/feedback/{id}` | feedback:write | `action`, `scope`, `text`, `quality_rating`, `version`. |
| DELETE | `/feedback/{id}` | feedback:write | Soft delete; excluded from all future recommendation context. |
| GET | `/preferences` | read | Time zone, language, interests, exclusions, length preferences, access exceptions, budget, trusted `sources` (RSS/Atom feeds). |
| PATCH | `/preferences` | preferences:write | Same fields, `version`. Time zone must be a valid IANA name; `sources[].url` must be http(s). |
| POST | `/preferences/interests` | preferences:write | `{ topic, weight?, version? }`. Add one interest or update its weight without replacing other interests. Weight is a number from 0 to 3 (new topics default to 1; existing weights stay unchanged if omitted). Returns updated settings. Requires an idempotency key for integration tokens. |
| DELETE | `/preferences/interests/{topic}` | preferences:write | URL-encode the topic. Optional `?version=N`. Remove only this topic; missing topics are a successful no-op. Returns updated settings. |
| GET | `/preference-summary` | read | Explicit settings plus the latest derived summary with supporting feedback ids (Phase 3). |

Feedback actions: `more_like_this`, `less_like_this`, `already_know`, `too_superficial`,
`too_technical`, `too_long`, `wrong_topic`, `unreliable_source`, `cannot_access`, `note`, `quality_rating`.

Interest matching ignores case and repeated whitespace. Incremental interest operations always
compare the settings version at write time and retry a concurrent edit up to three attempts when
no explicit version was supplied. Supplying a stale version returns `409`. `PATCH /preferences`
with `interests` still replaces the entire list; prefer the incremental endpoints for agent tools.

### Generation jobs

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| POST | `/recommendation-jobs` | generation | `kind` (`initial`, `alternatives`, `fill_missing`, `scheduled`, `model_comparison`), `horizon` (required except for `initial` or with `batch_id`). For `alternatives`/`fill_missing`, optional `batch_id` selects a published edition and preserves its horizon, period, and original time zone. If both horizon and batch are supplied they must agree. Returns `202 { jobs[], warnings[], workerUrl }`. One active job per owner/horizon/period; duplicates return the existing job with `existing: true`. |
| GET | `/generation-config` | read | Provider and models in use, list prices, search provider, per-run estimates, month-to-date spend vs cap, cron job status, trusted sources. Never returns keys. |
| GET | `/jobs` | read | Newest first. |
| GET | `/jobs/{id}` | read | `status`, `stage`, `attempts`, `cost`, `error`. |

Alternatives create a new version of the whole shelf edition; they do not replace a single
selected article in place. Without `batch_id`, the job targets the current period for `horizon`.
For `fill_missing` with `batch_id`, the specified edition's entries are retained. Older versions
remain available. An existing active job may have a different kind: inspect the returned job
rather than assuming your request started new work.

Generation is asynchronous and may incur configured provider costs. The API makes a best-effort
worker call after queuing; cron advances it independently of the browser. Poll `/jobs/{id}` until
terminal (`succeeded`, `failed`, or `cancelled`), then fetch the resulting edition using the job's
`horizon` and `period_key`. A `202` response means queued, not completed. Integrations with the
`generation` scope can also `POST` to the returned `workerUrl` plus `?task=step` using the same
Bearer token; that call may be long-running and may advance other queued jobs for this app.

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
