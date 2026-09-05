import type { Handler } from "../index.ts";
import type { Ctx } from "../../_shared/auth.ts";
import { ApiError } from "../../_shared/http.ts";
import { appLink, fromPgError, must, pageParams } from "../../_shared/db.ts";
import { canonicalizeUrl, hostOf, isNytUrl } from "../../_shared/urls.ts";
import { enrichUrl } from "../../_shared/enrich.ts";
import {
  bad, isUuid, optBool, optDate, optEnum, optInt, optString, optStringArray, optVersion,
} from "../../_shared/validate.ts";

const QUEUE_STATUSES = ["candidate", "saved", "reading", "finished", "archived"] as const;
const ACCESS_CLASSES = ["free_full_text", "open_copy", "nyt_subscription", "preview_only", "paywall", "unknown"] as const;
const PRECISIONS = ["day", "month", "year", "unknown"] as const;

function withLink<T extends { id: string }>(r: T): T & { app_link: string } {
  return { ...r, app_link: appLink(`/queue/${r.id}`) };
}

async function fetchReading(ctx: Ctx, id: string) {
  if (!isUuid(id)) throw new ApiError(404, "not_found", "Reading not found");
  return withLink(must(await ctx.db.from("reading_items").select("*").eq("owner_id", ctx.ownerId).eq("id", id).maybeSingle(), "Reading"));
}

export const list: Handler = async (ctx, _p, _b, url) => {
  const { limit, offset } = pageParams(url);
  const q = url.searchParams.get("q")?.trim();
  const status = optEnum(url.searchParams.get("status") ?? undefined, "status", QUEUE_STATUSES);
  const topic = url.searchParams.get("topic")?.trim();
  const includeArchived = url.searchParams.get("include_archived") === "true";
  let query = ctx.db.from("reading_items").select("*", { count: "exact" }).eq("owner_id", ctx.ownerId);
  if (status) query = query.eq("queue_status", status);
  else if (includeArchived) query = query.neq("queue_status", "candidate");
  else query = query.in("queue_status", ["saved", "reading", "finished"]);
  if (topic) query = query.contains("topics", [topic]);
  if (q) {
    const safe = q.replace(/[%,()]/g, " ");
    query = query.or(`title.ilike.%${safe}%,publisher.ilike.%${safe}%,canonical_url.ilike.%${safe}%`);
  }
  const res = await query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  if (res.error) throw fromPgError(res.error);
  return { status: 200, body: { items: (res.data ?? []).map(withLink), total: res.count ?? 0, limit, offset } };
};

export const get: Handler = async (ctx, p) => ({ status: 200, body: await fetchReading(ctx, p.id) });

function readingFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const title = optString(body.title, "title", 500);
  if (title !== undefined) out.title = title;
  const authors = optStringArray(body.authors ?? body.author, "authors");
  if (authors !== undefined) out.authors = authors;
  for (const f of ["publisher", "item_type", "notes", "description"] as const) {
    const v = optString(body[f], f, f === "publisher" || f === "item_type" ? 200 : 20000);
    if (v !== undefined) out[f] = v;
  }
  const po = optDate(body.published_on, "published_on");
  if (po !== undefined) out.published_on = po;
  const pp = optEnum(body.published_precision, "published_precision", PRECISIONS);
  if (pp !== undefined) out.published_precision = pp;
  const ac = optEnum(body.access_class, "access_class", ACCESS_CLASSES);
  if (ac !== undefined) {
    out.access_class = ac;
    out.access_checked_at = new Date().toISOString();
    out.access_evidence = { note: "Set manually by the user" };
  }
  const dm = optInt(body.duration_minutes, "duration_minutes", 0, 100000);
  if (dm !== undefined) out.duration_minutes = dm;
  const topics = optStringArray(body.topics, "topics");
  if (topics !== undefined) out.topics = topics;
  const qs = optEnum(body.queue_status ?? body.status, "queue_status", QUEUE_STATUSES);
  if (qs !== undefined) out.queue_status = qs;
  if (out.published_on && out.published_precision === undefined) out.published_precision = "day";
  if (out.published_on === null) out.published_precision = "unknown";
  return out;
}

