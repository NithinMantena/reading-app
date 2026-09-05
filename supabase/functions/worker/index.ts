// Generation worker. Invoked every minute by pg_cron (task=step) and every ten minutes as
// the dispatcher (task=dispatch); also kicked directly by the API when the owner queues a job.
//
// Auth: either the shared secret held in private.app_config (cron -> worker), or an owner
// session / integration token with the generation scope.
import { authenticate, requireScope, serviceClient } from "../_shared/auth.ts";
import { ApiError, CORS_HEADERS, errorResponse, json } from "../_shared/http.ts";
import { claimJob, dispatch, runConfigFromEnv, runJob } from "../_shared/pipeline/runner.ts";

Deno.serve(async (req: Request) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  try {
    const url = new URL(req.url);
    const task = url.searchParams.get("task") ?? "step";
    const db = serviceClient();

    // Authorise
    const provided = req.headers.get("x-worker-secret");
    let authorised = false;
    if (provided) {
      const { data: secret } = await db.rpc("worker_secret");
      authorised = Boolean(secret) && provided === secret;
      if (!authorised) throw new ApiError(401, "bad_secret", "Worker secret mismatch");
    } else {
      const ctx = await authenticate(req, requestId);
      requireScope(ctx, "generation");
      authorised = true;
    }
    // Make sure cron knows where we live (idempotent).
    const self = `${Deno.env.get("SUPABASE_URL")}/functions/v1/worker`;
    db.rpc("register_worker_url", { p_url: self }).then(() => {});

    const cfg = runConfigFromEnv();
    const logs: string[] = [];
    const log = (s: string) => logs.push(s);

    if (task === "dispatch") {
      const result = await dispatch(db, log);
      if (result.created.length) db.rpc("worker_secret").then(({ data }) => data && fetch(`${self}?task=step`, { method: "POST", headers: { "x-worker-secret": data as string } }).catch(() => {}));
      return json({ ok: true, task, ...result, logs, requestId });
    }
    if (task === "step") {
      const started = Date.now();
      const results: unknown[] = [];
      // Process jobs until the time budget is spent.
      while (Date.now() - started < cfg.timeBudgetMs - 10_000) {
        const job = await claimJob(db);
        if (!job) break;
        const remaining = cfg.timeBudgetMs - (Date.now() - started);
        const r = await runJob(db, job, { ...cfg, timeBudgetMs: Math.max(15_000, remaining - 5_000) });
        results.push({ jobId: job.id, horizon: job.horizon, period: job.period_key, ...r });
        if (r.status === "queued" && r.stage !== "done") break; // out of time on this job; let the next tick continue
      }
      return json({ ok: true, task, processed: results, logs, requestId });
    }
    if (task === "config") {
      return json({ ok: true, provider: cfg.anthropicKey ? "anthropic" : null, ranker: cfg.rankerModel, classifier: cfg.classifierModel, search: cfg.exaKey ? "exa" : cfg.braveKey ? "brave" : "free-sources-only", requestId });
    }
    throw new ApiError(400, "bad_task", `Unknown task '${task}'`);
  } catch (err) {
    return errorResponse(err, requestId);
  }
});
