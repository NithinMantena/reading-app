-- Reading app: initial schema. All personal tables are owner-scoped with RLS.
-- The public frontend's anon key can only reach rows whose owner is the signed-in
-- GitHub user AND whose login matches app_owner. Edge Functions use the service
-- role and scope every query by owner_id explicitly.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Owner identity (single-user product)
-- ---------------------------------------------------------------------------
create table if not exists public.app_owner (
  id int primary key default 1 check (id = 1),
  github_login text not null,
  user_id uuid references auth.users (id),
  created_at timestamptz not null default now()
);
insert into public.app_owner (id, github_login) values (1, 'NithinMantena')
  on conflict (id) do nothing;

-- True when the current JWT belongs to the configured owner (GitHub login match).
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    lower(auth.jwt() -> 'user_metadata' ->> 'user_name') = lower((select github_login from public.app_owner where id = 1))
    or lower(auth.jwt() -> 'user_metadata' ->> 'preferred_username') = lower((select github_login from public.app_owner where id = 1)),
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.library_status as enum ('want_to_read', 'reading', 'finished', 'stopped');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.session_status as enum ('reading', 'finished', 'stopped');
exception when duplicate_object then null; end $$;

do $$ begin
  -- 'candidate' = surfaced by discovery but not yet saved; only explicit saves enter the queue.
  create type public.queue_status as enum ('candidate', 'saved', 'reading', 'finished', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.access_class as enum (
    'free_full_text', 'open_copy', 'nyt_subscription', 'preview_only', 'paywall', 'unknown'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.date_precision as enum ('day', 'month', 'year', 'unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.horizon as enum ('daily', 'weekly', 'monthly', 'yearly', 'decade');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.batch_status as enum ('pending', 'generating', 'published', 'partial', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.feedback_action as enum (
    'more_like_this', 'less_like_this', 'already_know', 'too_superficial', 'too_technical',
    'too_long', 'wrong_topic', 'unreliable_source', 'cannot_access', 'note', 'quality_rating'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.feedback_scope as enum ('item', 'topic', 'author', 'publisher');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.feedback_source as enum ('website', 'openclaw', 'import');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  new.version = coalesce(old.version, 0) + 1;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- User settings
-- ---------------------------------------------------------------------------
create table if not exists public.user_settings (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  time_zone text not null default 'UTC',
  language text not null default 'en',
  access_exceptions jsonb not null default '["nyt_subscription"]'::jsonb,
  interests jsonb not null default '[]'::jsonb,          -- [{topic, weight}]
  exclusions jsonb not null default '[]'::jsonb,         -- [{kind: topic|author|publisher, value}]
  length_preferences jsonb not null default '{"daily_max_minutes":20,"weekly_max_minutes":60}'::jsonb,
  budget jsonb not null default '{"monthly_cap_usd":0,"currency":"USD"}'::jsonb,
  onboarding_complete boolean not null default false,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger user_settings_touch before update on public.user_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Books and reading sessions
-- ---------------------------------------------------------------------------
create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  authors text[] not null default '{}',
  author_unknown boolean not null default false,
  isbn text,
  edition text,
  topics text[] not null default '{}',
  cover_url text,
  description text,
  recommended_by text,
  why_read text,
  notes text,
  library_status public.library_status not null default 'want_to_read',
  archived_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint books_author_required check (author_unknown or cardinality(authors) > 0)
);
create index if not exists books_owner_idx on public.books (owner_id, archived_at, library_status);
create index if not exists books_owner_isbn_idx on public.books (owner_id, isbn) where isbn is not null;
create trigger books_touch before update on public.books
  for each row execute function public.touch_updated_at();

create table if not exists public.reading_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  book_id uuid not null references public.books (id) on delete cascade,
  started_on date,
  finished_on date,
  status public.session_status not null default 'reading',
  rating numeric(3, 1) check (rating is null or (rating >= 0 and rating <= 10)),
  notes text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reading_sessions_dates check (started_on is null or finished_on is null or finished_on >= started_on)
);
create index if not exists reading_sessions_book_idx on public.reading_sessions (owner_id, book_id, created_at desc);
create trigger reading_sessions_touch before update on public.reading_sessions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Saved readings (articles, papers, essays, reports)
-- ---------------------------------------------------------------------------
create table if not exists public.reading_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  canonical_url text,
  original_url text,
  title text not null,
  authors text[] not null default '{}',
  publisher text,
  published_on date,
  published_precision public.date_precision not null default 'unknown',
  published_evidence jsonb not null default '{}'::jsonb,
  item_type text not null default 'article',
  access_class public.access_class not null default 'unknown',
  access_evidence jsonb not null default '{}'::jsonb,
  access_checked_at timestamptz,
  duration_minutes int check (duration_minutes is null or duration_minutes >= 0),
  topics text[] not null default '{}',
  notes text,
  description text,
  queue_status public.queue_status not null default 'saved',
  enrichment_status text not null default 'pending', -- pending | done | failed | manual
  recommendation_entry_id uuid,
  source_batch_id uuid,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reading_items_url_or_title check (canonical_url is not null or length(trim(title)) > 0)
);
create unique index if not exists reading_items_owner_url_uidx
  on public.reading_items (owner_id, canonical_url) where canonical_url is not null;
create index if not exists reading_items_owner_status_idx
  on public.reading_items (owner_id, queue_status, created_at desc);
create trigger reading_items_touch before update on public.reading_items
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Recommendations (populated in Phase 2; schema fixed now)
-- ---------------------------------------------------------------------------
create table if not exists public.recommendation_batches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  horizon public.horizon not null,
  period_key text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  window_label text not null,
  time_zone text not null,
  version int not null default 1,
  status public.batch_status not null default 'pending',
  status_reason text,
  target_count int not null,
  preference_version int,
  model jsonb not null default '{}'::jsonb,
  cost jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (owner_id, horizon, period_key, version)
);
create index if not exists recommendation_batches_current_idx
  on public.recommendation_batches (owner_id, horizon, published_at desc);

