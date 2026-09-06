# Deployment guide

The app is a static site on GitHub Pages backed by a Supabase project. Nothing here is
provisioned automatically; these are the one-time steps. Budget about 30 minutes.

## 1. Create the Supabase project

1. Sign in at https://supabase.com/dashboard and create a project (any region; the free plan works
   for Phase 1). Save the **database password** you choose.
2. From *Project Settings → API* copy:
   - Project URL (`https://<ref>.supabase.co`)
   - `anon` public key
   - Project reference id (`<ref>`)
3. Check the plan's backup capability before relying on it (*Project Settings → Database → Backups*).
   Free plans have no point-in-time recovery; schedule the JSON export from Preferences instead.

## 2. Create the GitHub OAuth app

1. GitHub → *Settings → Developer settings → OAuth Apps → New OAuth App*.
   - Homepage URL: `https://nithinmantena.github.io/reading-app/`
   - Authorization callback URL: `https://<ref>.supabase.co/auth/v1/callback`
2. Copy the client id and generate a client secret.
3. Supabase → *Authentication → Providers → GitHub*: enable, paste client id and secret.
4. Supabase → *Authentication → URL Configuration*:
   - Site URL: `https://nithinmantena.github.io/reading-app/`
   - Additional redirect URLs: `https://nithinmantena.github.io/reading-app/**` and `http://localhost:5173/**`

Only the GitHub account whose login matches `app_owner.github_login` (seeded as `NithinMantena`)
can read or write data. Anyone else can sign in and will be told the app is private.

## 3. Apply the schema and deploy the API

Option A — GitHub Actions (no local CLI needed):

1. Repository → *Settings → Secrets and variables → Actions*.
   - Secrets: `SUPABASE_ACCESS_TOKEN` (from https://supabase.com/dashboard/account/tokens),
     `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`.
   - Variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
2. Run the **Deploy backend (Supabase)** workflow from the Actions tab. It pushes
   `supabase/migrations` and deploys the `api` function with JWT verification disabled
   (the function verifies sessions and integration tokens itself).

Option B — local CLI:

```bash
npx supabase login
npx supabase link --project-ref <ref>
npx supabase db push
npx supabase functions deploy api --no-verify-jwt
```

Then set the function's optional configuration (either way):

```bash
npx supabase secrets set APP_URL=https://nithinmantena.github.io/reading-app OWNER_GITHUB_LOGIN=NithinMantena
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase
automatically. Never put the service role key anywhere in this repository.

## 4. Enable GitHub Pages

Repository → *Settings → Pages → Source: GitHub Actions*. The **Build and deploy site** workflow
runs on every push to `main`, runs the tests, builds with the two `VITE_*` variables, refuses to
publish if anything secret-looking appears in the bundle, and deploys to
`https://nithinmantena.github.io/reading-app/`.

## 5. First sign-in

Open the site, sign in with GitHub, confirm the time zone, add interests. Then in
*Preferences → OpenClaw integration* create a token and configure the bot (see `docs/OPENCLAW.md`).

## Local development

```bash
cp .env.example .env      # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev               # http://localhost:5173
npm test                  # period and URL unit tests
```

Local Edge Function development needs Docker and `npx supabase start`; the hosted function is
usually simpler for a single-user app.

## Enabling generation (Phase 2)

1. Add repository secrets (Settings → Secrets and variables → Actions), or from a terminal with
   the GitHub CLI, which prompts for the value so it never lands in shell history:

   ```bash
   gh secret set ANTHROPIC_API_KEY --repo NithinMantena/reading-app
   ```

   - `ANTHROPIC_API_KEY` (required) from https://console.anthropic.com/settings/keys
   - `EXA_API_KEY` (recommended for daily/weekly quality) from https://dashboard.exa.ai
   - `BRAVE_API_KEY` (optional alternative), `OPENALEX_MAILTO` (optional, your email for polite-pool access)
2. Run the **Deploy backend (Supabase)** workflow (Actions tab → *Deploy backend (Supabase)* →
   *Run workflow*, or `gh workflow run supabase.yml`). It forwards whichever of those secrets are
   present to the functions and deploys both `api` and `worker`. The migration also enables
   `pg_cron` and `pg_net` and schedules the dispatcher and worker ticks. Adding a secret alone
   does nothing until this workflow runs.

   Alternative without GitHub: `npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...` after
   `npx supabase link`. Functions pick up new secrets on their next invocation.
3. In the app, Preferences → Generation budget: set a monthly cap above 0 and check the
   Services and rates table shows the provider and the two cron jobs.
4. Discover → Generate first editions. Progress shows per shelf; details in Preferences → Generation runs.

Details, costs, and operating notes: `docs/GENERATION.md`.

## Seeding from the spreadsheet export

`npm run seed -- <seed.md> <out.json> [<unresolved.md>]` converts the "Application Seed Data"
markdown into the import format. Keep the output outside the public repository (it is reading
history). Import it in Preferences → Your data → Import JSON (preview first), or with the bot:
`node bot/reading.mjs import <out.json>` to preview and `--commit` to apply.
