// Stage machine: advance one job through its stages within a wall-clock budget, checkpointing
// after every stage so a later invocation can resume exactly where this one stopped.
import type { SupabaseClient } from "@supabase/supabase-js";
import { TARGET_COUNTS, allWindows, localDateOf, type Horizon } from "../periods.ts";
import { monthlySpend, RUN_ESTIMATE_USD } from "./budget.ts";
import { compose } from "./compose.ts";
import { loadContext } from "./context.ts";
import { makeAdapter, type ModelAdapter } from "./model.ts";
import { publish } from "./publish.ts";
import { retrieve } from "./retrieve.ts";
import { assess, validateBatch } from "./validate.ts";
import { emptyLedger, type Checkpoint, type JobRow, type RunConfig, type Stage } from "./types.ts";

export function runConfigFromEnv(): RunConfig {
  return {
    rankerModel: Deno.env.get("RANKER_MODEL") ?? "claude-opus-5",
    classifierModel: Deno.env.get("CLASSIFIER_MODEL") ?? "claude-haiku-4-5",
    anthropicKey: Deno.env.get("ANTHROPIC_API_KEY") || undefined,
    exaKey: Deno.env.get("EXA_API_KEY") || undefined,
    braveKey: Deno.env.get("BRAVE_API_KEY") || undefined,
    openAlexMailto: Deno.env.get("OPENALEX_MAILTO") || undefined,
    maxCandidates: Number(Deno.env.get("MAX_CANDIDATES") ?? 70),
    maxFetches: Number(Deno.env.get("MAX_FETCHES") ?? 80),
    fetchConcurrency: 6,
    timeBudgetMs: Number(Deno.env.get("WORKER_TIME_BUDGET_MS") ?? 95_000),
  };
}

const TRANSIENT = /timeout|timed out|ECONN|network|rate limit|429|5\d\d|overloaded|temporar/i;
const MAX_ATTEMPTS = 4;

export async function claimJob(db: SupabaseClient): Promise<JobRow | null> {
  const { data, error } = await db.rpc("claim_generation_job");
  if (error) throw new Error(`claim failed: ${error.message}`);
  const rows = (data ?? []) as JobRow[];
  return rows[0] ?? null;
}

async function save(db: SupabaseClient, job: JobRow, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("generation_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", job.id);
  if (error) throw new Error(`job save failed: ${error.message}`);
}

function nextStage(s: Stage): Stage {
  const order: Stage[] = ["queued", "context", "retrieve", "validate", "assess", "rank", "compose", "publish", "done"];
  return order[Math.min(order.indexOf(s) + 1, order.length - 1)];
}

