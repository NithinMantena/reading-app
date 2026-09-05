import type { Handler } from "../index.ts";
import { ApiError } from "../../_shared/http.ts";
import { fromPgError, must, pageParams } from "../../_shared/db.ts";
import { bad, isUuid, optEnum, optRating, optString, optStringArray, optVersion } from "../../_shared/validate.ts";

const ACTIONS = [
  "more_like_this", "less_like_this", "already_know", "too_superficial", "too_technical", "too_long",
  "wrong_topic", "unreliable_source", "cannot_access", "note", "quality_rating",
] as const;
const SCOPES = ["item", "topic", "author", "publisher"] as const;

export const list: Handler = async (ctx, _p, _b, url) => {
  const { limit, offset } = pageParams(url);
  let q = ctx.db.from("feedback_events").select("*", { count: "exact" }).eq("owner_id", ctx.ownerId).is("deleted_at", null);
  const readingId = url.searchParams.get("reading_id");
  if (readingId) q = q.eq("reading_id", readingId);
  const bookId = url.searchParams.get("book_id");
  if (bookId) q = q.eq("book_id", bookId);
  const res = await q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  if (res.error) throw fromPgError(res.error);
  return { status: 200, body: { items: res.data ?? [], total: res.count ?? 0, limit, offset } };
};

export const create: Handler = async (ctx, _p, body) => {
  const action = optEnum(body.action, "action", ACTIONS);
  if (!action) bad("action", "is required");
  const scope = optEnum(body.scope, "scope", SCOPES) ?? "item";
  const text = optString(body.text, "text", 5000) ?? null;
  const readingId = optString(body.reading_id, "reading_id", 40) ?? null;
  const bookId = optString(body.book_id, "book_id", 40) ?? null;
  const entryId = optString(body.recommendation_entry_id, "recommendation_entry_id", 40) ?? null;
  const rating = optRating(body.quality_rating, "quality_rating") ?? null;
  if (action === "quality_rating" && rating === null) bad("quality_rating", "is required for a quality rating");
  if (!readingId && !bookId && !entryId && !text) bad("reading_id", "feedback needs a target item or free text");
  for (const [k, v] of [["reading_id", readingId], ["book_id", bookId], ["recommendation_entry_id", entryId]] as const) {
    if (v && !isUuid(v)) bad(k, "must be a UUID");
  }

  // Denormalise topics/publisher from the item so the event stays useful if the item changes.
  let topics = optStringArray(body.topics, "topics") ?? [];
  let publisher = optString(body.publisher, "publisher", 200) ?? null;
  if (readingId) {
    const r = must(await ctx.db.from("reading_items").select("topics, publisher").eq("owner_id", ctx.ownerId).eq("id", readingId).maybeSingle(), "Reading");
    if (!topics.length) topics = r.topics ?? [];
    if (!publisher) publisher = r.publisher ?? null;
  } else if (bookId) {
    const b = must(await ctx.db.from("books").select("topics").eq("owner_id", ctx.ownerId).eq("id", bookId).maybeSingle(), "Book");
    if (!topics.length) topics = b.topics ?? [];
  }

  const row = {
    owner_id: ctx.ownerId, action, scope, text, reading_id: readingId, book_id: bookId,
    recommendation_entry_id: entryId, quality_rating: rating, topics, publisher, source: ctx.source,
  };
  const inserted = must(await ctx.db.from("feedback_events").insert(row).select("*").single(), "Feedback");
  return { status: 201, body: inserted };
};

export const patch: Handler = async (ctx, p, body) => {
  if (!isUuid(p.id)) throw new ApiError(404, "not_found", "Feedback not found");
  const existing = must(
    await ctx.db.from("feedback_events").select("*").eq("owner_id", ctx.ownerId).eq("id", p.id).is("deleted_at", null).maybeSingle(),
    "Feedback",
  );
  const fields: Record<string, unknown> = {};
  const action = optEnum(body.action, "action", ACTIONS);
  if (action) fields.action = action;
  const scope = optEnum(body.scope, "scope", SCOPES);
  if (scope) fields.scope = scope;
  const text = optString(body.text, "text", 5000);
  if (text !== undefined) fields.text = text;
  const rating = optRating(body.quality_rating, "quality_rating");
  if (rating !== undefined) fields.quality_rating = rating;
  if (!Object.keys(fields).length) return { status: 200, body: existing };
  const version = optVersion(body.version);
  let q = ctx.db.from("feedback_events").update(fields).eq("owner_id", ctx.ownerId).eq("id", p.id);
  if (version !== undefined) q = q.eq("version", version);
  const res = await q.select("*").maybeSingle();
  if (res.error) throw fromPgError(res.error);
  if (!res.data) throw new ApiError(409, "version_conflict", "Feedback was modified elsewhere", { current: existing.version });
  return { status: 200, body: res.data };
};

/** Soft delete: the event stays in history but is excluded from all future recommendation context. */
export const remove: Handler = async (ctx, p) => {
  if (!isUuid(p.id)) throw new ApiError(404, "not_found", "Feedback not found");
  const res = await ctx.db
    .from("feedback_events")
    .update({ deleted_at: new Date().toISOString() })
    .eq("owner_id", ctx.ownerId).eq("id", p.id).is("deleted_at", null)
    .select("id").maybeSingle();
  if (res.error) throw fromPgError(res.error);
  if (!res.data) throw new ApiError(404, "not_found", "Feedback not found");
  return { status: 200, body: { deleted: true, id: p.id } };
};
