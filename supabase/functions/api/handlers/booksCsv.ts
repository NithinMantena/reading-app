// POST /v1/import/books-csv { mode: "preview" | "commit", csv: "<text>" }
//
// Round-trips the "Export books (CSV)" file: edit it in a spreadsheet, upload it, see every
// change, then apply. Rows are matched to books by `id`; rows without a known id become new
// books (skipped if the same book already exists). Only columns present in the file are
// considered, and only cells that differ from the library are written. Cells that can't be
// read (an ISBN Excel turned into 9.78E+12, an unreadable date) are reported and left alone
// rather than failing the upload.
import type { Handler } from "../index.ts";
import type { Ctx } from "../../_shared/auth.ts";
import { ApiError } from "../../_shared/http.ts";
import { fromPgError } from "../../_shared/db.ts";
import { parseCsv } from "../../_shared/csv.ts";
import { create as createBook, normalizeIsbn, patch as patchBook } from "./books.ts";

const MAX_CSV_CHARS = 2_000_000;
const MAX_ROWS = 5000;
const STATUSES = ["want_to_read", "reading", "finished", "stopped", "unknown"];

/** Header aliases (lower-cased, spaces and punctuation folded to "_"). */
const COLUMNS: Record<string, string> = {
  id: "id", title: "title", authors: "authors", author: "authors", author_s: "authors", isbn: "isbn", isbn13: "isbn", isbn_13: "isbn",
  edition: "edition", topics: "topics", library_status: "library_status", status: "library_status",
  started_on: "started_on", start_date: "started_on", started: "started_on", finished_on: "finished_on", finish_date: "finished_on", finished: "finished_on",
  rating: "rating", session_notes: "session_notes", notes: "notes", why_read: "why_read", recommended_by: "recommended_by",
  archived_at: "archived_at", archived: "archived_at", cover_url: "cover_url", updated_at: "updated_at", created_at: "created_at",
};

type Field = "title" | "authors" | "isbn" | "edition" | "topics" | "library_status" | "started_on" | "finished_on" | "rating" | "session_notes" | "notes" | "why_read" | "recommended_by" | "archived" | "cover_url";
type Value = string | string[] | number | boolean | null;

export interface CsvChange { field: Field; from: Value; to: Value }
export interface CsvReport {
  mode: "preview" | "commit";
  rows: number;
  updates: { row: number; id: string; title: string; changes: CsvChange[]; staleWarning?: boolean }[];
  creates: { row: number; title: string }[];
  unchanged: number;
  problems: string[];
  applied?: { updated: number; created: number; duplicates: number; failed: number };
}

const list = (s: string) => s.split(";").map((x) => x.trim()).filter(Boolean);

export function isbnChecksumOk(isbn: string): boolean {
  if (isbn.length === 13) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(isbn[i]) * (i % 2 ? 3 : 1);
    return sum % 10 === 0;
  }
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (isbn[i] === "X" ? 10 : Number(isbn[i])) * (10 - i);
  return sum % 11 === 0;
}

/** YYYY-MM-DD, an ISO timestamp, or a US-style M/D/YYYY (what Excel writes back). */
export function parseDateCell(s: string): string | null | "invalid" {
  const v = s.trim();
  if (!v) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(v);
  let y: number, mo: number, d: number;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(v))) { mo = +m[1]; d = +m[2]; y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; }
  else return "invalid";
  const iso = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso ? "invalid" : iso;
}

