/// <reference path="../supabase/functions/_shared/deno.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateRunUsd, priceCall, priceFor } from "../supabase/functions/_shared/pipeline/budget";
import { GeminiText } from "../supabase/functions/_shared/pipeline/llm";
import { JevClient, routeAccess, screenAccess, type JevAnswer } from "../supabase/functions/_shared/pipeline/jev";
import { resolveConfig } from "../supabase/functions/_shared/pipeline/setup";
import { emptyLedger, type Candidate } from "../supabase/functions/_shared/pipeline/types";
import * as models from "../supabase/functions/api/handlers/models";
import type { Ctx } from "../supabase/functions/_shared/auth";

beforeEach(() => vi.stubGlobal("Deno", { env: { get: () => undefined } }));
afterEach(() => vi.unstubAllGlobals());

const choice = (probabilities: Record<string, number>): JevAnswer => ({
  type: "choice", probabilities, confidence: 0.9,
  choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0],
});
const noul = (p: number): JevAnswer => ({ type: "noul", noul: p });
const access = (full: number, abstract: number, teaser: number, listing: number, unclear = 0) =>
  choice({ full_text: full, abstract, teaser, listing, unclear });

describe("routeAccess", () => {
  it("accepts a clear free full text", () => {
    expect(routeAccess({ access: access(0.9, 0.05, 0.05, 0), gated: noul(0.1) }, false).decision).toBe("full_text");
  });
  it("rejects only when Jev is at least 80% sure it is blocked", () => {
    const r = routeAccess({ access: access(0.05, 0, 0.85, 0.1), gated: noul(0.9) }, false);
    expect(r).toMatchObject({ decision: "reject", reason: "teaser or paywalled" });
    expect(routeAccess({ access: access(0.2, 0, 0.7, 0.05, 0.05), gated: noul(0.6) }, false).decision).toBe("uncertain");
  });
  it("sends a likely full text with paywall signs to the text model", () => {
    expect(routeAccess({ access: access(0.8, 0, 0.2, 0), gated: noul(0.6) }, false).decision).toBe("uncertain");
  });
  it("keeps abstracts only with an open-copy source", () => {
    const answers = { access: access(0.1, 0.85, 0.05, 0), gated: noul(0.1) };
    expect(routeAccess(answers, true).decision).toBe("abstract");
    expect(routeAccess(answers, false).decision).toBe("reject");
  });
  it("uses probabilities even when the choice label disagrees by rounding", () => {
    const a = access(0.76, 0.24, 0, 0);
    (a as { choice: string }).choice = "abstract";
    expect(routeAccess({ access: a, gated: noul(0.05) }, false).decision).toBe("full_text");
  });
  it("treats missing answers as uncertain", () => {
    expect(routeAccess({}, false).decision).toBe("uncertain");
  });
});

const cand = (id: string): Candidate => ({
  id, url: `https://example.org/${id}`, originalUrl: `https://example.org/${id}`, title: `Essay ${id}`, authors: [], source: "hn",
  sourceEvidence: {}, precision: "day", dateEvidence: {}, accessClass: "unknown", accessEvidence: { markers: [] },
  text: "word ".repeat(2000), words: 2000, evidenceDepth: "full_text", itemType: "article", topics: [], status: "fetched",
});

describe("Jev access screening", () => {
  it("sends one request per article with the shared question set and records the cost", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { access: access(0.9, 0, 0.1, 0), gated: noul(0.05), substantive: noul(0.8) }, usage: { input_tokens: 1000 } }));
    }) as unknown as typeof fetch;
    const ledger = emptyLedger();
    const out = await screenAccess(new JevClient("k", "jev-latest", fetchImpl), [cand("c1"), cand("c2")], ledger);
    expect(out.map((o) => o.result?.decision)).toEqual(["full_text", "full_text"]);
    expect(bodies).toHaveLength(2);
    expect(Object.keys(bodies[0].questions as object)).toEqual(["access", "gated", "substantive"]);
    expect((bodies[0].state as { article: { opening: string; ending: string } }).article.ending).toHaveLength(600);
    expect(ledger.calls).toEqual([expect.objectContaining({ purpose: "access-jev", input: 2000, output: 0 })]);
  });
  it("returns a null result instead of throwing when Jev rejects the request", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 422 })) as unknown as typeof fetch;
    const [r] = await screenAccess(new JevClient("k", "jev-latest", fetchImpl), [cand("c1")], emptyLedger());
    expect(r.result).toBeNull();
    expect(r.error).toMatch(/Jev 422/);
  });
});

