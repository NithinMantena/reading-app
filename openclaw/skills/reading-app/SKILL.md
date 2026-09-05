---
name: reading-app
description: Manage Nithin's personal reading app (books read, wishlist, saved readings, discovery shelves, feedback) through its authenticated API.
homepage: https://github.com/NithinMantena/reading-app
metadata: {"clawdbot":{"emoji":"📖","requires":{"bins":["node"]},"install":[{"id":"clone","kind":"shell","command":"git clone https://github.com/NithinMantena/reading-app ~/.openclaw/workspace/reading-app","label":"Clone the reading-app repository"}]}}
---

# Reading app

A personal reading home hosted at https://nithinmantena.github.io/reading-app/. This skill
drives it through the CLI at `reading-app/bot/reading.mjs`, which calls the app's `/v1` API
with an owner-issued integration token. All writes go through the same rules as the website,
so anything you change appears there within seconds.

## Setup (once)

1. Nithin creates a token in the website under Preferences → OpenClaw integration.
2. Run `node <repo>/bot/reading.mjs configure --url "<api base>" --token "rap_..."`.
   The token is stored in `~/.config/reading-app/config.json` (mode 600). Never print it back.
3. `node <repo>/bot/reading.mjs me` confirms the connection and reports the configured time zone.

Every command below is `node <repo>/bot/reading.mjs …` and prints one JSON object. Add `--pretty`
only when showing raw output to a person.

## Rules

- **Resolve before mutating.** "That book" or "this article" must map to one record. Search first
  (`books list --q "…"`, `readings list --q "…"`). If several match, ask which one; do not guess.
- **Never invent dates.** Use `today`, `yesterday`, `"N days ago"`, `YYYY-MM-DD`, or `unknown`.
  Dates are resolved in the app's configured time zone, not the machine's.
- **Report success only after the command returns.** The CLI exits non-zero and prints
  `{"ok":false,...}` on failure. A `409` means the record changed elsewhere: re-read and retry once.
- **Duplicates are handled server-side.** `books add` and `readings add` return the existing record
  with `"existing": true` instead of creating a copy. Say so rather than claiming a new item.
- Ratings are 0–10 with one decimal; blank means unrated and is different from 0.
- Permanent deletion is not available to the bot by design. Use `--archive`.
- Do not paste article text or private notes into chat unless asked; summarise.

## Commands by intent

| Nithin says | Run |
| --- | --- |
| "Add this URL to my reading list." | `readings add "<url>" [--notes "…"]` → reply with `title` and `app_link` |
| "Add this book to my wishlist." | `books add --title "…" --author "…"` (if author unknown: `--author-unknown`) |
| "I started this book yesterday." | `books list --q "…"` → `books start <id> --on yesterday` |
| "I finished this book; give it 8.5." | `books finish <id> --rating 8.5 [--on today]` |
| "I stopped reading it." | `books stop <id>` |
| "I'm reading it again." | `books reread <id> --on today` |
| "Show me this week's readings." | `recs --horizon weekly` → present titles, publishers, the exact period label, and access badges |
| "What's on the daily / monthly / yearly / decade list?" | `recs --horizon daily` etc. |
| "That article was too superficial; find deeper work." | `feedback add --action too_superficial --reading <id> [--text "…"]` |
| "Less of this publisher." | `feedback add --action less_like_this --scope publisher --reading <id>` |
| "What do you think I like reading?" | `prefs summary` → explain explicit interests and the derived summary |
| "Find alternatives for the yearly list." | `jobs create --kind alternatives --horizon yearly` → report the job id and that it runs within the configured budget |
| "Is the job done?" | `jobs get <id>` |
| "Export my reading data." | `export --out reading-export.json` |
| "Import this file." | `import <file.json>` to preview, then `import <file.json> --commit` after confirming the counts |
| "What is generation costing / is the scheduler running?" | `config` → provider, models, month-to-date spend vs cap, cron status |
| "Compare models on the weekly shelf." | `jobs create --kind model_comparison --horizon weekly` → results in `jobs get <id>` under `checkpoint.comparison` |

Feedback actions: `more_like_this`, `less_like_this`, `already_know`, `too_superficial`,
`too_technical`, `too_long`, `wrong_topic`, `unreliable_source`, `cannot_access`, `note`,
`quality_rating` (with `--rating`). Scopes for `less_like_this`: `item`, `topic`, `author`, `publisher`.

## Useful options

- `books add`: `--status want_to_read|reading|finished|stopped`, `--started`, `--finished`, `--rating`, `--topics "a,b"`, `--isbn`, `--why "…"`, `--recommended-by "…"`
- `books update <id>`: any of the above plus `--notes`, `--archive`, `--restore`, `--session-notes "what stayed with me"`
- `readings update <id>`: `--status saved|reading|finished`, `--notes`, `--archive`, `--restore`, `--access free_full_text|nyt_subscription|…`
- `recs archive --horizon daily` lists earlier editions; `recs --horizon weekly --period 2026-W35` fetches a specific one.
- `--idempotency-key <k>` pins a create so a retried command cannot duplicate.

## Reporting back

Keep replies short: what changed, the record's title, and its `app_link`. When a shelf is
returned, always include the period label (e.g. "published August 24 – 30, 2026") so an older
list is never mistaken for today's.
