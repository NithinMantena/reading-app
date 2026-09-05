-- Phase 2: discovery pipeline scheduling, import provenance, and an honest "unknown" status.

-- ---------------------------------------------------------------------------
-- 1. "unknown" completion status (imported history often lacks dates)
-- ---------------------------------------------------------------------------
alter type public.library_status add value if not exists 'unknown';
alter type public.session_status add value if not exists 'unknown';

-- ---------------------------------------------------------------------------
-- 2. Import provenance (never mixed into the user's own notes)
-- ---------------------------------------------------------------------------
alter table public.books add column if not exists import_source jsonb;
alter table public.reading_sessions add column if not exists import_source jsonb;
alter table public.reading_items add column if not exists import_source jsonb;

-- ---------------------------------------------------------------------------
-- 3. Explicit sources (RSS/Atom feeds the owner trusts) for retrieval
-- ---------------------------------------------------------------------------
alter table public.user_settings add column if not exists sources jsonb not null default '[]'::jsonb; -- [{url, label}]

-- ---------------------------------------------------------------------------
-- 4. Private configuration for the scheduler (not exposed through the API)
-- ---------------------------------------------------------------------------
create schema if not exists private;
create table if not exists private.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
-- A random shared secret for cron -> worker calls. Generated here, never written to any file.
insert into private.app_config (key, value)
  values ('worker_secret', encode(gen_random_bytes(32), 'hex'))
  on conflict (key) do nothing;

-- Service-role-only helpers (revoked from anon/authenticated so PostgREST cannot call them).
create or replace function public.worker_secret()
returns text language sql security definer set search_path = public, private as $$
  select value from private.app_config where key = 'worker_secret';
$$;
revoke all on function public.worker_secret() from public, anon, authenticated;

create or replace function public.register_worker_url(p_url text)
returns void language sql security definer set search_path = public, private as $$
  insert into private.app_config (key, value) values ('worker_url', p_url)
  on conflict (key) do update set value = excluded.value, updated_at = now();
$$;
revoke all on function public.register_worker_url(text) from public, anon, authenticated;

-- Atomically claim one runnable job (queued, or running but stale for 10 minutes).
create or replace function public.claim_generation_job()
returns setof public.generation_jobs language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from public.generation_jobs
   where status = 'queued' or (status = 'running' and locked_at < now() - interval '10 minutes')
   order by created_at limit 1
   for update skip locked;
  if v_id is null then return; end if;
  return query
    update public.generation_jobs set status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
     where id = v_id returning *;
end $$;
revoke all on function public.claim_generation_job() from public, anon, authenticated;

-- Scheduler visibility for the settings page.
create or replace function public.scheduler_status()
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare result jsonb;
begin
  begin
    select jsonb_build_object(
      'workerRegistered', exists (select 1 from private.app_config where key = 'worker_url'),
      'jobs', coalesce((select jsonb_agg(jsonb_build_object('name', j.jobname, 'schedule', j.schedule, 'active', j.active,
                 'lastRun', (select jsonb_build_object('status', d.status, 'started', d.start_time, 'message', left(d.return_message, 200))
                             from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1)))
               from cron.job j where j.jobname like 'reading-%'), '[]'::jsonb)
    ) into result;
  exception when others then
    result := jsonb_build_object('workerRegistered', exists (select 1 from private.app_config where key = 'worker_url'), 'jobs', '[]'::jsonb, 'error', sqlerrm);
  end;
  return result;
end $$;
revoke all on function public.scheduler_status() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Cron: a frequent dispatcher (due periods in the owner's zone) and a worker tick.
--    Both call the worker Edge Function over pg_net with the shared secret.
-- ---------------------------------------------------------------------------
do $$ begin
  create extension if not exists pg_cron with schema pg_catalog;
exception when others then
  raise notice 'pg_cron not enabled here: %', sqlerrm;
end $$;
do $$ begin
  create extension if not exists pg_net with schema extensions;
exception when others then
  begin
    create extension if not exists pg_net;
  exception when others then
    raise notice 'pg_net not enabled here: %', sqlerrm;
  end;
end $$;

create or replace function public.trigger_worker(p_task text)
returns void language plpgsql security definer set search_path = public, private, net as $$
declare v_url text; v_secret text;
begin
  select value into v_url from private.app_config where key = 'worker_url';
  select value into v_secret from private.app_config where key = 'worker_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(
    url := v_url || '?task=' || p_task,
    body := '{}'::jsonb,
    headers := jsonb_build_object('content-type', 'application/json', 'x-worker-secret', v_secret),
    timeout_milliseconds := 8000
  );
end $$;
revoke all on function public.trigger_worker(text) from public, anon, authenticated;

-- The Edge Functions call these with the service role; make that grant explicit.
grant execute on function public.worker_secret() to service_role;
grant execute on function public.register_worker_url(text) to service_role;
grant execute on function public.claim_generation_job() to service_role;
grant execute on function public.scheduler_status() to service_role;
grant execute on function public.trigger_worker(text) to service_role, postgres;

do $$
declare r record;
begin
  for r in select jobid from cron.job where jobname in ('reading-worker-step', 'reading-dispatch') loop
    perform cron.unschedule(r.jobid);
  end loop;
  perform cron.schedule('reading-worker-step', '* * * * *', $cmd$ select public.trigger_worker('step') $cmd$);
  perform cron.schedule('reading-dispatch', '*/10 * * * *', $cmd$ select public.trigger_worker('dispatch') $cmd$);
exception when others then
  raise notice 'cron scheduling skipped: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Recreate the library view so it picks up the new column
-- ---------------------------------------------------------------------------
drop view if exists public.books_with_latest_session;
create view public.books_with_latest_session as
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
  order by rs.created_at desc, rs.id desc
  limit 1
) s on true;
