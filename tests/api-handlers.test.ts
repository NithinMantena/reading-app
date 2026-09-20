/// <reference path="../supabase/functions/_shared/deno.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../supabase/functions/_shared/auth";
import type { Handler } from "../supabase/functions/api/index";
import * as preferences from "../supabase/functions/api/handlers/preferences";
import * as recommendations from "../supabase/functions/api/handlers/recommendations";
import * as jobs from "../supabase/functions/api/handlers/jobs";
import * as feedback from "../supabase/functions/api/handlers/feedback";
import { parseInterests } from "../supabase/functions/_shared/interests";
import { publicationFits, windowFromStored } from "../supabase/functions/_shared/periods";

const owner = "11111111-1111-1111-1111-111111111111";
const batchId = "22222222-2222-2222-2222-222222222222";
const entryId = "33333333-3333-3333-3333-333333333333";
const readingId = "44444444-4444-4444-4444-444444444444";
const settings = { owner_id: owner, version: 3, interests: [{ topic: "History", weight: 2 }], time_zone: "America/Chicago", budget: { monthly_cap_usd: 10 } };
const edition = { id: batchId, owner_id: owner, horizon: "daily", period_key: "2026-01-10", version: 2, status: "published", window_start: "2026-01-09T18:30:00.000Z", window_end: "2026-01-10T18:30:00.000Z", window_label: "January 10, 2026", time_zone: "Asia/Kolkata" };

interface Query { table: string; operation: string; payload?: unknown; filters: [string, unknown][] }
interface Step { table: string; data?: unknown; error?: { code: string; message: string }; check?: (q: Query) => void }

// Scripted database responses keep tests focused on handler behavior and the filters sent
// to Postgres. A write conflict can be injected between reads without a live database.
function context(steps: Step[]) {
  const pending = [...steps];
  const calls: Query[] = [];
  const db = {
    from(table: string) {
      const query: Query = { table, operation: "select", filters: [] };
      const finish = () => {
        calls.push(query);
        const step = pending.shift();
        expect(step, `Unexpected ${query.operation} on ${table}`).toBeDefined();
        expect(table).toBe(step!.table);
        step!.check?.(query);
        return { data: step!.data ?? null, error: step!.error ?? null, count: Array.isArray(step!.data) ? step!.data.length : null };
      };
      const chain = {
        select: (_columns?: string, _opts?: unknown) => chain,
        update: (payload: unknown) => { query.operation = "update"; query.payload = payload; return chain; },
        insert: (payload: unknown) => { query.operation = "insert"; query.payload = payload; return chain; },
        eq: (k: string, v: unknown) => { query.filters.push([k, v]); return chain; },
        in: (k: string, v: unknown) => { query.filters.push([k, v]); return chain; },
        order: (_k: string, _o?: unknown) => chain,
        limit: (_n: number) => chain,
        range: (_lo: number, _hi: number) => chain,
        single: async () => finish(),
        maybeSingle: async () => finish(),
        then: (resolve: (v: ReturnType<typeof finish>) => unknown) => Promise.resolve(finish()).then(resolve),
      };
      return chain;
    },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  };
  const ctx: Ctx = { ownerId: owner, principal: "token", source: "openclaw", requestId: "test", scopes: new Set(["read", "library:write", "preferences:write", "feedback:write", "generation"]), db: db as unknown as Ctx["db"] };
  return { ctx, calls, done: () => expect(pending).toHaveLength(0) };
}

function invoke(handler: Handler, ctx: Ctx, body: Record<string, unknown> = {}, params: Record<string, string> = {}, query = "") {
  const url = new URL(`https://app.example/v1/test${query}`);
  return handler(ctx, params, body, url, new Request(url));
}

beforeEach(() => vi.stubGlobal("Deno", { env: { get: () => undefined } }));
afterEach(() => vi.unstubAllGlobals());

