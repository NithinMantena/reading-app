# Building a Claude MCP client for Reading

The app already has a hosted HTTP API. Your MCP server can expose focused tools to Claude and
translate each tool call into an API request. Both the website and MCP client then use the same
database and business rules. You do not need a direct database connection or a separate library.

This is a guide to building your own MCP server; the repository does not currently ship an MCP
protocol server. The existing `bot/reading.mjs` CLI is another API client and can serve as a
reference for request handling. The full contract is in [API.md](API.md).

## Authentication

In the website's **Preferences → OpenClaw integration**, create a token named for your Claude
MCP server. Despite the section's name, these tokens work for any HTTP client. Use scopes:

```text
read
library:write
preferences:write
feedback:write
generation
```

Store these settings in your MCP server's environment or secret configuration:

```text
READING_APP_URL=https://<project-ref>.supabase.co/functions/v1/api/v1
READING_APP_TOKEN=rap_<your-token>
```

The base URL is the Supabase API URL, not the GitHub Pages website URL. Each request sends
`Authorization: Bearer <READING_APP_TOKEN>`. JSON writes also send `Content-Type: application/json`.
Keep the token in the MCP server, rather than in tool arguments, descriptions, or results.
No Supabase service-role key or GitHub login cookie is needed.

Validate configuration with `GET /me`. Revocation is available through the website. Integration
tokens cannot permanently delete books/readings or manage credentials. The current database
labels token-origin actions `openclaw`, including calls from your Claude MCP server.

## Suggested tools

Tool names below are suggestions for your MCP wrapper; the HTTP endpoints are implemented.

| Suggested MCP tool | HTTP operation | Main inputs / result |
| --- | --- | --- |
| `get_discovery` | `GET /recommendations` | Optional `horizon`; optional `period` and `version` require horizon. Returns shelves, article records, rationales, IDs, and job status. |
| `get_discovery_archive` | `GET /recommendations/archive` | Optional horizon, limit, offset. Returns published/partial editions. |
| `get_recommendation` | `GET /recommendation-entries/{id}` | Recommendation entry ID. Returns the entry, article, and source edition. |
| `list_reading_queue` | `GET /readings` | Search `q`, `status`, `topic`, pagination. Discovery-only candidates are excluded by default. |
| `get_reading` | `GET /readings/{id}` | Reading ID. Returns the current record and version for edits. |
| `add_to_reading_queue` | `POST /readings` | `url` or `title`, optional notes/topics; `enrich:false` avoids metadata-fetch latency. |
| `update_reading` | `PATCH /readings/{id}` | ID, current version, notes or status. Supports `saved`, `reading`, `finished`, `archived`. |
| `save_recommendation` | `PATCH /recommendation-entries/{id}` | `{ "state": "saved" }`. Preserves the article's link to the edition. |
| `set_recommendation_state` | `PATCH /recommendation-entries/{id}` | `read`, `dismissed`, or `active`. `read` also marks the article finished. |
| `get_preferences` | `GET /preferences` | Returns interests, exclusions, feeds, reading lengths, time zone, and budget. |
| `add_interest` | `POST /preferences/interests` | `topic`, optional numeric weight 0–3. Existing unrelated interests are preserved. |
| `remove_interest` | `DELETE /preferences/interests/{topic}` | URL-encoded topic; optional version query parameter. |
| `update_preferences` | `PATCH /preferences` | Current version and selected settings. Useful for explicit exclusions or trusted feeds. Array fields replace their lists. |
| `list_books` | `GET /books` | Search/filter/sort/pagination; supports wishlist, reading, finished, stopped, unknown, and archived records. |
| `get_book` | `GET /books/{id}` | Includes reading sessions and current versions. |
| `add_book` | `POST /books` | Title, authors or `author_unknown:true`; optional status, dates, rating, topics, and notes. |
| `edit_book` | `PATCH /books/{id}` | ID, current version, changed fields. `archived:true` archives and `archived:false` restores. |
| `start_reading_session` | `POST /books/{id}/sessions` | Dates, rating, `session_status`; supports rereads. |
| `edit_reading_session` | `PATCH /reading-sessions/{id}` | Session ID/version, dates, rating, status, notes. |
| `give_feedback` | `POST /feedback` | Action, target ID, optional text/scope. A recommendation entry ID is sufficient to resolve article context. |
| `list_feedback` | `GET /feedback` | Optional reading/book ID and pagination. |
| `edit_feedback` / `remove_feedback` | `PATCH` / `DELETE /feedback/{id}` | Edit with a version; deletion excludes the event from future personalization. |
| `find_alternatives` | `POST /recommendation-jobs` | `kind:"alternatives"` and preferably `batch_id` from the displayed shelf. Returns job IDs. |
| `fill_discovery_gaps` | `POST /recommendation-jobs` | `kind:"fill_missing"` plus batch ID or horizon. Preserves the selected edition's existing picks. |
| `generate_discovery` | `POST /recommendation-jobs` | `kind:"initial"`, optional horizon. Omit horizon to queue all five. |
| `get_generation_job` / `list_generation_jobs` | `GET /jobs/{id}` / `GET /jobs` | Progress, failure details, and resulting batch ID on the detail endpoint. |
| `get_generation_config` | `GET /generation-config` | Provider readiness, models, estimates, spend/cap, and scheduler status. |

