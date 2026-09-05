#!/usr/bin/env node
// Convert the "Personal Reading List — Application Seed Data" markdown into the app's
// import format (reading-app-export). Faithful to the seed instructions:
//   - want-to-read entries keep their order; author references embedded in the text are
//     split into the author field with the original wording kept in notes
//   - each log row becomes a reading session; exact-title repeats across years become one
//     book with several sessions (nothing collapsed, every rating preserved)
//   - no dates are invented; "started, completion unknown" and undated rows use status
//     "unknown"; "pass" is kept as a raw value in import provenance
//   - ratings copied numerically; "—" becomes null
//   - purposes become the book's "why I want to read this"; notes become session notes
//   - the five untitled ratings/purposes are written to a separate review file
//
// Usage: node scripts/seed-from-sheet.mjs <seed.md> <out.json> [<unresolved.md>]
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [, , inPath, outPath, unresolvedPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: seed-from-sheet.mjs <seed.md> <out.json> [<unresolved.md>]");
  process.exit(1);
}
const md = readFileSync(inPath, "utf8");
const WORKBOOK = /Source: `([^`]+)`/.exec(md)?.[1] ?? "Personal Sheets (1).xlsx";
const WORKSHEET = /worksheet `([^`]+)`/.exec(md)?.[1] ?? "Book List";
const NS = "6f1a2c58-7a1b-4c8e-9d2f-1e3b4a5c6d7e"; // fixed namespace for deterministic ids

function uuid5(name) {
  const ns = Buffer.from(NS.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(Buffer.concat([ns, Buffer.from(name, "utf8")])).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const s = h.subarray(0, 16).toString("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
const key = (parts) => uuid5(`${WORKBOOK}|${WORKSHEET}|${parts.join("|")}`);
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const nul = (v) => (v === undefined || v === null || v.trim() === "" || v.trim() === "—" ? null : v.trim());

function section(title) {
  const re = new RegExp(`^## ${title}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m");
  return re.exec(md)?.[1] ?? "";
}
function tables(text) {
  // Returns arrays of row arrays for every markdown table in text, with the heading (### ...) preceding it.
  const out = [];
  const lines = text.split("\n");
  let heading = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^### /.test(l)) heading = l.replace(/^### /, "").trim();
    if (/^\|/.test(l) && /^\|[\s-|:]+\|$/.test(lines[i + 1] ?? "")) {
      const header = l.split("|").slice(1, -1).map((c) => c.trim());
      const rows = [];
      let j = i + 2;
      while (/^\|/.test(lines[j] ?? "")) {
        rows.push(lines[j].split("|").slice(1, -1).map((c) => c.trim()));
        j++;
      }
      out.push({ heading, header, rows });
      i = j;
    }
  }
  return out;
}

// --- Want to read -------------------------------------------------------------------
const want = [];
for (const t of tables(section("Want to read"))) {
  for (const r of t.rows) {
    const [order, sourceId, entry] = r;
    if (!/^want-/.test(sourceId)) continue;
    want.push({ order: Number(order), sourceId, entry });
  }
}

// --- Reading log --------------------------------------------------------------------
const log = [];
for (const t of tables(section("Reading log"))) {
  const yearSection = t.heading;
  for (const r of t.rows) {
    const [sourceId, title, author, start, end, rating, status] = r;
    if (!/^log-/.test(sourceId)) continue;
    log.push({ sourceId, title: title.trim(), author: nul(author), start: nul(start), end: nul(end), rating: nul(rating) === null ? null : Number(rating), status, yearSection });
  }
}

// --- Notes and purposes -------------------------------------------------------------
const notes = new Map(); // sourceId -> {purpose, notes}
{
  const text = section("Notes and reading purposes");
  const blocks = text.split(/^### /m).slice(1);
  for (const b of blocks) {
    const id = /^(log-\d+|want-\d+)/.exec(b)?.[1];
    if (!id) continue;
    const get = (label) => {
      const m = new RegExp(`\\*\\*${label}:\\*\\*\\s*\\n\\s*\\n((?:> .*\\n?)+)`).exec(b);
      return m ? m[1].split("\n").filter((x) => x.startsWith("> ")).map((x) => x.slice(2)).join("\n").trim() : null;
    };
    notes.set(id, { purpose: get("Purpose"), notes: get("Notes") });
  }
}

// --- Original raw end values (e.g. "pass") ---------------------------------------------
const rawEnd = new Map();
for (const t of tables(section("Original date values"))) {
  for (const r of t.rows) if (/^log-/.test(r[0])) rawEnd.set(r[0], { rawStart: nul(r[1]), rawEnd: nul(r[2]) });
}

// --- Unresolved ---------------------------------------------------------------------
const unresolved = [];
for (const t of tables(section("Unmatched ratings and purposes"))) {
  for (const r of t.rows) if (/^unresolved-/.test(r[0])) unresolved.push({ sourceId: r[0], cells: r[1], rating: r[2], purpose: r[3] });
}

// --- Build books and sessions -------------------------------------------------------
const books = new Map(); // normTitle -> book
const sessions = [];
const stamp = (dateStr, seq) => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCSeconds(d.getUTCSeconds() + seq);
  return d.toISOString();
};
let seq = 0;

for (const e of log) {
  seq++;
  const k = norm(e.title);
  const meta = notes.get(e.sourceId) ?? {};
  let book = books.get(k);
  if (!book) {
    book = {
      id: key(["book", k]),
      title: e.title,
      authors: [],
      author_unknown: true,
      library_status: "unknown",
      why_read: null,
      notes: null,
      import_source: { workbook: WORKBOOK, worksheet: WORKSHEET, source_ids: [], sections: [] },
      created_at: null,
      _order: seq,
    };
    books.set(k, book);
  }
  if (e.author && !book.authors.some((a) => a.toLowerCase() === e.author.toLowerCase())) {
    book.authors.push(e.author);
    book.author_unknown = false;
  }
  if (meta.purpose) book.why_read = book.why_read ? `${book.why_read} / ${meta.purpose}` : meta.purpose;
  book.import_source.source_ids.push(e.sourceId);
  if (!book.import_source.sections.includes(e.yearSection)) book.import_source.sections.push(e.yearSection);

  let status;
  if (e.status === "finished") status = "finished";
  else status = "unknown"; // started_completion_unknown, unknown, unresolved_pass
  const anchor = e.end ?? e.start ?? `${e.yearSection}-07-01`;
  const session = {
    id: key(["session", e.sourceId]),
    book_id: book.id,
    started_on: e.start,
    finished_on: e.end,
    status,
    rating: e.rating,
    notes: meta.notes ?? null,
    import_source: {
      workbook: WORKBOOK, worksheet: WORKSHEET, source_id: e.sourceId, section: e.yearSection, source_status: e.status,
      ...(rawEnd.get(e.sourceId)?.rawEnd && !e.end ? { raw_end: rawEnd.get(e.sourceId).rawEnd } : {}),
      ...(e.start && e.end === null && e.status === "started_completion_unknown" ? { note: "Start date only; completion unknown, not necessarily in progress" } : {}),
      ...(!e.start && !e.end ? { note: `Undated row in the ${e.yearSection} section; reading year unconfirmed` } : {}),
    },
    created_at: stamp(anchor, seq),
    _anchor: anchor,
  };
  sessions.push(session);
  if (!book.created_at || session.created_at < book.created_at) book.created_at = session.created_at;
}

// Book status follows its latest session (by anchor date, then row order).
for (const book of books.values()) {
  const own = sessions.filter((s) => s.book_id === book.id).sort((a, b) => (a._anchor < b._anchor ? -1 : a._anchor > b._anchor ? 1 : a.created_at < b.created_at ? -1 : 1));
  const latest = own[own.length - 1];
  book.library_status = latest.status === "finished" ? "finished" : "unknown";
}

// Want to read: separate records (only merged when the title matches a log title exactly).
const wantBooks = [];
for (const w of want) {
  let title = w.entry;
  let author = null;
  const by = /^(.*?)\s+by\s+([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+)*)$/.exec(w.entry);
  if (by) { title = by[1].trim(); author = by[2].trim(); }
  const k = norm(title);
  const existing = books.get(k);
  if (existing) {
    existing.import_source.source_ids.push(w.sourceId);
    existing.import_source.want_order = w.order;
    continue;
  }
  wantBooks.push({
    id: key(["book", "want", k]),
    title,
    authors: author ? [author] : [],
    author_unknown: !author,
    library_status: "want_to_read",
    why_read: null,
    notes: by ? `Original entry: ${w.entry}` : null,
    import_source: { workbook: WORKBOOK, worksheet: WORKSHEET, source_ids: [w.sourceId], want_order: w.order, column: "J" },
    created_at: new Date(Date.UTC(2026, 8, 5, 0, 0, w.order)).toISOString(),
  });
}

const allBooks = [...[...books.values()].sort((a, b) => a._order - b._order).map(({ _order, ...b }) => b), ...wantBooks];
const allSessions = sessions.map(({ _anchor, ...s }) => s);

const out = {
  format: "reading-app-export",
  version: 1,
  exportedAt: new Date().toISOString(),
  note: `Seeded from ${WORKBOOK} / ${WORKSHEET}`,
  books: allBooks,
  reading_sessions: allSessions,
  readings: [],
  feedback: [],
};
writeFileSync(outPath, JSON.stringify(out, null, 2));

if (unresolvedPath) {
  const lines = [
    "# Unresolved ratings and purposes (seed import)",
    "",
    `Source: ${WORKBOOK}, worksheet ${WORKSHEET}. These rows had a rating and/or purpose but no title.`,
    "They were NOT imported as books. Identify the book, then add it in the app and attach the rating/purpose.",
    "",
    "| Source ID | Cells | Rating | Purpose (verbatim) |",
    "| --- | --- | --- | --- |",
    ...unresolved.map((u) => `| ${u.sourceId} | ${u.cells} | ${u.rating} | ${u.purpose} |`),
    "",
  ];
  writeFileSync(unresolvedPath, lines.join("\n"));
}

const merged = [...books.values()].filter((b) => b.import_source.source_ids.filter((s) => s.startsWith("log-")).length > 1);
console.log(JSON.stringify({
  logRows: log.length, wantRows: want.length, books: allBooks.length, sessions: allSessions.length,
  mergedTitles: merged.map((b) => `${b.title} (${b.import_source.source_ids.join(", ")})`),
  unresolved: unresolved.length, out: outPath,
}, null, 2));