describe("incremental interests", () => {
  it("merges an addition into fresh settings after a concurrent edit", async () => {
    const fresh = { ...settings, version: 4, interests: [...settings.interests, { topic: "Biology", weight: 1 }] };
    const c = context([
      { table: "user_settings", data: settings },
      { table: "user_settings", check: (q) => expect(q.filters).toContainEqual(["version", 3]) },
      { table: "user_settings", data: fresh },
      { table: "user_settings", data: { ...fresh, version: 5 }, check: (q) => {
        expect(q.filters).toEqual(expect.arrayContaining([["owner_id", owner], ["version", 4]]));
        expect(q.payload).toEqual({ interests: [...fresh.interests, { topic: "Physics", weight: 1 }] });
      } },
    ]);
    expect((await invoke(preferences.upsertInterest, c.ctx, { topic: "Physics" })).status).toBe(200);
    c.done();
  });

  it("does not reset an existing weight when a topic is added again", async () => {
    const c = context([{ table: "user_settings", data: settings }]);
    expect((await invoke(preferences.upsertInterest, c.ctx, { topic: " history " })).body).toEqual(settings);
    c.done();
  });

  it("changes only the matching interest's weight", async () => {
    const c = context([
      { table: "user_settings", data: settings },
      { table: "user_settings", data: settings, check: (q) => expect(q.payload).toEqual({ interests: [{ topic: "History", weight: 0 }] }) },
    ]);
    await invoke(preferences.upsertInterest, c.ctx, { topic: "history", weight: 0 });
    c.done();
  });

  it("rejects a stale explicit version before writing", async () => {
    const c = context([{ table: "user_settings", data: settings }]);
    await expect(invoke(preferences.upsertInterest, c.ctx, { topic: "Physics", version: 2 })).rejects.toMatchObject({ status: 409 });
    c.done();
  });

  it("removes a topic case-insensitively and preserves unrelated interests", async () => {
    const current = { ...settings, interests: [...settings.interests, { topic: "Physics", weight: 1 }] };
    const c = context([
      { table: "user_settings", data: current },
      { table: "user_settings", data: settings, check: (q) => expect(q.payload).toEqual({ interests: settings.interests }) },
    ]);
    await invoke(preferences.removeInterest, c.ctx, {}, { topic: "PHYSICS" }, "?version=3");
    c.done();
  });

  it("validates replacement lists and normalizes duplicates", () => {
    for (const input of [[null], ["  "], [{ topic: "A", weight: Infinity }], [{ topic: "A", weight: -1 }]]) {
      expect(() => parseInterests(input)).toThrow();
    }
    expect(parseInterests([" Art   history ", { topic: "art history", weight: 2 }])).toEqual([{ topic: "art history", weight: 2 }]);
  });
});

