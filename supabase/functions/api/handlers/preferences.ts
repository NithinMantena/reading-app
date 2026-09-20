import type { Handler } from "../index.ts";
import type { Ctx } from "../../_shared/auth.ts";
import { ApiError } from "../../_shared/http.ts";
import { must, fromPgError } from "../../_shared/db.ts";
import { isValidTimeZone } from "../../_shared/periods.ts";
import { bad, optBool, optString, optVersion, reqString } from "../../_shared/validate.ts";
import { parseInterest, parseInterests, topicKey, type Interest } from "../../_shared/interests.ts";

export interface Settings {
  owner_id: string;
  time_zone: string;
  language: string;
  access_exceptions: string[];
  interests: { topic: string; weight: number }[];
  exclusions: { kind: string; value: string }[];
  length_preferences: Record<string, number>;
  budget: Record<string, unknown>;
  sources: { url: string; label?: string }[];
  onboarding_complete: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

/** Load settings, creating the default row on first use. */
export async function loadSettings(ctx: Ctx): Promise<Settings> {
  const { data, error } = await ctx.db.from("user_settings").select("*").eq("owner_id", ctx.ownerId).maybeSingle();
  if (error) throw fromPgError(error);
  if (data) return data as Settings;
  const inserted = await ctx.db.from("user_settings").insert({ owner_id: ctx.ownerId }).select("*").single();
  if (inserted.error && inserted.error.code === "23505") {
    return must(await ctx.db.from("user_settings").select("*").eq("owner_id", ctx.ownerId).single()) as Settings;
  }
  return must(inserted, "settings") as Settings;
}

export const get: Handler = async (ctx) => ({ status: 200, body: await loadSettings(ctx) });

const EXCLUSION_KINDS = ["topic", "author", "publisher"];
const ACCESS_EXCEPTIONS = ["nyt_subscription"];

export const patch: Handler = async (ctx, _p, body) => {
  const current = await loadSettings(ctx);
  const update: Record<string, unknown> = {};

  const tz = optString(body.time_zone, "time_zone", 100);
  if (tz !== undefined) {
    if (!tz || !isValidTimeZone(tz)) bad("time_zone", "must be a valid IANA time zone");
    update.time_zone = tz;
  }
  const lang = optString(body.language, "language", 10);
  if (lang !== undefined) update.language = lang ?? "en";

  if (body.interests !== undefined) {
    update.interests = parseInterests(body.interests);
  }
  if (body.exclusions !== undefined) {
    if (!Array.isArray(body.exclusions)) bad("exclusions", "must be an array");
    update.exclusions = (body.exclusions as unknown[]).map((it, i) => {
      const o = (typeof it === "string" ? { kind: "topic", value: it } : it) as Record<string, unknown>;
      const kind = String(o.kind ?? "topic");
      if (!EXCLUSION_KINDS.includes(kind)) bad(`exclusions[${i}].kind`, `must be one of ${EXCLUSION_KINDS.join(", ")}`);
      const value = optString(o.value, `exclusions[${i}].value`, 200);
      if (!value) bad(`exclusions[${i}].value`, "is required");
      return { kind, value };
    });
  }
  if (body.access_exceptions !== undefined) {
    if (!Array.isArray(body.access_exceptions) || (body.access_exceptions as unknown[]).some((x) => !ACCESS_EXCEPTIONS.includes(String(x)))) {
      bad("access_exceptions", `may only contain ${ACCESS_EXCEPTIONS.join(", ")}`);
    }
    update.access_exceptions = body.access_exceptions;
  }
  if (body.length_preferences !== undefined) {
    const lp = body.length_preferences as Record<string, unknown>;
    if (!lp || typeof lp !== "object") bad("length_preferences", "must be an object");
    const out: Record<string, number> = { ...current.length_preferences };
    for (const [k, v] of Object.entries(lp)) {
      if (!/^[a-z_]+$/.test(k)) bad(`length_preferences.${k}`, "invalid key");
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100000) bad(`length_preferences.${k}`, "must be a non-negative number");
      out[k] = n;
    }
    update.length_preferences = out;
  }
  if (body.budget !== undefined) {
    const b = body.budget as Record<string, unknown>;
    if (!b || typeof b !== "object") bad("budget", "must be an object");
    const cap = b.monthly_cap_usd === undefined ? current.budget.monthly_cap_usd : Number(b.monthly_cap_usd);
    if (!Number.isFinite(Number(cap)) || Number(cap) < 0) bad("budget.monthly_cap_usd", "must be a non-negative number");
    update.budget = { ...current.budget, ...b, monthly_cap_usd: Number(cap) };
  }
  if (body.sources !== undefined) {
    if (!Array.isArray(body.sources)) bad("sources", "must be an array");
    update.sources = (body.sources as unknown[]).slice(0, 60).map((it, i) => {
      const o = (typeof it === "string" ? { url: it } : it) as Record<string, unknown>;
      const url = optString(o.url, `sources[${i}].url`, 500);
      if (!url || !/^https?:\/\//i.test(url)) bad(`sources[${i}].url`, "must be an http(s) feed URL");
      const label = optString(o.label, `sources[${i}].label`, 100) ?? null;
      return label ? { url, label } : { url };
    });
  }
  const ob = optBool(body.onboarding_complete, "onboarding_complete");
  if (ob !== undefined) update.onboarding_complete = ob;

  if (Object.keys(update).length === 0) return { status: 200, body: current };

  const version = optVersion(body.version);
  let q = ctx.db.from("user_settings").update(update).eq("owner_id", ctx.ownerId);
  if (version !== undefined) q = q.eq("version", version);
  const res = await q.select("*").maybeSingle();
  if (res.error) throw fromPgError(res.error);
  if (!res.data) throw new ApiError(409, "version_conflict", "Settings were modified elsewhere; reload and retry", { current: current.version });
  return { status: 200, body: res.data };
};

// Compare-and-swap protects the rest of the list when a bot and browser edit together.
async function changeInterests(ctx: Ctx, version: number | undefined, change: (items: Interest[]) => Interest[]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await loadSettings(ctx);
    if (version !== undefined && version !== current.version) {
      throw new ApiError(409, "version_conflict", "Settings were modified elsewhere; reload and retry");
    }
    const interests = change(current.interests);
    if (JSON.stringify(interests) === JSON.stringify(current.interests)) return { status: 200, body: current };
    const result = await ctx.db.from("user_settings").update({ interests })
      .eq("owner_id", ctx.ownerId).eq("version", current.version).select("*").maybeSingle();
    if (result.error) throw fromPgError(result.error);
    if (result.data) return { status: 200, body: result.data };
    if (version !== undefined) break;
  }
  throw new ApiError(409, "version_conflict", "Settings changed during the interest update; retry with fresh settings");
}

