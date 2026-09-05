import type { Handler } from "../index.ts";
import { ApiError } from "../../_shared/http.ts";
import { fromPgError, must, pageParams } from "../../_shared/db.ts";
import { HORIZONS, windowFor, type Horizon } from "../../_shared/periods.ts";
import { isUuid, optEnum } from "../../_shared/validate.ts";
import { loadSettings } from "./preferences.ts";

const KINDS = ["initial", "alternatives", "fill_missing", "scheduled"] as const;

/**
 * POST /v1/recommendation-jobs { kind, horizon? }
 * Queues generation work. The job record is the contract; the worker that executes
 * the retrieval/validation/ranking pipeline lands in Phase 2. Duplicate active jobs
 * for the same period are returned rather than re-created.
 */
export const create: Handler = async (ctx, _p, body) => {
  const settings = await loadSettings(ctx);
  const kind = optEnum(body.kind, "kind", KINDS) ?? "initial";
  const horizon = optEnum(body.horizon, "horizon", HORIZONS);
  if (kind !== "initial" && !horizon) throw new ApiError(422, "validation_failed", "horizon is required for this job kind");
  const list = horizon ? [horizon] : HORIZONS;

  const cap = Number((settings.budget as Record<string, unknown>).monthly_cap_usd ?? 0);
  const providerReady = Boolean(Deno.env.get("MODEL_PROVIDER"));
  const jobs = [];
  for (const h of list) {
    const w = windowFor(h as Horizon, new Date(), settings.time_zone);
    const row = {
      owner_id: ctx.ownerId, kind, horizon: h, period_key: w.periodKey, status: "queued", stage: "queued",
      requested_by: ctx.source, preference_version: null,
      checkpoint: { window: { start: w.startUtc.toISOString(), end: w.endUtc.toISOString(), label: w.label, timeZone: settings.time_zone } },
    };
    const ins = await ctx.db.from("generation_jobs").insert(row).select("*").single();
    if (ins.error?.code === "23505") {
      const existing = await ctx.db.from("generation_jobs").select("*").eq("owner_id", ctx.ownerId).eq("horizon", h).eq("period_key", w.periodKey).in("status", ["queued", "running"]).single();
      jobs.push({ ...must(existing), existing: true });
      continue;
    }
    if (ins.error) throw fromPgError(ins.error);
    jobs.push(ins.data);
  }
  const warnings: string[] = [];
  if (cap <= 0) warnings.push("Monthly spending cap is 0; jobs will wait until a budget is set in Preferences.");
  if (!providerReady) warnings.push("No model provider is configured yet; jobs are recorded and will run once Phase 2 generation is deployed.");
  return { status: 202, body: { jobs, warnings } };
};

export const get: Handler = async (ctx, p) => {
  if (!isUuid(p.id)) throw new ApiError(404, "not_found", "Job not found");
  const job = must(await ctx.db.from("generation_jobs").select("*").eq("owner_id", ctx.ownerId).eq("id", p.id).maybeSingle(), "Job");
  return { status: 200, body: job };
};

export const list: Handler = async (ctx, _p, _b, url) => {
  const { limit, offset } = pageParams(url, 50, 200);
  const res = await ctx.db.from("generation_jobs").select("*", { count: "exact" }).eq("owner_id", ctx.ownerId)
    .order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  if (res.error) throw fromPgError(res.error);
  return { status: 200, body: { items: res.data ?? [], total: res.count ?? 0, limit, offset } };
};