export const create: Handler = async (ctx, _p, body) => {
  const fields = readingFields(body);
  const rawUrl = optString(body.url ?? body.canonical_url, "url", 2000);
  if (!rawUrl && !fields.title) bad("url", "either url or title is required");

  let canonical: string | null = null;
  if (rawUrl) {
    try {
      canonical = canonicalizeUrl(rawUrl);
    } catch (e) {
      bad("url", e instanceof Error ? e.message : "is not a valid URL");
    }
    const { data: existing } = await ctx.db
      .from("reading_items").select("*").eq("owner_id", ctx.ownerId).eq("canonical_url", canonical).maybeSingle();
    if (existing) {
      // A discovery candidate becomes a saved item; otherwise return the existing record
      // and offer to update its notes instead of duplicating.
      if (existing.queue_status === "candidate") {
        const promoted = await ctx.db.from("reading_items")
          .update({ queue_status: "saved", ...(fields.notes ? { notes: fields.notes } : {}) })
          .eq("id", existing.id).select("*").single();
        if (!promoted.error && promoted.data) return { status: 200, body: { ...withLink(promoted.data), existing: true, promoted: true } };
      }
      return {
        status: 200,
        body: { ...withLink(existing), existing: true, hint: "Already saved. PATCH /v1/readings/{id} to update notes." },
      };
    }
  }

  const row: Record<string, unknown> = {
    owner_id: ctx.ownerId,
    canonical_url: canonical,
    original_url: rawUrl ?? null,
    title: (fields.title as string | undefined) ?? (canonical ? hostOf(canonical) : "Untitled"),
    enrichment_status: canonical ? "pending" : "manual",
    ...fields,
  };
  if (canonical && isNytUrl(canonical) && !fields.access_class) {
    row.access_class = "nyt_subscription";
    row.access_evidence = { note: "NYT article; opens on nytimes.com with the user's own login" };
    row.access_checked_at = new Date().toISOString();
  }
  const insert = await ctx.db.from("reading_items").insert(row).select("*").single();
  if (insert.error?.code === "23505" && canonical) {
    const again = await ctx.db.from("reading_items").select("*").eq("owner_id", ctx.ownerId).eq("canonical_url", canonical).single();
    return { status: 200, body: { ...withLink(must(again)), existing: true } };
  }
  let item = must(insert, "Reading");

  const doEnrich = optBool(body.enrich, "enrich") ?? true;
  if (canonical && doEnrich) {
    const e = await enrichUrl(canonical);
    const update: Record<string, unknown> = { enrichment_status: e.status };
    if (e.status === "done") {
      if (!fields.title && e.title) update.title = e.title;
      if (!fields.authors && e.authors?.length) update.authors = e.authors;
      if (!fields.publisher && e.publisher) update.publisher = e.publisher;
      if (!fields.description && e.description) update.description = e.description;
      if (!fields.published_on && e.publishedOn) {
        update.published_on = e.publishedOn;
        update.published_precision = e.publishedPrecision;
        update.published_evidence = e.publishedEvidence;
      }
      if (!fields.duration_minutes && e.durationMinutes) update.duration_minutes = e.durationMinutes;
      if (!fields.item_type && e.itemType) update.item_type = e.itemType;
      if (!fields.access_class && e.accessClass) {
        update.access_class = e.accessClass;
        update.access_evidence = e.accessEvidence ?? {};
        update.access_checked_at = new Date().toISOString();
      }
    } else {
      update.access_evidence = { note: `Enrichment failed: ${e.error}` };
    }
    const upd = await ctx.db.from("reading_items").update(update).eq("id", item.id).select("*").single();
    if (!upd.error && upd.data) item = upd.data;
  }
  return { status: 201, body: withLink(item) };
};

export const patch: Handler = async (ctx, p, body) => {
  const existing = await fetchReading(ctx, p.id);
  const fields = readingFields(body);
  if (body.archived === true) fields.queue_status = "archived";
  if (body.archived === false && existing.queue_status === "archived") fields.queue_status = "saved";
  if (Object.keys(fields).length === 0) return { status: 200, body: existing };
  if ("title" in fields && !fields.title) bad("title", "cannot be empty");
  const version = optVersion(body.version);
  let q = ctx.db.from("reading_items").update(fields).eq("owner_id", ctx.ownerId).eq("id", p.id);
  if (version !== undefined) q = q.eq("version", version);
  const res = await q.select("*").maybeSingle();
  if (res.error) throw fromPgError(res.error);
  if (!res.data) throw new ApiError(409, "version_conflict", "Reading was modified elsewhere; reload and retry", { current: existing.version });
  return { status: 200, body: withLink(res.data) };
};

export const remove: Handler = async (ctx, p) => {
  await fetchReading(ctx, p.id);
  const res = await ctx.db.from("reading_items").delete().eq("owner_id", ctx.ownerId).eq("id", p.id);
  if (res.error) throw fromPgError(res.error);
  return { status: 200, body: { deleted: true, id: p.id } };
};