/** Add a topic, or update its weight, without replacing unrelated interests. */
export const upsertInterest: Handler = async (ctx, _p, body) => {
  const interest = parseInterest(body);
  return changeInterests(ctx, optVersion(body.version), (items) => {
    const existing = items.find((item) => topicKey(item.topic) === topicKey(interest.topic));
    if (!existing) return [...items, interest];
    return items.map((item) => topicKey(item.topic) === topicKey(interest.topic)
      ? { ...item, weight: body.weight === undefined ? item.weight : interest.weight } : item);
  });
};

/** DELETE /preferences/interests/{topic}?version=... (topic is URL-encoded). */
export const removeInterest: Handler = async (ctx, p, _body, url) => {
  const topic = reqString(p.topic, "topic", 100);
  return changeInterests(ctx, optVersion(url.searchParams.get("version")),
    (items) => items.filter((item) => topicKey(item.topic) !== topicKey(topic)));
};

export const summary: Handler = async (ctx) => {
  const settings = await loadSettings(ctx);
  const { data: latest } = await ctx.db
    .from("preference_summaries")
    .select("*")
    .eq("owner_id", ctx.ownerId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { count } = await ctx.db
    .from("feedback_events")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ctx.ownerId)
    .is("deleted_at", null);
  return {
    status: 200,
    body: {
      explicit: {
        interests: settings.interests,
        exclusions: settings.exclusions,
        length_preferences: settings.length_preferences,
        access_exceptions: settings.access_exceptions,
      },
      derived: latest ?? null,
      activeFeedbackCount: count ?? 0,
      note: latest ? undefined : "No derived preference summary yet; one is built from feedback in Phase 3.",
    },
  };
};