/** Read one cell into the value the API stores, or a problem message. */
export function readCell(field: Field, raw: string): { value: Value } | { problem: string } {
  const v = raw.trim();
  switch (field) {
    case "authors":
    case "topics":
      return { value: list(v) };
    case "isbn":
      if (/^\d(\.\d+)?E\+\d+$/i.test(v)) return { problem: `ISBN "${v}" was turned into a number by a spreadsheet; format that column as text and re-enter it` };
      {
        const isbn = normalizeIsbn(v || null);
        if (isbn && /^\d{9}[\dX]$|^\d{13}$/.test(isbn) && !isbnChecksumOk(isbn)) return { problem: `ISBN "${v}" fails the ISBN check digit (typo?)` };
        return { value: isbn };
      }
    case "library_status": {
      if (!v) return { problem: "status is blank" };
      const s = v.toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");
      return STATUSES.includes(s) ? { value: s } : { problem: `status "${v}" isn't one of: want to read, reading, finished, stopped, unknown` };
    }
    case "started_on":
    case "finished_on": {
      const d = parseDateCell(v);
      return d === "invalid" ? { problem: `${field.replace("_on", "")} date "${v}" isn't a date (use YYYY-MM-DD)` } : { value: d };
    }
    case "rating": {
      if (!v) return { value: null };
      const n = Number(v.replace(/\/10$/, ""));
      return Number.isFinite(n) && n >= 0 && n <= 10 ? { value: Math.round(n * 10) / 10 } : { problem: `rating "${v}" must be a number from 0 to 10` };
    }
    case "archived":
      return { value: v !== "" && !/^(false|no|0)$/i.test(v) };
    default:
      return { value: v || null };
  }
}

function current(book: Record<string, unknown>, field: Field): Value {
  if (field === "archived") return Boolean(book.archived_at);
  if (field === "authors" || field === "topics") return (book[field] as string[] | null) ?? [];
  if (field === "rating") return book.rating === null || book.rating === undefined ? null : Number(book.rating);
  const v = book[field];
  return v === null || v === undefined || v === "" ? null : String(v);
}

function same(a: Value, b: Value): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return a === b;
}

/** The API request body for a set of changes. */
function toBody(changes: CsvChange[], book?: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const c of changes) {
    if (c.field === "archived") body.archived = c.to;
    else body[c.field] = c.to;
  }
  if ("authors" in body) {
    const authors = body.authors as string[];
    body.author_unknown = authors.length === 0;
  }
  // An ISBN change means an auto-found cover may now be the wrong edition; clear it so the
  // cover finder looks it up again by ISBN. Covers set by hand are kept.
  if ("isbn" in body && !("cover_url" in body) && book && (!book.cover_url || String(book.cover_url).startsWith("https://covers.openlibrary.org/"))) {
    body.cover_url = null;
  }
  return body;
}

