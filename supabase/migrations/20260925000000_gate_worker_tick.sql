-- Only wake the generation worker when a job is waiting.
--
-- pg_cron still fires reading-worker-step every minute, but the check below runs
-- inside the database. When the queue is empty no HTTP call is made, so the worker
-- function, its secret/URL RPCs and the job claim never run. Those idle calls were
-- ~1,400 invocations a day of Supabase log ingestion (free plan: 1 GB/month).
--
-- The predicate matches claim_generation_job(): a queued job (new, or one that ran
-- out of time mid-edition and was left queued for the next tick), or a running job
-- whose lock is older than 10 minutes (worker crashed). New jobs are still kicked
-- immediately by the API; this tick continues and recovers them.
create or replace function public.worker_has_work()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.generation_jobs
     where status = 'queued'
        or (status = 'running' and locked_at < now() - interval '10 minutes')
  );
$$;
revoke all on function public.worker_has_work() from public, anon, authenticated;
grant execute on function public.worker_has_work() to service_role, postgres;

do $$
declare r record;
begin
  for r in select jobid from cron.job where jobname = 'reading-worker-step' loop
    perform cron.unschedule(r.jobid);
  end loop;
  perform cron.schedule('reading-worker-step', '* * * * *',
    $cmd$ select public.trigger_worker('step') where public.worker_has_work() $cmd$);
exception when others then
  raise notice 'cron scheduling skipped: %', sqlerrm;
end $$;