/** Run as many stages as fit in the time budget. Returns the job's final state for this tick. */
export async function runJob(db: SupabaseClient, job: JobRow, cfg: RunConfig): Promise<{ status: string; stage: Stage; message: string }> {
  const started = Date.now();
  const deadline = started + cfg.timeBudgetMs;
  const cp: Checkpoint = job.checkpoint && job.checkpoint.log ? job.checkpoint : { ...(job.checkpoint ?? {}), log: [], cost: emptyLedger() } as Checkpoint;
  cp.cost ??= emptyLedger();
  cp.log ??= [];
  const log = (s: string) => { cp.log.push(`${new Date().toISOString().slice(11, 19)} ${s}`); if (cp.log.length > 200) cp.log.splice(0, cp.log.length - 200); };
  const horizon = job.horizon as Horizon;
  let stage: Stage = job.stage === "queued" ? "context" : job.stage;
  const adapter: ModelAdapter | null = makeAdapter(cfg);

  const persist = (extra: Record<string, unknown> = {}) => save(db, job, {
    stage, checkpoint: cp, cost: { actualUsd: cp.cost.actualUsd, estimatedUsd: cp.cost.estimatedUsd, calls: cp.cost.calls.length, fetches: cp.cost.fetches, searches: cp.cost.searches },
    counts: { candidates: cp.candidates?.length ?? 0, valid: cp.candidates?.filter((c) => c.status === "valid").length ?? 0, selected: cp.composed?.slots.length ?? 0 },
    provider: adapter?.name ?? null, model: cfg.rankerModel, prompt_version: cp.ranking?.promptVersion ?? null, preference_version: cp.context?.preferenceVersion ?? null,
    ...extra,
  });

  try {
    while (stage !== "done" && Date.now() < deadline) {
      switch (stage) {
        case "context": {
          if (!adapter) throw new Error("No model provider configured (set ANTHROPIC_API_KEY). Job cannot run.");
          const ctx = await loadContext(db, job.owner_id, horizon, job.period_key, job.kind);
          cp.context = ctx;
          const { data: settings } = await db.from("user_settings").select("budget").eq("owner_id", job.owner_id).single();
          const cap = Number((settings?.budget as { monthly_cap_usd?: number })?.monthly_cap_usd ?? 0);
          const spent = await monthlySpend(db, job.owner_id);
          const estimate = RUN_ESTIMATE_USD[horizon] ?? 0.6;
          cp.cost.estimatedUsd = estimate;
          if (cap <= 0) throw new Error("Monthly spending cap is 0. Set a budget in Preferences to enable generation.");
          if (spent + estimate > cap) throw new Error(`Budget: $${spent.toFixed(2)} spent this month + ~$${estimate.toFixed(2)} estimated exceeds the $${cap.toFixed(2)} cap. Generation paused until next month or a higher cap.`);
          log(`context loaded: ${ctx.interests.length} interests, ${ctx.feedback.length} feedback events, ${ctx.surfacedSameHorizon.length} already surfaced; budget $${spent.toFixed(2)}/$${cap.toFixed(2)}`);
          break;
        }
        case "retrieve": {
          cp.candidates = await retrieve(cp, horizon, cfg, adapter, log);
          cp.cursor = 0;
          if (!cp.candidates.length) log("no candidates retrieved");
          break;
        }
        case "validate": {
          const done = await validateBatch(cp, horizon, cfg, deadline - 5000, log);
          if (!done) { await persist(); return { status: "running", stage, message: `validating ${cp.cursor}/${cp.candidates?.length}` }; }
          break;
        }
        case "assess": {
          await assess(cp, adapter, log);
          break;
        }
        case "rank": {
          const valid = (cp.candidates ?? []).filter((c) => c.status === "valid");
          if (!valid.length) {
            cp.ranking = { model: cfg.rankerModel, promptVersion: "n/a", selections: [], rejected: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, batchNote: "No candidates passed date and access checks." };
            log("rank skipped: nothing valid");
            break;
          }
          if (job.kind === "model_comparison") {
            const models = [cfg.rankerModel, Deno.env.get("COMPARISON_MODEL") ?? "claude-sonnet-5"];
            cp.comparison = [];
            for (const m of models) cp.comparison.push(await adapter!.rank({ horizon, windowLabel: cp.window.label, targetCount: TARGET_COUNTS[horizon], context: cp.context!, candidates: cp.candidates!, ledger: cp.cost }, m));
            cp.ranking = cp.comparison[0];
            log(`comparison ran on ${models.join(" vs ")}`);
          } else {
            cp.ranking = await adapter!.rank({ horizon, windowLabel: cp.window.label, targetCount: TARGET_COUNTS[horizon], context: cp.context!, candidates: cp.candidates!, ledger: cp.cost });
          }
          log(`ranked: ${cp.ranking.selections.length} selections, $${cp.ranking.costUsd.toFixed(3)}`);
          break;
        }
        case "compose": {
          const keep = cp.context?.keepEntries?.length ?? 0;
          const target = Math.max(0, TARGET_COUNTS[horizon] - keep);
          const keepHasSurprise = (cp.context?.keepEntries ?? []).some((k) => k.is_surprise);
          cp.composed = compose(cp.ranking!.selections, cp.candidates ?? [], target, cp.context!, { allowSurprise: !keepHasSurprise });
          log(`composed: ${cp.composed.slots.length}/${target}${cp.composed.statusReason ? ` (${cp.composed.statusReason})` : ""}`);
          break;
        }
        case "publish": {
          if (job.kind === "model_comparison") { log("comparison job: nothing published"); break; }
          if (!cp.composed?.slots.length && !(cp.context?.keepEntries?.length)) {
            // Nothing to publish; still record a partial batch so the shelf explains itself.
          }
          cp.batchId = await publish(db, job, cp, horizon, log);
          break;
        }
        default:
          break;
      }
      stage = nextStage(stage);
      await persist();
    }
    if (stage === "done") {
      await persist({ status: "succeeded", finished_at: new Date().toISOString(), batch_id: cp.batchId ?? null, error: null, locked_at: null });
      return { status: "succeeded", stage, message: cp.log.at(-1) ?? "done" };
    }
    // Out of time: release the lock so the next tick continues.
    await persist({ status: "queued", locked_at: null });
    return { status: "queued", stage, message: "time budget reached; will resume" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`error at ${stage}: ${msg}`);
    const transient = TRANSIENT.test(msg) && job.attempts < MAX_ATTEMPTS;
    await persist({ status: transient ? "queued" : "failed", error: msg, locked_at: null, finished_at: transient ? null : new Date().toISOString() });
    return { status: transient ? "queued" : "failed", stage, message: msg };
  }
}