Additional data tools can wrap JSON export, book CSV export, and preview/commit import. Treat
import as a separate deliberate operation: it can add many records and update settings.

## Typical workflows

### Retrieve discovery and save an article

1. Call `GET /recommendations?horizon=weekly`.
2. Present `entries[].reading.title`, `canonical_url`, access classification, and the entry's
   `why_matters` / `why_fits`. Use the returned `window` when describing the edition.
3. Save the chosen **entry ID** using `PATCH /recommendation-entries/{id}` with
   `{ "state": "saved" }`.
4. Fetch the queue or article when you need its updated version.

IDs represent different things: `entry.id` identifies a recommendation card,
`entry.reading_id` identifies the article, and `batch.id` identifies the shelf edition.
The API returns metadata, descriptions, links, and recommendation rationale, not a full-text
article-reading endpoint. Fetching or opening the original is a separate client capability.

### Add an interest without replacing existing ones

```http
POST /preferences/interests
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: <unique-request-id>

{"topic":"History of science","weight":2}
```

Omit weight to use 1 for a new topic or preserve the weight of an existing topic. Matching is
case-insensitive and ignores repeated whitespace. To remove it, URL-encode the topic and send
`DELETE /preferences/interests/History%20of%20science`.

### Add and edit a book

Create with `POST /books`:

```json
{"title":"Example Book","authors":["Example Author"],"library_status":"want_to_read"}
```

Read the current book before editing, then send only changed fields with its version:

```json
{"version":3,"library_status":"finished","finished_on":null,"rating":8.5}
```

Dates may be unknown; do not invent them. A zero rating is valid and differs from unrated (`null`).
Book edits can update the latest reading session, and starting a finished book again preserves
the earlier session. Use session endpoints to edit a particular historical read.

### Find alternatives to a suggested edition

Read the shelf, then send:

```json
{"kind":"alternatives","batch_id":"<batch UUID from the shelf>"}
```

This creates a new version for that edition's original publication period, including if you are
viewing an archived edition. It regenerates the shelf's selections rather than replacing one
article in place. Earlier editions remain in the archive. To explain what should change, first
record explicit feedback such as `too_superficial` with the relevant recommendation entry ID.

Generation returns `202` with `jobs`, `warnings`, and `workerUrl`. Return the job ID promptly from
your MCP tool. Poll `GET /jobs/{id}` with a bounded timeout and modest interval; do not keep one
MCP request open indefinitely. When it succeeds, fetch
`GET /recommendations?horizon=<job.horizon>&period=<job.period_key>` to obtain the new edition.
If it fails, report `error`; queuing is not proof of successful generation. Jobs marked
`existing:true` reuse an active job and may have a different kind than requested.

The configured server-side model generates alternatives. Connecting Claude as an MCP client
does not change that ranker. Generation needs provider credentials and budget headroom and may
incur provider charges. Existing discovery retrieval and manual library operations do not need
new model generation.

## Request handling in your wrapper

- For supported POST operations, generate one `Idempotency-Key` per logical action and reuse
  the same key and request body on transport retries. Use a fresh key for a new user action.
- Before ordinary edits, retrieve the latest record and send `version`. On `409`, fetch it
  again and reconsider the change instead of blindly overwriting it.
- Follow list pagination (`limit`, `offset`, `total`). Defaults are bounded; a single response
  may not contain the entire library or archive.
- Return structured API errors (`error.code`, `error.message`, `requestId`) to the MCP caller.
- Keep ordinary results compact. Job detail includes checkpoints and candidate evidence;
  usually return status, stage, counts, cost, batch ID, and error rather than the full checkpoint.
