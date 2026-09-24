/// <reference path="../supabase/functions/_shared/deno.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCsv } from "../supabase/functions/_shared/csv";
import { buildCsvPlan, parseDateCell, readCell } from "../supabase/functions/api/handlers/booksCsv";
import { normalizeIsbn } from "../supabase/functions/api/handlers/books";
import type { Ctx } from "../supabase/functions/_shared/auth";

beforeEach(() => vi.stubGlobal("Deno", { env: { get: () => undefined } }));
afterEach(() => vi.unstubAllGlobals());

const HEADER = "id,title,authors,isbn,edition,topics,library_status,started_on,finished_on,rating,session_notes,notes,why_read,recommended_by,archived_at,created_at";
const book = {
  id: "11111111-1111-1111-1111-111111111111", title: "The Snowball", authors: ["Alice Schroeder"], author_unknown: false, isbn: null, edition: null,
  topics: [], library_status: "finished", started_on: null, finished_on: "2026-05-06", rating: 8.5, session_notes: "Put in the work.", notes: null,
  why_read: null, recommended_by: null, archived_at: null, cover_url: "https://covers.openlibrary.org/b/id/1-M.jpg", updated_at: "2026-09-06T00:00:00Z",
};
const exported = `${book.id},The Snowball,Alice Schroeder,,,,finished,,2026-05-06,8.5,Put in the work.,,,,,2023-07-01T12:01:14+00:00`;
const ctxWith = (books: unknown[]) => {
  const chain: Record<string, unknown> = { select: () => chain, eq: () => chain, then: (r: (v: unknown) => unknown) => Promise.resolve({ data: books, error: null }).then(r) };
  return { ownerId: "o", db: { from: () => chain } } as unknown as Ctx;
};

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, embedded newlines, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"\nthere']]);
  });
  it("detects semicolon-separated files", () => {
    expect(parseCsv("id;title\n1;Dune")).toEqual([["id", "title"], ["1", "Dune"]]);
  });
});

describe("cell reading", () => {
  it("normalises ISBNs and rejects spreadsheet-mangled or mistyped ones", () => {
    expect(normalizeIsbn("978-0-553-38461-1")).toBe("9780553384611");
    expect(normalizeIsbn('"9781982173616"')).toBe("9781982173616");
    expect(normalizeIsbn("see notes")).toBe("see notes");
    expect(readCell("isbn", "9.78055E+12")).toHaveProperty("problem");
    expect(readCell("isbn", "9780553384612")).toHaveProperty("problem");
    expect(readCell("isbn", "0-306-40615-2")).toEqual({ value: "0306406152" });
  });
  it("reads Excel-style dates and friendly statuses", () => {
    expect(parseDateCell("6/15/2023")).toBe("2023-06-15");
    expect(parseDateCell("2023-06-15T00:00:00Z")).toBe("2023-06-15");
    expect(parseDateCell("2/30/2023")).toBe("invalid");
    expect(readCell("library_status", "Want to read")).toEqual({ value: "want_to_read" });
    expect(readCell("rating", "8/10")).toEqual({ value: 8 });
    expect(readCell("authors", "A; B")).toEqual({ value: ["A", "B"] });
  });
});

describe("buildCsvPlan", () => {
  it("finds no changes when an export is uploaded unchanged", async () => {
    const { report, work } = await buildCsvPlan(ctxWith([book]), `${HEADER}\r\n${exported}\r\n`);
    expect(report).toMatchObject({ rows: 1, unchanged: 1, updates: [], creates: [], problems: [] });
    expect(work).toEqual([]);
  });

  it("lists only edited cells, and clears an auto-found cover when the ISBN changes", async () => {
    const edited = exported.replace("Alice Schroeder,,", "Alice Schroeder,9780553384611,").replace(",8.5,", ",9,");
    const { report, work } = await buildCsvPlan(ctxWith([book]), `${HEADER}\n${edited}`);
    expect(report.updates[0].changes).toEqual([
      { field: "isbn", from: null, to: "9780553384611" },
      { field: "rating", from: 8.5, to: 9 },
    ]);
    expect(work[0].body).toEqual({ isbn: "9780553384611", rating: 9, cover_url: null });
  });

  it("keeps a hand-set cover when the ISBN changes", async () => {
    const edited = exported.replace("Alice Schroeder,,", "Alice Schroeder,9780553384611,");
    const { work } = await buildCsvPlan(ctxWith([{ ...book, cover_url: "https://example.com/mine.jpg" }]), `${HEADER}\n${edited}`);
    expect(work[0].body).toEqual({ isbn: "9780553384611" });
  });

  it("reports bad cells without dropping the rest of the row, and skips cut-off rows", async () => {
    const edited = exported.replace("Alice Schroeder,,", "Alice Schroeder,9.78055E+12,").replace(",finished,", ",done,").replace(",8.5,", ",7,");
    const { report, work } = await buildCsvPlan(ctxWith([book]), `${HEADER}\n${edited}\n1ffdb4be-d4fc`);
    expect(work[0].body).toEqual({ rating: 7 });
    expect(report.problems).toHaveLength(3);
    expect(report.problems.join(" ")).toMatch(/spreadsheet.*status "done".*cut off/);
  });

  it("treats a short row's missing cells as unchanged, not cleared", async () => {
    const short = `${book.id},The Snowball,Alice Schroeder,9780553384611`;
    const { work, report } = await buildCsvPlan(ctxWith([book]), `${HEADER}\n${short}`);
    expect(work[0].body).toEqual({ isbn: "9780553384611", cover_url: null });
    expect(report.problems[0]).toMatch(/only 4 of 16 columns/);
  });

  it("adds rows without an id as new books and flags stale rows", async () => {
    const csv = `${HEADER},updated_at\n,Dune,Frank Herbert,,,,want_to_read,,,,,,,,,,\n${exported.replace(",8.5,", ",9,")},2026-01-01T00:00:00Z`;
    const { report, work } = await buildCsvPlan(ctxWith([book]), csv);
    expect(report.creates).toEqual([{ row: 2, title: "Dune" }]);
    expect(work.find((w) => !w.id)?.body).toEqual({ title: "Dune", authors: ["Frank Herbert"], library_status: "want_to_read" });
    expect(report.updates[0].staleWarning).toBe(true);
  });

  it("requires a title column", async () => {
    await expect(buildCsvPlan(ctxWith([]), "foo,bar\n1,2")).rejects.toMatchObject({ status: 422 });
  });
});
