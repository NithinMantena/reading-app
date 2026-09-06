import { describe, expect, it } from "vitest";
import { filterBooks, filterReadings } from "../src/lib/queries";
import type { Book, Reading } from "../src/lib/types";

const book = (over: Partial<Book>): Book => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  title: "T", authors: [], author_unknown: false, isbn: null, edition: null, topics: [], cover_url: null, description: null,
  recommended_by: null, why_read: null, notes: null, library_status: "want_to_read", archived_at: null, version: 1,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...over,
});

const reading = (over: Partial<Reading>): Reading => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  canonical_url: null, original_url: null, title: "R", authors: [], publisher: null, published_on: null, published_precision: "unknown",
  published_evidence: {}, item_type: "article", access_class: "unknown", access_evidence: {}, access_checked_at: null, duration_minutes: null,
  topics: [], notes: null, description: null, queue_status: "saved", enrichment_status: "done", recommendation_entry_id: null, version: 1,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...over,
});

describe("filterBooks", () => {
  const items = [
    book({ id: "a", title: "Anathem", authors: ["Neal Stephenson"], library_status: "finished", rating: 9, updated_at: "2026-03-01T00:00:00Z" }),
    book({ id: "b", title: "Bleak House", authors: ["Charles Dickens"], library_status: "reading", rating: null, updated_at: "2026-02-01T00:00:00Z" }),
    book({ id: "c", title: "Cryptonomicon", authors: ["Neal Stephenson"], library_status: "finished", rating: 7, updated_at: "2026-01-01T00:00:00Z" }),
  ];

  it("filters by status and matches title or author case-insensitively", () => {
    expect(filterBooks(items, { status: "finished", sort: "updated", asc: false }).map((b) => b.id)).toEqual(["a", "c"]);
    expect(filterBooks(items, { q: "stephenson", sort: "title", asc: true }).map((b) => b.id)).toEqual(["a", "c"]);
    expect(filterBooks(items, { q: "BLEAK", sort: "title", asc: true }).map((b) => b.id)).toEqual(["b"]);
  });

  it("sorts with nulls last regardless of direction", () => {
    expect(filterBooks(items, { sort: "rating", asc: false }).map((b) => b.id)).toEqual(["a", "c", "b"]);
    expect(filterBooks(items, { sort: "rating", asc: true }).map((b) => b.id)).toEqual(["c", "a", "b"]);
    expect(filterBooks(items, { sort: "updated", asc: false }).map((b) => b.id)).toEqual(["a", "b", "c"]);
  });
});

describe("filterReadings", () => {
  const items = [
    reading({ id: "s", title: "Saved one", queue_status: "saved", publisher: "Aeon" }),
    reading({ id: "f", title: "Finished one", queue_status: "finished", canonical_url: "https://example.org/x" }),
    reading({ id: "x", title: "Archived one", queue_status: "archived" }),
  ];

  it("hides archived items by default and shows them when asked", () => {
    expect(filterReadings(items, {}).map((r) => r.id)).toEqual(["s", "f"]);
    expect(filterReadings(items, { status: "archived" }).map((r) => r.id)).toEqual(["x"]);
  });

  it("searches title, publisher, and URL", () => {
    expect(filterReadings(items, { q: "aeon" }).map((r) => r.id)).toEqual(["s"]);
    expect(filterReadings(items, { q: "example.org" }).map((r) => r.id)).toEqual(["f"]);
  });
});