describe("discovery and alternatives", () => {
  it("returns an archived edition's actual window and original time zone", async () => {
    const c = context([
      { table: "user_settings", data: settings },
      { table: "recommendation_batches", data: edition },
      { table: "generation_jobs" },
      { table: "recommendation_entries", data: [] },
    ]);
    const result = await invoke(recommendations.get, c.ctx, {}, {}, "?horizon=daily&period=2026-01-10");
    expect(result.body).toMatchObject({ isCurrent: false, window: { start: edition.window_start, end: edition.window_end, timeZone: "Asia/Kolkata", label: edition.window_label } });
    c.done();
  });

  it("requires a horizon for period/version lookup", async () => {
    const c = context([{ table: "user_settings", data: settings }]);
    await expect(invoke(recommendations.get, c.ctx, {}, {}, "?period=2026-01-10")).rejects.toMatchObject({ status: 422 });
    c.done();
  });

  it("does not return an invented window for a missing historical edition", async () => {
    const c = context([{ table: "user_settings", data: settings }, { table: "recommendation_batches" }, { table: "generation_jobs" }]);
    await expect(invoke(recommendations.get, c.ctx, {}, {}, "?horizon=daily&period=2020-01-01")).rejects.toMatchObject({ status: 404 });
    c.done();
  });

  it("looks up a single published recommendation with owner filtering", async () => {
    const c = context([{ table: "recommendation_entries", data: { id: entryId, batch: edition, reading: { id: readingId } }, check: (q) => {
      expect(q.filters).toEqual(expect.arrayContaining([["owner_id", owner], ["id", entryId], ["batch.status", ["published", "partial"]]]));
    } }]);
    expect((await invoke(recommendations.getEntry, c.ctx, {}, { id: entryId })).body).toMatchObject({ id: entryId, reading: { id: readingId } });
    c.done();
  });

  it("queues alternatives using the selected edition's period instead of today's", async () => {
    const c = context([
      { table: "user_settings", data: settings },
      { table: "recommendation_batches", data: edition, check: (q) => expect(q.filters).toContainEqual(["owner_id", owner]) },
      { table: "generation_jobs", data: { id: "job" }, check: (q) => expect(q.payload).toMatchObject({
        horizon: "daily", kind: "alternatives", period_key: edition.period_key,
        checkpoint: { sourceBatchId: batchId, window: { start: edition.window_start, end: edition.window_end, timeZone: edition.time_zone } },
      }) },
    ]);
    expect((await invoke(jobs.create, c.ctx, { kind: "alternatives", batch_id: batchId })).status).toBe(202);
    c.done();
  });

  it("rejects a different horizon from the selected edition", async () => {
    const c = context([{ table: "user_settings", data: settings }, { table: "recommendation_batches", data: edition }]);
    await expect(invoke(jobs.create, c.ctx, { kind: "alternatives", batch_id: batchId, horizon: "weekly" })).rejects.toMatchObject({ status: 422 });
    c.done();
  });

  it("does not queue work for another owner's or unpublished batch", async () => {
    const c = context([{ table: "user_settings", data: settings }, { table: "recommendation_batches", check: (q) => {
      expect(q.filters).toEqual(expect.arrayContaining([["owner_id", owner], ["status", ["published", "partial"]]]));
    } }]);
    await expect(invoke(jobs.create, c.ctx, { kind: "alternatives", batch_id: batchId })).rejects.toMatchObject({ status: 404 });
    c.done();
  });

  it("restores publication dates east of UTC without shifting them back a day", () => {
    const w = windowFromStored("daily", { start: edition.window_start, end: edition.window_end, timeZone: edition.time_zone, periodKey: edition.period_key, label: edition.window_label });
    expect(publicationFits({ year: 2026, month: 1, day: 10 }, "day", w)).toBe(true);
    expect(publicationFits({ year: 2026, month: 1, day: 9 }, "day", w)).toBe(false);
    expect(w.endDate).toEqual({ year: 2026, month: 1, day: 11 });
  });

  it("saves a recommendation with its provenance and preserves in-progress/completed readings", async () => {
    const entry = { id: entryId, batch_id: batchId, reading_id: readingId };
    const c = context([
      { table: "recommendation_entries", data: entry },
      { table: "reading_items", check: (q) => {
        expect(q.payload).toEqual({ queue_status: "saved", recommendation_entry_id: entryId, source_batch_id: batchId });
        expect(q.filters).toContainEqual(["queue_status", ["candidate", "archived"]]);
      } },
      { table: "recommendation_entries", data: { ...entry, state: "saved" } },
    ]);
    await invoke(recommendations.patchEntry, c.ctx, { state: "saved" }, { id: entryId });
    c.done();
  });

  it("does not report saved when the queue write failed", async () => {
    const c = context([
      { table: "recommendation_entries", data: { id: entryId, reading_id: readingId } },
      { table: "reading_items", error: { code: "23514", message: "Rejected" } },
    ]);
    await expect(invoke(recommendations.patchEntry, c.ctx, { state: "saved" }, { id: entryId })).rejects.toMatchObject({ status: 422 });
    c.done();
  });
});

describe("feedback from a recommendation", () => {
  it("resolves the reading and metadata when only an entry ID is supplied", async () => {
    const c = context([
      { table: "recommendation_entries", data: { reading_id: readingId }, check: (q) => expect(q.filters).toContainEqual(["owner_id", owner]) },
      { table: "reading_items", data: { topics: ["History"], publisher: "Publisher" } },
      { table: "feedback_events", data: { id: "feedback" }, check: (q) => expect(q.payload).toMatchObject({ reading_id: readingId, recommendation_entry_id: entryId, topics: ["History"], publisher: "Publisher", action: "too_long" }) },
    ]);
    await invoke(feedback.create, c.ctx, { action: "too_long", recommendation_entry_id: entryId });
    c.done();
  });

  it("rejects feedback pointing to a different reading", async () => {
    const c = context([{ table: "recommendation_entries", data: { reading_id: readingId } }]);
    await expect(invoke(feedback.create, c.ctx, { action: "too_long", reading_id: owner, recommendation_entry_id: entryId })).rejects.toMatchObject({ status: 422 });
    c.done();
  });
});
