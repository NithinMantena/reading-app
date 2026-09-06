import type { Handler } from "../index.ts";
import { ApiError } from "../../_shared/http.ts";
import { fromPgError, must, pageParams } from "../../_shared/db.ts";
import { HORIZONS, TARGET_COUNTS, windowFor, type Horizon } from "../../_shared/periods.ts";
import { isUuid, optEnum } from "../../_shared/validate.ts";
import { loadSettings } from "./preferences.ts";

const ENTRY_STATES = ["active", "dismissed", "saved", "read"] as const;

/**
 * GET /v1/recommendations?horizon=weekly[&period=2026-W35][&version=2]
 * Without a horizon, returns the current edition (or pending state) of every shelf.
 */
export const get: Handler = async (ctx, _p, _b, url) => {
  const settings = await loadSettings(ctx);
  const horizon = optEnum(url.searchParams.get("horizon") ?? undefined, "horizon", HORIZONS);
  const period = url.searchParams.get("period");
  const version = url.searchParams.get("version");
  const list = horizon ? [horizon] : HORIZONS;
  const now = new Date();
  // All shelves are independent, so resolve them concurrently: two round trips in total
  // instead of three per shelf in sequence.
  const shelves = await Promise.all(list.map(async (h) => {
    const w = windowFor(h as Horizon, now, settings.time_zone);
    const periodKey = period ?? w.periodKey;
    // Only published/partial editions are ever shown as "the" edition; failed runs stay in jobs.
    let q = ctx.db.from("recommendation_batches").select("*").eq("owner_id", ctx.ownerId).eq("horizon", h).eq("period_key", periodKey).in("status", ["published", "partial"]);
    q = version ? q.eq("version", Number(version)) : q.order("version", { ascending: false });
    const [batchRes, jobRes] = await Promise.all([
      q.limit(1).maybeSingle(),
      ctx.db
        .from("generation_jobs").select("id, status, stage, error, attempts, updated_at, created_at, kind")
        .eq("owner_id", ctx.ownerId).eq("horizon", h).eq("period_key", periodKey).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (batchRes.error) throw fromPgError(batchRes.error);
    const batch = batchRes.data;
    let entries: unknown[] = [];
    if (batch) {
      const res = await ctx.db
        .from("recommendation_entries")
        .select("*, reading:reading_items(*)")
        .eq("batch_id", batch.id)
        .order("slot");
      if (res.error) throw fromPgError(res.error);
      entries = res.data ?? [];
    }
    const lastJob = jobRes.data;
    const active = lastJob && (lastJob.status === "queued" || lastJob.status === "running") ? lastJob : null;
    return {
      horizon: h,
      isCurrent: periodKey === w.periodKey,
      window: { periodKey, label: period ? periodKey : w.label, start: w.startUtc.toISOString(), end: w.endUtc.toISOString(), timeZone: settings.time_zone },
      targetCount: TARGET_COUNTS[h as Horizon],
      batch,
      entries,
      activeJob: active,
      lastJob: lastJob ?? null,
    };
  }));
  return { status: 200, body: horizon ? shelves[0] : { shelves } };
};

/** GET /v1/recommendations/archive?horizon=daily — every published edition, newest first. */
export const archive: Handler = async (ctx, _p, _b, url) => {
  const { limit, offset } = pageParams(url, 50, 200);
  const horizon = optEnum(url.searchParams.get("horizon") ?? undefined, "horizon", HORIZONS);
  let q = ctx.db.from("recommendation_batches").select("*", { count: "exact" }).eq("owner_id", ctx.ownerId);
  if (horizon) q = q.eq("horizon", horizon);
  const res = await q.order("window_start", { ascending: false }).order("version", { ascending: false }).range(offset, offset + limit - 1);
  if (res.error) throw fromPgError(res.error);
  return { status: 200, body: { items: res.data ?? [], total: res.count ?? 0, limit, offset } };
};

/** PATCH /v1/recommendation-entries/{id} { state: dismissed|read|saved|active } */
export const patchEntry: Handler = async (ctx, p, body) => {
  if (!isUuid(p.id)) throw new ApiError(404, "not_found", "Entry not found");
  const state = optEnum(body.state, "state", ENTRY_STATES);
  if (!state) throw new ApiError(422, "validation_failed", "state is required");
  const entry = must(await ctx.db.from("recommendation_entries").select("*").eq("owner_id", ctx.ownerId).eq("id", p.id).maybeSingle(), "Entry");
  const res = await ctx.db.from("recommendation_entries").update({ state }).eq("id", entry.id).select("*").single();
  if (res.error) throw fromPgError(res.error);
  if (state === "read") {
    await ctx.db.from("reading_items").update({ queue_status: "finished" }).eq("owner_id", ctx.ownerId).eq("id", entry.reading_id);
  } else if (state === "saved") {
    await ctx.db.from("reading_items").update({ queue_status: "saved" }).eq("owner_id", ctx.ownerId).eq("id", entry.reading_id).eq("queue_status", "candidate");
  }
  return { status: 200, body: res.data };
};
