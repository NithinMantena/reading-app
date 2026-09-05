# OpenClaw integration

The local OpenClaw bot manages the app through the same `/v1` API the website uses. It makes
outbound HTTPS requests only; nothing connects into the local machine, and the website keeps
working while the computer is off.

## Components

- `bot/reading.mjs` — dependency-free Node CLI wrapping the API. Prints one JSON object per call.
- `openclaw/skills/reading-app/SKILL.md` — the skill that teaches the agent when and how to run it.

## Install the skill

The installed OpenClaw (2026.6.5 at the time of writing) loads workspace skills from
`~/.openclaw/workspace/skills/<name>/SKILL.md`. Copy or link the skill folder there:

```bash
mkdir -p ~/.openclaw/workspace/skills
cp -r openclaw/skills/reading-app ~/.openclaw/workspace/skills/reading-app
```

On Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.openclaw\workspace\skills" | Out-Null
Copy-Item -Recurse -Force .\openclaw\skills\reading-app "$env:USERPROFILE\.openclaw\workspace\skills\reading-app"
```

The skill refers to the CLI by repository path; keep the repository cloned somewhere stable
(this vault's `Apps/Book List/reading-app` is fine) and tell the bot that path once.

## Configure the token

1. In the website: *Preferences → OpenClaw integration → Create token*. Copy it; it is shown once.
2. Run:

```bash
node bot/reading.mjs configure --url "https://<ref>.supabase.co/functions/v1/api/v1" --token "rap_…"
```

The token is written to `~/.config/reading-app/config.json` with owner-only permissions.
Alternatively set `READING_APP_URL` and `READING_APP_TOKEN` in the bot's environment.

Revoke from the website at any time; the next bot request fails with `401 token_revoked`.

## Default scopes

`read`, `library:write`, `feedback:write`, `preferences:write`, `generation`.
Permanent deletion (`admin`) is deliberately unavailable to the bot.

## Try it

```bash
node bot/reading.mjs me --pretty
node bot/reading.mjs books add --title "The Sleepwalkers" --author "Christopher Clark" --pretty
node bot/reading.mjs readings add "https://example.org/some-essay" --notes "sent by A." --pretty
node bot/reading.mjs recs --horizon weekly --pretty
```

Every create sends an `Idempotency-Key`, so a retried command cannot duplicate a record. Every
update reads the record first and sends its `version`, so a simultaneous website edit produces a
`409` rather than a silent overwrite.