create table if not exists public.recommendation_entries (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.recommendation_batches (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  reading_id uuid not null references public.reading_items (id) on delete cascade,
  slot int not null,
  is_surprise boolean not null default false,
  why_matters text,
  why_fits text,
  evidence_depth text not null default 'abstract', -- full_text | excerpt | abstract
  ranking_evidence jsonb not null default '{}'::jsonb,
  previously_suggested boolean not null default false,
  state text not null default 'active', -- active | dismissed | saved | read
  created_at timestamptz not null default now(),
  unique (batch_id, slot)
);

-- ---------------------------------------------------------------------------
-- Feedback and derived preferences
-- ---------------------------------------------------------------------------
create table if not exists public.feedback_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  reading_id uuid references public.reading_items (id) on delete set null,
  book_id uuid references public.books (id) on delete set null,
  recommendation_entry_id uuid references public.recommendation_entries (id) on delete set null,
  action public.feedback_action not null,
  scope public.feedback_scope not null default 'item',
  text text,
  quality_rating numeric(3, 1) check (quality_rating is null or (quality_rating >= 0 and quality_rating <= 10)),
  topics text[] not null default '{}',
  publisher text,
  source public.feedback_source not null default 'website',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists feedback_events_owner_idx
  on public.feedback_events (owner_id, created_at desc) where deleted_at is null;
create trigger feedback_events_touch before update on public.feedback_events
  for each row execute function public.touch_updated_at();

create table if not exists public.preference_summaries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  version int not null,
  summary jsonb not null default '{}'::jsonb,
  explanation text,
  supporting_feedback_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (owner_id, version)
);

-- ---------------------------------------------------------------------------
-- Generation jobs
-- ---------------------------------------------------------------------------
create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null, -- initial | scheduled | alternatives | fill_missing
  horizon public.horizon not null,
  period_key text not null,
  batch_id uuid references public.recommendation_batches (id) on delete set null,
  status public.job_status not null default 'queued',
  stage text not null default 'queued',
  checkpoint jsonb not null default '{}'::jsonb,
  attempts int not null default 0,
  provider text,
  model text,
  prompt_version text,
  preference_version int,
  counts jsonb not null default '{}'::jsonb,
  cost jsonb not null default '{}'::jsonb,
  error text,
  requested_by public.feedback_source not null default 'website',
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists generation_jobs_owner_idx on public.generation_jobs (owner_id, created_at desc);
create unique index if not exists generation_jobs_active_period_uidx
  on public.generation_jobs (owner_id, horizon, period_key)
  where status in ('queued', 'running');

-- ---------------------------------------------------------------------------
-- Integration credentials (bot tokens) and idempotency
-- ---------------------------------------------------------------------------
create table if not exists public.integration_credentials (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  scopes text[] not null default '{read,library:write,feedback:write}',
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists integration_credentials_owner_idx on public.integration_credentials (owner_id);

create table if not exists public.idempotency_keys (
  owner_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  request_hash text not null,
  status int not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, key)
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'user_settings','books','reading_sessions','reading_items','recommendation_batches',
    'recommendation_entries','feedback_events','preference_summaries','generation_jobs',
    'integration_credentials','idempotency_keys'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_select', t);
    execute format(
      'create policy %I on public.%I for select using (owner_id = auth.uid() and public.is_owner())',
      t || '_owner_select', t
    );
  end loop;
end $$;

-- Browser writes for library tables normally go through the API, but owner writes are
-- also allowed directly so the app degrades gracefully if the function is unavailable.
do $$
declare t text;
begin
  foreach t in array array['user_settings','books','reading_sessions','reading_items','feedback_events'] loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_write', t);
    execute format(
      'create policy %I on public.%I for all using (owner_id = auth.uid() and public.is_owner()) with check (owner_id = auth.uid() and public.is_owner())',
      t || '_owner_write', t
    );
  end loop;
end $$;

alter table public.app_owner enable row level security;
drop policy if exists app_owner_read on public.app_owner;
create policy app_owner_read on public.app_owner for select using (true);

-- Hide token hashes from the browser: expose a metadata-only view.
create or replace view public.integration_credentials_public as
  select id, owner_id, name, token_prefix, scopes, expires_at, revoked_at, last_used_at, created_at
  from public.integration_credentials;

-- ---------------------------------------------------------------------------
-- Realtime: the website must reflect bot writes within five seconds.
-- ---------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.books;
  alter publication supabase_realtime add table public.reading_sessions;
  alter publication supabase_realtime add table public.reading_items;
  alter publication supabase_realtime add table public.recommendation_batches;
  alter publication supabase_realtime add table public.feedback_events;
  alter publication supabase_realtime add table public.generation_jobs;
exception when others then null;
end $$;

-- ---------------------------------------------------------------------------
-- View used for library listings (book + its most recent reading session)
-- ---------------------------------------------------------------------------
create or replace view public.books_with_latest_session as
select b.*,
  array_to_string(b.authors, ', ') as authors_text,
  s.id as session_id,
  s.started_on,
  s.finished_on,
  s.status as session_status,
  s.rating,
  s.notes as session_notes,
  s.version as session_version
from public.books b
left join lateral (
  select * from public.reading_sessions rs
  where rs.book_id = b.id
  order by rs.created_at desc
  limit 1
) s on true;
