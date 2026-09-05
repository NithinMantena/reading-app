import type { Handler } from "../index.ts";
import type { Ctx } from "../../_shared/auth.ts";
import { ApiError } from "../../_shared/http.ts";
import { appLink, fromPgError, must, pageParams } from "../../_shared/db.ts";
import {
  bad, isUuid, optBool, optDate, optEnum, optRating, optString, optStringArray, optVersion, reqString,
} from "../../_shared/validate.ts";

const LIBRARY_STATUSES = ["want_to_read", "reading", "finished", "stopped", "unknown"] as const;
const SESSION_STATUSES = ["reading", "finished", "stopped", "unknown"] as const;
type LibraryStatus = (typeof LIBRARY_STATUSES)[number];

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function withLink<T extends { id: string }>(b: T): T & { app_link: string } {
  return { ...b, app_link: appLink(`/library/${b.id}`) };
}

async function fetchBook(ctx: Ctx, id: string) {
  if (!isUuid(id)) throw new ApiError(404, "not_found", "Book not found");
  const book = must(await ctx.db.from("books").select("*").eq("owner_id", ctx.ownerId).eq("id", id).maybeSingle(), "Book");
  const { data: sessions } = await ctx.db
    .from("reading_sessions")
    .select("*")
    .eq("owner_id", ctx.ownerId)
    .eq("book_id", id)
    .order("created_at", { ascending: false });
  return withLink({ ...book, sessions: sessions ?? [] });
}

export const list: Handler = async (ctx, _p, _b, url) => {
  const { limit, offset } = pageParams(url);
  const q = url.searchParams.get("q")?.trim();
  const status = optEnum(url.searchParams.get("status") ?? undefined, "status", LIBRARY_STATUSES);
  const topic = url.searchParams.get("topic")?.trim();
  const minRating = url.searchParams.get("min_rating");
  const archived = url.searchParams.get("archived") === "true";
  const sort = url.searchParams.get("sort") ?? "updated";
  const order = url.searchParams.get("order") === "asc";

  let query = ctx.db.from("books_with_latest_session").select("*", { count: "exact" }).eq("owner_id", ctx.ownerId);
  query = archived ? query.not("archived_at", "is", null) : query.is("archived_at", null);
  if (status) query = query.eq("library_status", status);
  if (topic) query = query.contains("topics", [topic]);
  if (minRating) query = query.gte("rating", Number(minRating));
  if (q) {
    const safe = q.replace(/[%,()]/g, " ");
    query = query.or(`title.ilike.%${safe}%,authors_text.ilike.%${safe}%`);
  }
  const sortCol: Record<string, string> = {
    updated: "updated_at", created: "created_at", rating: "rating", title: "title", finished: "finished_on", started: "started_on",
  };
  query = query.order(sortCol[sort] ?? "updated_at", { ascending: order, nullsFirst: false }).range(offset, offset + limit - 1);
  const res = await query;
  if (res.error) throw fromPgError(res.error);
  return { status: 200, body: { items: (res.data ?? []).map(withLink), total: res.count ?? 0, limit, offset } };
};

export const get: Handler = async (ctx, p) => ({ status: 200, body: await fetchBook(ctx, p.id) });

function bookFields(body: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const title = creating ? reqString(body.title, "title", 500) : optString(body.title, "title", 500);
  if (title !== undefined) out.title = title;
  const authors = optStringArray(body.authors ?? body.author, "authors");
  if (authors !== undefined) out.authors = authors;
  const unknown = optBool(body.author_unknown, "author_unknown");
  if (unknown !== undefined) out.author_unknown = unknown;
  for (const f of ["isbn", "edition", "cover_url", "description", "recommended_by", "why_read", "notes"] as const) {
    const v = optString(body[f], f, f === "description" || f === "notes" ? 20000 : 1000);
    if (v !== undefined) out[f] = v;
  }
  const topics = optStringArray(body.topics, "topics");
  if (topics !== undefined) out.topics = topics;
  const status = optEnum(body.library_status ?? body.status, "library_status", LIBRARY_STATUSES);
  if (status !== undefined) out.library_status = status;
  if (creating) {
    const hasAuthors = (out.authors as string[] | undefined)?.length;
    if (!hasAuthors && !out.author_unknown) bad("authors", "is required (or set author_unknown: true)");
  }
  return out;
}

function sessionFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const s = optDate(body.started_on ?? body.start_date, "started_on");
  if (s !== undefined) out.started_on = s;
  const f = optDate(body.finished_on ?? body.finish_date, "finished_on");
  if (f !== undefined) out.finished_on = f;
  const r = optRating(body.rating);
  if (r !== undefined) out.rating = r;
  const n = optString(body.session_notes ?? body.what_stayed, "session_notes", 20000);
  if (n !== undefined) out.notes = n;
  const st = optEnum(body.session_status, "session_status", SESSION_STATUSES);
  if (st !== undefined) out.status = st;
  if (out.started_on && out.finished_on && String(out.finished_on) < String(out.started_on)) {
    bad("finished_on", "must not precede started_on");
  }
  return out;
}

/** Find a non-archived book that looks like the same work. */
async function findDuplicate(ctx: Ctx, fields: Record<string, unknown>) {
  if (fields.isbn) {
    const { data } = await ctx.db.from("books").select("*").eq("owner_id", ctx.ownerId).eq("isbn", fields.isbn).is("archived_at", null).limit(1);
    if (data?.length) return data[0];
  }
  const { data } = await ctx.db
    .from("books")
    .select("*")
    .eq("owner_id", ctx.ownerId)
    .is("archived_at", null)
    .ilike("title", String(fields.title));
  const wanted = normTitle(String(fields.title));
  const authors = ((fields.authors as string[]) ?? []).map((a) => a.toLowerCase());
  return (data ?? []).find((b) => {
    if (normTitle(b.title) !== wanted) return false;
    if (!authors.length || !b.authors?.length) return true;
    return b.authors.some((a: string) => authors.includes(a.toLowerCase()));
  });
}

