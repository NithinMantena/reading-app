// Stage 7: persist reading items, the batch, and its entries. The batch becomes visible
// only when its status flips to published/partial at the very end.
import type { SupabaseClient } from "@supabase/supabase-js";
import { TARGET_COUNTS, type Horizon } from "../periods.ts";
import type { Checkpoint, JobRow } from "./types.ts";

export async function publish(db: SupabaseClient, job: JobRow, cp: Checkpoint, horizon: Horizon, log: (s: string) => void): Promise<string> {
  const composed = cp.composed!;
  const ranking = cp.ranking!;
  const cands = new Map((cp.candidates ?? []).map((c) => [c.id, c]));
  const target = TARGET_COUNTS[horizon];
  const ctx = cp.context!;

  // Reading items (candidates enter as 'candidate'; a saved item is reused, never duplicated).
  const readingIds = new Map<string, string>();
  for (const slot of composed.slots) {
    const c = cands.get(slot.candidateId)!;
    const { data: existing } = await db.from("reading_items").select("id").eq("owner_id", job.owner_id).eq("canonical_url", c.url).maybeSingle();
    if (existing) { readingIds.set(c.id, existing.id); continue; }
    const row = {
      owner_id: job.owner_id,
      canonical_url: c.url,
      original_url: c.originalUrl,
      title: c.title ?? c.url,
      authors: c.authors,
      publisher: c.publisher ?? null,
      published_on: c.publishedOn ?? null,
      published_precision: c.precision,
      published_evidence: c.dateEvidence,
      item_type: c.itemType,
      access_class: c.accessClass,
      access_evidence: c.accessEvidence,
      access_checked_at: new Date().toISOString(),
      duration_minutes: c.durationMinutes ?? null,
      topics: slot.selection.topics,
      description: (c.description ?? c.text?.slice(0, 500) ?? null)?.slice(0, 600) ?? null,
      queue_status: "candidate",
      enrichment_status: "done",
      import_source: { source: c.source, sourceEvidence: c.sourceEvidence },
    };
    const ins = await db.from("reading_items").insert(row).select("id").single();
    if (ins.error) {
      if (ins.error.code === "23505") {
        const again = await db.from("reading_items").select("id").eq("owner_id", job.owner_id).eq("canonical_url", c.url).single();
        if (again.data) { readingIds.set(c.id, again.data.id); continue; }
      }
      throw new Error(`reading insert failed: ${ins.error.message}`);
    }
    readingIds.set(c.id, ins.data.id);
  }

  // Next version for this period.
  const { data: prev } = await db.from("recommendation_batches").select("version").eq("owner_id", job.owner_id).eq("horizon", horizon).eq("period_key", job.period_key).order("version", { ascending: false }).limit(1).maybeSingle();
  const version = (prev?.version ?? 0) + 1;
  const keep = ctx.keepEntries ?? [];
  const totalCount = keep.length + composed.slots.length;
  const status = totalCount >= target ? "published" : "partial";
  const batchIns = await db.from("recommendation_batches").insert({
    owner_id: job.owner_id, horizon, period_key: job.period_key, window_start: cp.window.start, window_end: cp.window.end,
    window_label: cp.window.label, time_zone: cp.window.timeZone, version, status: "generating", status_reason: composed.statusReason ?? ranking.batchNote ?? null,
    target_count: target, preference_version: ctx.preferenceVersion,
    model: { provider: "anthropic", ranker: ranking.model, promptVersion: ranking.promptVersion, jobId: job.id, kind: job.kind },
    cost: { actualUsd: cp.cost.actualUsd, calls: cp.cost.calls.length, fetches: cp.cost.fetches, searches: cp.cost.searches },
  }).select("id").single();
  if (batchIns.error) throw new Error(`batch insert failed: ${batchIns.error.message}`);
  const batchId = batchIns.data.id as string;

  const entries: Record<string, unknown>[] = [];
  let slot = 1;
  for (const k of keep) {
    entries.push({ batch_id: batchId, owner_id: job.owner_id, reading_id: k.reading_id, slot: slot++, is_surprise: k.is_surprise, why_matters: k.why_matters, why_fits: k.why_fits, evidence_depth: k.evidence_depth, ranking_evidence: k.ranking_evidence, previously_suggested: k.previously_suggested });
  }
  for (const s of composed.slots) {
    const c = cands.get(s.candidateId)!;
    entries.push({
      batch_id: batchId, owner_id: job.owner_id, reading_id: readingIds.get(c.id), slot: slot++, is_surprise: s.isSurprise,
      why_matters: s.selection.whyMatters, why_fits: s.isSurprise && s.selection.surpriseConnection ? `${s.selection.whyFits} ${s.selection.surpriseConnection}`.trim() : s.selection.whyFits,
      evidence_depth: c.evidenceDepth,
      ranking_evidence: { score: s.selection.score, rank: s.selection.rank, candidateId: c.id, source: c.source, model: ranking.model },
      previously_suggested: s.previouslySuggested,
    });
  }
  if (entries.length) {
    const e = await db.from("recommendation_entries").insert(entries);
    if (e.error) throw new Error(`entries insert failed: ${e.error.message}`);
  }
  const pub = await db.from("recommendation_batches").update({ status, published_at: new Date().toISOString() }).eq("id", batchId);
  if (pub.error) throw new Error(`batch publish failed: ${pub.error.message}`);
  log(`published batch v${version} (${status}) with ${entries.length}/${target} entries`);
  return batchId;
}