/** Dispatcher: create scheduled jobs for periods that are due and have no edition yet. */
export async function dispatch(db: SupabaseClient, log: (s: string) => void): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  const { data: owners } = await db.from("user_settings").select("owner_id, time_zone, onboarding_complete, budget");
  for (const o of owners ?? []) {
    const cap = Number((o.budget as { monthly_cap_usd?: number })?.monthly_cap_usd ?? 0);
    if (!o.onboarding_complete || cap <= 0) { skipped.push(`${o.owner_id}: onboarding/budget`); continue; }
    const now = new Date();
    const windows = allWindows(now, o.time_zone);
    // Target 07:00 local: only dispatch once the local hour has reached 7.
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: o.time_zone, hour: "numeric", hourCycle: "h23" }).format(now));
    if (hour < 7) { skipped.push(`${o.owner_id}: before 07:00 local`); continue; }
    for (const [h, w] of Object.entries(windows)) {
      const { data: batch } = await db.from("recommendation_batches").select("id").eq("owner_id", o.owner_id).eq("horizon", h).eq("period_key", w.periodKey).in("status", ["published", "partial"]).limit(1).maybeSingle();
      if (batch) continue;
      const { data: job } = await db.from("generation_jobs").select("id, status").eq("owner_id", o.owner_id).eq("horizon", h).eq("period_key", w.periodKey).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (job && (job.status === "queued" || job.status === "running")) continue;
      if (job && job.status === "failed") {
        // Do not retry a failed period more than once per local day.
        const { data: recent } = await db.from("generation_jobs").select("created_at").eq("owner_id", o.owner_id).eq("horizon", h).eq("period_key", w.periodKey).order("created_at", { ascending: false }).limit(1).single();
        if (recent && localDateOf(new Date(recent.created_at), o.time_zone).day === localDateOf(now, o.time_zone).day) { skipped.push(`${h}/${w.periodKey}: failed today`); continue; }
      }
      const ins = await db.from("generation_jobs").insert({
        owner_id: o.owner_id, kind: "scheduled", horizon: h, period_key: w.periodKey, status: "queued", stage: "queued", requested_by: "website",
        checkpoint: { window: { start: w.startUtc.toISOString(), end: w.endUtc.toISOString(), label: w.label, timeZone: o.time_zone, periodKey: w.periodKey }, log: [], cost: emptyLedger() },
      }).select("id").single();
      if (!ins.error) created.push(`${h}/${w.periodKey}`);
      else if (ins.error.code !== "23505") log(`dispatch insert failed: ${ins.error.message}`);
    }
  }
  return { created, skipped };
}