/** Keep the latest reading session consistent with a library status change. */
async function syncSessionForStatus(ctx: Ctx, bookId: string, status: LibraryStatus, extra: Record<string, unknown>) {
  const { data: latest } = await ctx.db
    .from("reading_sessions")
    .select("*")
    .eq("owner_id", ctx.ownerId)
    .eq("book_id", bookId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const patch: Record<string, unknown> = { ...extra };
  delete patch.status;

  if (status === "want_to_read") {
    if (latest && Object.keys(patch).length) await ctx.db.from("reading_sessions").update(patch).eq("id", latest.id);
    return;
  }
  if (status === "unknown") {
    // Historical record with unknown completion: never invent a session unless dates were given.
    if (latest) {
      const r = await ctx.db.from("reading_sessions").update({ status: "unknown", ...patch }).eq("id", latest.id);
      if (r.error) throw fromPgError(r.error);
    } else if (Object.keys(patch).length) {
      const r = await ctx.db.from("reading_sessions").insert({ owner_id: ctx.ownerId, book_id: bookId, status: "unknown", ...patch });
      if (r.error) throw fromPgError(r.error);
    }
    return;
  }
  const sessionStatus = status as "reading" | "finished" | "stopped";
  // No session yet, or reading again after a finish (a reread): start a new session so
  // earlier dates and ratings are preserved. Stopped -> reading resumes the same session.
  if (!latest || (latest.status === "finished" && sessionStatus === "reading")) {
    const r = await ctx.db.from("reading_sessions").insert({ owner_id: ctx.ownerId, book_id: bookId, status: sessionStatus, ...patch });
    if (r.error) throw fromPgError(r.error);
    return;
  }
  const r = await ctx.db.from("reading_sessions").update({ status: sessionStatus, ...patch }).eq("id", latest.id);
  if (r.error) throw fromPgError(r.error);
}

export const create: Handler = async (ctx, _p, body) => {
  const fields = bookFields(body, true);
  const session = sessionFields(body);
  if (!optBool(body.allow_duplicate, "allow_duplicate")) {
    const dup = await findDuplicate(ctx, fields);
    if (dup) return { status: 200, body: { ...(await fetchBook(ctx, dup.id)), existing: true } };
  }
  const status = (fields.library_status as LibraryStatus | undefined) ??
    (session.finished_on || session.status === "finished" ? "finished" : session.started_on ? "reading" : "want_to_read");
  fields.library_status = status;
  const inserted = must(await ctx.db.from("books").insert({ owner_id: ctx.ownerId, ...fields }).select("*").single(), "Book");
  if (status !== "want_to_read" || Object.keys(session).length) {
    await syncSessionForStatus(ctx, inserted.id, status, session);
  }
  return { status: 201, body: await fetchBook(ctx, inserted.id) };
};

export const patch: Handler = async (ctx, p, body) => {
  const existing = await fetchBook(ctx, p.id);
  const fields = bookFields(body, false);
  const session = sessionFields(body);
  const version = optVersion(body.version);

  const archive = optBool(body.archived, "archived");
  if (archive === true) fields.archived_at = new Date().toISOString();
  if (archive === false) fields.archived_at = null;

  if (Object.keys(fields).length) {
    let q = ctx.db.from("books").update(fields).eq("owner_id", ctx.ownerId).eq("id", p.id);
    if (version !== undefined) q = q.eq("version", version);
    const res = await q.select("id").maybeSingle();
    if (res.error) throw fromPgError(res.error);
    if (!res.data) throw new ApiError(409, "version_conflict", "Book was modified elsewhere; reload and retry", { current: existing.version });
  } else if (version !== undefined && version !== existing.version) {
    throw new ApiError(409, "version_conflict", "Book was modified elsewhere; reload and retry", { current: existing.version });
  }

  const newStatus = (fields.library_status as LibraryStatus | undefined) ?? existing.library_status;
  if (fields.library_status !== undefined || Object.keys(session).length) {
    await syncSessionForStatus(ctx, p.id, newStatus, session);
  }
  return { status: 200, body: await fetchBook(ctx, p.id) };
};

export const remove: Handler = async (ctx, p) => {
  await fetchBook(ctx, p.id);
  const res = await ctx.db.from("books").delete().eq("owner_id", ctx.ownerId).eq("id", p.id);
  if (res.error) throw fromPgError(res.error);
  return { status: 200, body: { deleted: true, id: p.id } };
};

/** Start a new reading session (first read or reread). */
export const createSession: Handler = async (ctx, p, body) => {
  await fetchBook(ctx, p.id);
  const session = sessionFields(body);
  const status = (session.status as string | undefined) ?? (session.finished_on ? "finished" : "reading");
  const inserted = must(
    await ctx.db.from("reading_sessions").insert({ owner_id: ctx.ownerId, book_id: p.id, ...session, status }).select("*").single(),
    "Session",
  );
  const r = await ctx.db.from("books").update({ library_status: status }).eq("owner_id", ctx.ownerId).eq("id", p.id);
  if (r.error) throw fromPgError(r.error);
  return { status: 201, body: { session: inserted, book: await fetchBook(ctx, p.id) } };
};

export const patchSession: Handler = async (ctx, p, body) => {
  if (!isUuid(p.id)) throw new ApiError(404, "not_found", "Session not found");
  const existing = must(
    await ctx.db.from("reading_sessions").select("*").eq("owner_id", ctx.ownerId).eq("id", p.id).maybeSingle(),
    "Session",
  );
  const fields = sessionFields(body);
  const st = optEnum(body.status, "status", SESSION_STATUSES);
  if (st !== undefined) fields.status = st;
  const notes = optString(body.notes, "notes", 20000);
  if (notes !== undefined) fields.notes = notes;
  const merged = { ...existing, ...fields };
  if (merged.started_on && merged.finished_on && merged.finished_on < merged.started_on) {
    bad("finished_on", "must not precede started_on");
  }
  const version = optVersion(body.version);
  let q = ctx.db.from("reading_sessions").update(fields).eq("owner_id", ctx.ownerId).eq("id", p.id);
  if (version !== undefined) q = q.eq("version", version);
  const res = await q.select("*").maybeSingle();
  if (res.error) throw fromPgError(res.error);
  if (!res.data) throw new ApiError(409, "version_conflict", "Session was modified elsewhere; reload and retry", { current: existing.version });

  // If this is the latest session, mirror its status on the book.
  const { data: latest } = await ctx.db
    .from("reading_sessions").select("id").eq("book_id", existing.book_id).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (latest?.id === p.id && fields.status) {
    await ctx.db.from("books").update({ library_status: fields.status }).eq("owner_id", ctx.ownerId).eq("id", existing.book_id);
  }
  return { status: 200, body: { session: res.data, book: await fetchBook(ctx, existing.book_id) } };
};
