// Export (JSON, CSV) and validated import with preview + duplicate handling.
// Exports never include integration tokens or hashes.
import type { Handler } from "../index.ts";
import type { Ctx } from "../../_shared/auth.ts";
import { ApiError, CORS_HEADERS } from "../../_shared/http.ts";
import { fromPgError } from "../../_shared/db.ts";
import { canonicalizeUrl } from "../../_shared/urls.ts";
import { loadSettings } from "./preferences.ts";

const EXPORT_VERSION = 1;

async function all(ctx: Ctx, table: string, order = "created_at") {
  const res = await ctx.db.from(table).select("*").eq("owner_id", ctx.ownerId).order(order, { ascending: true });
  if (res.error) throw fromPgError(res.error);
  return res.data ?? [];
}

export const exportJson: Handler = async (ctx) => {
  const settings = await loadSettings(ctx);
  const [books, sessions, readings, feedback, summaries, batches, entries] = await Promise.all([
    all(ctx, "books"), all(ctx, "reading_sessions"), all(ctx, "reading_items"), all(ctx, "feedback_events"),
    all(ctx, "preference_summaries"), all(ctx, "recommendation_batches"), all(ctx, "recommendation_entries"),
  ]);
  const { owner_id: _o, ...prefs } = settings;
  return {
    status: 200,
    body: {
      format: "reading-app-export", version: EXPORT_VERSION, exportedAt: new Date().toISOString(),
      preferences: prefs, books, reading_sessions: sessions, readings, feedback, preference_summaries: summaries,
      recommendation_batches: batches, recommendation_entries: entries,
    },
  };
};

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join("; ") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const exportBooksCsv: Handler = async (ctx) => {
  const res = await ctx.db.from("books_with_latest_session").select("*").eq("owner_id", ctx.ownerId).order("created_at");
  if (res.error) throw fromPgError(res.error);
  const cols = ["id", "title", "authors", "isbn", "edition", "topics", "library_status", "started_on", "finished_on", "rating", "session_notes", "notes", "why_read", "recommended_by", "archived_at", "created_at"];
  const lines = [cols.join(",")];
  for (const row of res.data ?? []) lines.push(cols.map((c) => csvCell((row as Record<string, unknown>)[c])).join(","));
  const resp = new Response(lines.join("\r\n"), {
    status: 200,
    headers: { ...CORS_HEADERS, "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="books.csv"' },
  });
  return { status: 200, body: resp };
};

interface ImportReport {
  mode: "preview" | "commit";
  books: { create: number; skipDuplicate: number; skipExistingId: number };
  reading_sessions: { create: number; skipExistingId: number; skipMissingBook: number };
  readings: { create: number; skipDuplicate: number; skipExistingId: number };
  feedback: { create: number; skipExistingId: number };
  preferences: "updated" | "unchanged";
  problems: string[];
}

/**
 * POST /v1/import { mode: "preview" | "commit", data: <export json> }
 * Duplicate handling: existing ids are skipped; books matching ISBN or title+author are
 * skipped; readings with the same canonical URL are skipped. Nothing is overwritten.
 */
export const importJson: Handler = async (ctx, _p, body) => {
  const mode = body.mode === "commit" ? "commit" : "preview";
  const data = body.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") throw new ApiError(422, "validation_failed", "data must be an export object");
  if (data.format !== "reading-app-export") throw new ApiError(422, "validation_failed", "Unrecognised export format");
  const report: ImportReport = {
    mode,
    books: { create: 0, skipDuplicate: 0, skipExistingId: 0 },
    reading_sessions: { create: 0, skipExistingId: 0, skipMissingBook: 0 },
    readings: { create: 0, skipDuplicate: 0, skipExistingId: 0 },
    feedback: { create: 0, skipExistingId: 0 },
    preferences: "unchanged",
    problems: [],
  };
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  const [existingBooks, existingSessions, existingReadings, existingFeedback] = await Promise.all([
    all(ctx, "books"), all(ctx, "reading_sessions"), all(ctx, "reading_items"), all(ctx, "feedback_events"),
  ]);
  const bookIds = new Set(existingBooks.map((b) => b.id));
  const bookKeys = new Set(existingBooks.map((b) => `${norm(b.title)}|${(b.authors ?? []).map((a: string) => a.toLowerCase()).sort().join(",")}`));
  const isbns = new Set(existingBooks.filter((b) => b.isbn).map((b) => b.isbn));
  const sessionIds = new Set(existingSessions.map((s) => s.id));
  const readingIds = new Set(existingReadings.map((r) => r.id));
  const urls = new Set(existingReadings.filter((r) => r.canonical_url).map((r) => r.canonical_url));
  const feedbackIds = new Set(existingFeedback.map((f) => f.id));

  const booksToInsert: Record<string, unknown>[] = [];
  for (const raw of (data.books as Record<string, unknown>[]) ?? []) {
    if (!raw.title) { report.problems.push(`book without title skipped`); continue; }
    if (raw.id && bookIds.has(raw.id)) { report.books.skipExistingId++; continue; }
    const key = `${norm(String(raw.title))}|${((raw.authors as string[]) ?? []).map((a) => a.toLowerCase()).sort().join(",")}`;
    if ((raw.isbn && isbns.has(raw.isbn)) || bookKeys.has(key)) { report.books.skipDuplicate++; continue; }
    bookKeys.add(key);
    if (raw.isbn) isbns.add(raw.isbn);
    const { owner_id: _o, version: _v, ...rest } = raw;
    booksToInsert.push({ ...rest, owner_id: ctx.ownerId });
    if (raw.id) bookIds.add(raw.id);
    report.books.create++;
  }
  const sessionsToInsert: Record<string, unknown>[] = [];
  for (const raw of (data.reading_sessions as Record<string, unknown>[]) ?? []) {
    if (raw.id && sessionIds.has(raw.id)) { report.reading_sessions.skipExistingId++; continue; }
    if (!raw.book_id || !bookIds.has(raw.book_id)) { report.reading_sessions.skipMissingBook++; continue; }
    const { owner_id: _o, version: _v, ...rest } = raw;
    sessionsToInsert.push({ ...rest, owner_id: ctx.ownerId });
    report.reading_sessions.create++;
  }
  const readingsToInsert: Record<string, unknown>[] = [];
  for (const raw of (data.readings as Record<string, unknown>[]) ?? []) {
    if (raw.id && readingIds.has(raw.id)) { report.readings.skipExistingId++; continue; }
    let canonical: string | null = null;
    if (raw.canonical_url) {
      try { canonical = canonicalizeUrl(String(raw.canonical_url)); } catch { report.problems.push(`invalid url skipped: ${raw.canonical_url}`); continue; }
      if (urls.has(canonical)) { report.readings.skipDuplicate++; continue; }
      urls.add(canonical);
    }
    if (!raw.title && !canonical) { report.problems.push("reading without title or url skipped"); continue; }
    const { owner_id: _o, version: _v, recommendation_entry_id: _r, source_batch_id: _s, ...rest } = raw;
    readingsToInsert.push({ ...rest, canonical_url: canonical, title: raw.title ?? canonical, owner_id: ctx.ownerId });
    if (raw.id) readingIds.add(raw.id);
    report.readings.create++;
  }
  const feedbackToInsert: Record<string, unknown>[] = [];
  for (const raw of (data.feedback as Record<string, unknown>[]) ?? []) {
    if (raw.id && feedbackIds.has(raw.id)) { report.feedback.skipExistingId++; continue; }
    const { owner_id: _o, version: _v, recommendation_entry_id: _r, ...rest } = raw;
    if (rest.reading_id && !readingIds.has(rest.reading_id)) rest.reading_id = null;
    if (rest.book_id && !bookIds.has(rest.book_id)) rest.book_id = null;
    feedbackToInsert.push({ ...rest, owner_id: ctx.ownerId, source: "import" });
    report.feedback.create++;
  }
  const prefs = data.preferences as Record<string, unknown> | undefined;
  if (prefs && typeof prefs === "object") report.preferences = "updated";

  if (mode === "commit") {
    const step = async (table: string, rows: Record<string, unknown>[]) => {
      if (!rows.length) return;
      const res = await ctx.db.from(table).insert(rows);
      if (res.error) throw fromPgError(res.error);
    };
    await step("books", booksToInsert);
    await step("reading_sessions", sessionsToInsert);
    await step("reading_items", readingsToInsert);
    await step("feedback_events", feedbackToInsert);
    if (prefs) {
      const allowed = ["time_zone", "language", "access_exceptions", "interests", "exclusions", "length_preferences", "budget", "onboarding_complete"];
      const update: Record<string, unknown> = {};
      for (const k of allowed) if (k in prefs) update[k] = prefs[k];
      await loadSettings(ctx);
      const res = await ctx.db.from("user_settings").update(update).eq("owner_id", ctx.ownerId);
      if (res.error) throw fromPgError(res.error);
    }
  }
  return { status: 200, body: report };
};
