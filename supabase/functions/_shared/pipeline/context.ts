// Stage 1: load everything the run needs to know about the reader.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Horizon } from "../periods.ts";
import type { RankingContext } from "./types.ts";

export async function loadContext(db: SupabaseClient, ownerId: string, horizon: Horizon, periodKey: string, kind: string): Promise<RankingContext> {
  const [{ data: settings }, { data: feedback }, { data: summary }, { data: books }, { data: known }, { data: surfaced }] = await Promise.all([
    db.from("user_settings").select("*").eq("owner_id", ownerId).maybeSingle(),
    db.from("feedback_events").select("action, scope, text, topics, publisher, created_at, reading_id").eq("owner_id", ownerId).is("deleted_at", null)
      .order("created_at", { ascending: false }).limit(120),
    db.from("preference_summaries").select("version, summary").eq("owner_id", ownerId).order("version", { ascending: false }).limit(1).maybeSingle(),
    db.from("books").select("title").eq("owner_id", ownerId).eq("library_status", "finished").limit(300),
    db.from("reading_items").select("canonical_url").eq("owner_id", ownerId).in("queue_status", ["saved", "reading", "finished", "archived"]).not("canonical_url", "is", null).limit(2000),
    db.from("recommendation_entries").select("reading_id, batch:recommendation_batches!inner(horizon, period_key), reading:reading_items!inner(canonical_url)")
      .eq("owner_id", ownerId).limit(3000),
  ]);
  if (!settings) throw new Error("Owner settings not found");

  // Attach titles to feedback for readable prompt context.
  const readingIds = [...new Set((feedback ?? []).map((f) => f.reading_id).filter((x): x is string => Boolean(x)))];
  const titles = new Map<string, string>();
  if (readingIds.length) {
    const { data: rs } = await db.from("reading_items").select("id, title").in("id", readingIds.slice(0, 200));
    for (const r of rs ?? []) titles.set(r.id, r.title);
  }

  const same: string[] = [];
  const other: string[] = [];
  for (const e of (surfaced ?? []) as unknown as Array<{ batch: { horizon: string; period_key: string } | null; reading: { canonical_url: string | null } | null }>) {
    const url = e.reading?.canonical_url;
    if (!url) continue;
    if (e.batch?.horizon === horizon) same.push(url);
    else other.push(url);
  }

  const ctx: RankingContext = {
    timeZone: settings.time_zone,
    interests: settings.interests ?? [],
    exclusions: settings.exclusions ?? [],
    lengthPreferences: settings.length_preferences ?? {},
    accessExceptions: settings.access_exceptions ?? [],
    sources: settings.sources ?? [],
    feedback: (feedback ?? []).map((f) => ({
      action: f.action, scope: f.scope, text: f.text, topics: f.topics ?? [], publisher: f.publisher,
      title: f.reading_id ? titles.get(f.reading_id) : undefined, created_at: f.created_at,
    })),
    preferenceSummary: summary?.summary ?? null,
    preferenceVersion: summary?.version ?? null,
    surfacedSameHorizon: [...new Set(same)],
    surfacedOtherHorizons: [...new Set(other)],
    knownUrls: [...new Set((known ?? []).map((k) => k.canonical_url as string))],
    finishedBookTitles: (books ?? []).map((b) => b.title),
  };

  // Alternatives must avoid what earlier versions of this exact period already showed;
  // fill_missing keeps the existing entries and adds to them.
  const { data: batches } = await db.from("recommendation_batches").select("id, version").eq("owner_id", ownerId).eq("horizon", horizon).eq("period_key", periodKey)
    .in("status", ["published", "partial"]).order("version", { ascending: false });
  if (batches?.length) {
    const { data: entries } = await db.from("recommendation_entries")
      .select("reading_id, slot, is_surprise, why_matters, why_fits, evidence_depth, ranking_evidence, previously_suggested, batch_id, reading:reading_items!inner(canonical_url)")
      .in("batch_id", batches.map((b) => b.id));
    const urls = (entries ?? []).map((e) => (e as unknown as { reading: { canonical_url: string | null } }).reading?.canonical_url).filter((u): u is string => Boolean(u));
    ctx.surfacedSameHorizon = [...new Set([...ctx.surfacedSameHorizon, ...urls])];
    if (kind === "fill_missing") {
      const latest = batches[0].id;
      ctx.keepEntries = (entries ?? []).filter((e) => e.batch_id === latest).map((e) => ({
        reading_id: e.reading_id, slot: e.slot, is_surprise: e.is_surprise, why_matters: e.why_matters, why_fits: e.why_fits,
        evidence_depth: e.evidence_depth, ranking_evidence: e.ranking_evidence, previously_suggested: e.previously_suggested,
      }));
      ctx.keepUrls = (entries ?? []).filter((e) => e.batch_id === latest).map((e) => (e as unknown as { reading: { canonical_url: string | null } }).reading?.canonical_url).filter((u): u is string => Boolean(u));
    }
  }
  return ctx;
}