describe("GeminiText", () => {
  it("sends JSON mode with a thinking level, bills thinking as output, and drops thought parts", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent = { url: String(url), init: init! };
      return new Response(JSON.stringify({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hmm", thought: true }, { text: "{\"ok\":true}" }] } }],
        usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 200, candidatesTokenCount: 100, thoughtsTokenCount: 400 },
      }));
    }) as unknown as typeof fetch;
    const ledger = emptyLedger();
    const r = await new GeminiText("key", "gemini-3.8-flash", fetchImpl).complete({ purpose: "rank", system: "s", user: "u", maxTokens: 12000, effort: "high" }, ledger);
    expect(r.text).toBe("{\"ok\":true}");
    expect(r.usage).toEqual({ input: 800, output: 500, cacheRead: 200, cacheWrite: 0 });
    expect(sent!.url).toContain("/models/gemini-3.8-flash:generateContent");
    expect((sent!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("key");
    const body = JSON.parse(String(sent!.init.body));
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "high" }, maxOutputTokens: 44000 });
    expect(ledger.calls[0]).toMatchObject({ model: "gemini-3.8-flash", input: 800, output: 500 });
  });
  it("keeps the status in errors so rate limits are retried by the runner", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 400 })) as unknown as typeof fetch;
    await expect(new GeminiText("k", "gemini-3.8-flash", fetchImpl).complete({ purpose: "q", system: "s", user: "u", maxTokens: 100 }, emptyLedger())).rejects.toThrow("Gemini 400: quota");
  });
  it("reports truncation and safety stops", async () => {
    const reply = (finishReason: string) => vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason, content: { parts: [] } }], usageMetadata: {} }))) as unknown as typeof fetch;
    await expect(new GeminiText("k", "gemini-3.8-flash", reply("MAX_TOKENS")).complete({ purpose: "q", system: "s", user: "u", maxTokens: 100 }, emptyLedger())).rejects.toThrow(/truncated/);
    await expect(new GeminiText("k", "gemini-3.8-flash", reply("SAFETY")).complete({ purpose: "q", system: "s", user: "u", maxTokens: 100 }, emptyLedger())).rejects.toThrow(/declined \(SAFETY\)/);
  });
});

describe("pricing and estimates", () => {
  it("switches Gemini 3.8 Flash to its 2027 price", () => {
    expect(priceFor("gemini-3.8-flash", new Date("2026-12-31T12:00:00Z"))?.input).toBe(0.75);
    expect(priceFor("gemini-3.8-flash", new Date("2027-01-01T12:00:00Z"))?.input).toBe(1.5);
  });
  it("prices Jev input only", () => {
    expect(priceCall("jev-latest", { input: 1_000_000, output: 5000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.042);
  });
  it("scales the per-run reservation with the main model", () => {
    const at = new Date("2026-10-01T00:00:00Z");
    expect(estimateRunUsd("daily", "claude-opus-5", at)).toBe(0.35);
    expect(estimateRunUsd("daily", "gemini-3.8-flash", at)).toBeCloseTo(0.053, 3);
    expect(estimateRunUsd("daily", "some-unknown-model", at)).toBe(0.35);
  });
});

describe("resolveConfig", () => {
  it("defaults to the provider that has a key", () => {
    expect(resolveConfig(null, { google: "g" })).toMatchObject({ provider: "google", main: "gemini-3.8-flash", helper: "gemini-3.8-flash" });
    expect(resolveConfig(null, { anthropic: "a" })).toMatchObject({ provider: "anthropic", main: "claude-opus-5", helper: "claude-haiku-4-5" });
  });
  it("keeps saved choices and drops malformed comparison entries", () => {
    const c = resolveConfig({ provider: "google", main: "gemini-x", helper: "gemini-y", compare: ["google:gemini-x", "nonsense"] }, {});
    expect(c).toEqual({ provider: "google", main: "gemini-x", helper: "gemini-y", compare: ["google:gemini-x"] });
  });
});

describe("model settings API", () => {
  const ctxFor = (principal: "session" | "token") => {
    const rpc = vi.fn(async (_name: string, _args?: unknown) => ({ data: null, error: null }));
    const ctx = { ownerId: "o", principal, source: "website", requestId: "t", scopes: new Set(["admin"]), db: { rpc } } as unknown as Ctx;
    return { ctx, rpc };
  };
  const call = (handler: typeof models.put, ctx: Ctx, body: Record<string, unknown> = {}) => {
    const url = new URL("https://app.example/v1/model-settings");
    return handler(ctx, {}, body, url, new Request(url));
  };

  it("refuses integration tokens", async () => {
    await expect(call(models.get, ctxFor("token").ctx)).rejects.toMatchObject({ status: 403 });
    await expect(call(models.put, ctxFor("token").ctx, { provider: "google", main: "gemini-3.8-flash", helper: "gemini-3.8-flash" })).rejects.toMatchObject({ status: 403 });
  });

  it("stores keys through the vault RPC and never returns them", async () => {
    const { ctx, rpc } = ctxFor("session");
    const res = await call(models.put, ctx, { provider: "google", main: "gemini-3.8-flash", helper: "gemini-3.8-flash", keys: { google: "AIza-test-key-123456", typesafe: null } });
    expect(rpc).toHaveBeenCalledWith("set_provider_key", { p_provider: "google", p_secret: "AIza-test-key-123456" });
    expect(rpc).toHaveBeenCalledWith("set_provider_key", { p_provider: "typesafe", p_secret: null });
    expect(rpc).toHaveBeenCalledWith("set_model_config", { p_config: expect.objectContaining({ provider: "google", main: "gemini-3.8-flash" }) });
    expect(JSON.stringify(res.body)).not.toContain("AIza-test-key-123456");
  });

  it("validates provider, model ids and keys", async () => {
    const { ctx } = ctxFor("session");
    await expect(call(models.put, ctx, { provider: "openai", main: "x1", helper: "x1" })).rejects.toMatchObject({ status: 422 });
    await expect(call(models.put, ctx, { provider: "google", main: "bad model", helper: "gemini-3.8-flash" })).rejects.toMatchObject({ status: 422 });
    await expect(call(models.put, ctx, { provider: "google", main: "gemini-3.8-flash", helper: "gemini-3.8-flash", keys: { google: "short" } })).rejects.toMatchObject({ status: 422 });
    await expect(call(models.put, ctx, { provider: "google", main: "gemini-3.8-flash", helper: "gemini-3.8-flash", compare: ["openai:gpt"] })).rejects.toMatchObject({ status: 422 });
  });
});