export async function buildCsvPlan(ctx: Ctx, csv: string): Promise<{ report: CsvReport; work: { row: number; id?: string; body: Record<string, unknown>; title: string }[] }> {
  const rows = parseCsv(csv);
  if (!rows.length) throw new ApiError(422, "validation_failed", "The file is empty");
  const header = rows[0].map((h) => COLUMNS[h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")] ?? null);
  if (!header.includes("title")) throw new ApiError(422, "validation_failed", "The file needs a title column (use the file from Export books (CSV))");
  const body = rows.slice(1);
  if (body.length > MAX_ROWS) throw new ApiError(422, "validation_failed", `At most ${MAX_ROWS} rows per upload`);

  const res = await ctx.db.from("books_with_latest_session").select("*").eq("owner_id", ctx.ownerId);
  if (res.error) throw fromPgError(res.error);
  const books = new Map((res.data ?? []).map((b) => [String(b.id), b as Record<string, unknown>]));

  const report: CsvReport = { mode: "preview", rows: body.length, updates: [], creates: [], unchanged: 0, problems: [] };
  const work: { row: number; id?: string; body: Record<string, unknown>; title: string }[] = [];
  const seen = new Set<string>();

  body.forEach((cells, i) => {
    const rowNo = i + 2; // spreadsheet row number, counting the header
    if (cells.length > header.length) {
      report.problems.push(`Row ${rowNo}: has ${cells.length} columns but the header has ${header.length} (a comma inside an unquoted cell?); skipped`);
      return;
    }
    // A short row (cut off, or trailing empty cells dropped by an editor) only updates the
    // cells it actually has; missing cells are never read as "clear this".
    const cell = (col: string) => { const idx = header.indexOf(col); return idx >= 0 && idx < cells.length ? cells[idx] : undefined; };
    const title = (cell("title") ?? "").trim();
    const id = (cell("id") ?? "").trim();
    const label = title || id || `row ${rowNo}`;
    if (!title) { report.problems.push(`Row ${rowNo}: no title${cells.length < header.length ? " (the row looks cut off)" : ""}; skipped`); return; }
    if (cells.length < header.length) report.problems.push(`Row ${rowNo} (${label}): only ${cells.length} of ${header.length} columns; the missing ones are left unchanged`);
    if (id && seen.has(id)) { report.problems.push(`Row ${rowNo} (${label}): same id as an earlier row; skipped`); return; }
    if (id) seen.add(id);

    const values: Partial<Record<Field, Value>> = {};
    const fields: Field[] = ["title", "authors", "isbn", "edition", "topics", "library_status", "started_on", "finished_on", "rating", "session_notes", "notes", "why_read", "recommended_by", "cover_url"];
    for (const f of fields) {
      const raw = cell(f);
      if (raw === undefined) continue;
      const r = readCell(f, raw);
      if ("problem" in r) report.problems.push(`Row ${rowNo} (${label}): ${r.problem}; left unchanged`);
      else values[f] = r.value;
    }
    const archivedRaw = cell("archived_at");
    if (archivedRaw !== undefined) values.archived = archivedRaw.trim() !== "" && !/^(false|no|0)$/i.test(archivedRaw.trim());
    if (values.started_on && values.finished_on && String(values.finished_on) < String(values.started_on)) {
      report.problems.push(`Row ${rowNo} (${label}): finish date is before start date; dates left unchanged`);
      delete values.started_on; delete values.finished_on;
    }

    const book = id ? books.get(id) : undefined;
    if (!book) {
      if (id) report.problems.push(`Row ${rowNo} (${label}): id not found in your library; will be added as a new book`);
      const create: Record<string, unknown> = {};
      for (const [f, v] of Object.entries(values)) {
        if (v === null || (Array.isArray(v) && !v.length) || f === "archived") continue;
        create[f] = v;
      }
      if (!(create.authors as string[] | undefined)?.length) create.author_unknown = true;
      report.creates.push({ row: rowNo, title });
      work.push({ row: rowNo, body: create, title });
      return;
    }

    const changes: CsvChange[] = [];
    for (const [f, v] of Object.entries(values) as [Field, Value][]) {
      const from = current(book, f);
      if (!same(from, v)) changes.push({ field: f, from, to: v });
    }
    if (!changes.length) { report.unchanged++; return; }
    const exportedAt = cell("updated_at")?.trim();
    const stale = Boolean(exportedAt && book.updated_at && Date.parse(String(book.updated_at)) > Date.parse(exportedAt) + 1000);
    report.updates.push({ row: rowNo, id, title: String(book.title), changes, ...(stale ? { staleWarning: true } : {}) });
    work.push({ row: rowNo, id, body: toBody(changes, book), title: String(book.title) });
  });
  return { report, work };
}

export const importBooksCsv: Handler = async (ctx, _p, body, url, req) => {
  const mode = body.mode === "commit" ? "commit" : "preview";
  if (typeof body.csv !== "string") throw new ApiError(422, "validation_failed", "csv must be the file's text");
  if (body.csv.length > MAX_CSV_CHARS) throw new ApiError(422, "validation_failed", "File is too large (2 MB limit)");
  const { report, work } = await buildCsvPlan(ctx, body.csv);
  report.mode = mode;
  if (mode === "preview") return { status: 200, body: report };

  const applied = { updated: 0, created: 0, duplicates: 0, failed: 0 };
  for (const w of work) {
    try {
      if (w.id) {
        await patchBook(ctx, { id: w.id }, w.body, url, req);
        applied.updated++;
      } else {
        const r = await createBook(ctx, {}, w.body, url, req);
        if ((r.body as { existing?: boolean }).existing) {
          applied.duplicates++;
          report.problems.push(`Row ${w.row} (${w.title}): already in your library; not added again`);
        } else applied.created++;
      }
    } catch (e) {
      applied.failed++;
      report.problems.push(`Row ${w.row} (${w.title}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  report.applied = applied;
  return { status: 200, body: report };
};
