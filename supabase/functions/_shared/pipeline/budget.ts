// Spend accounting. Prices are USD per million tokens (provider list prices, checked 2026-09-24).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CostLedger, ModelCall } from "./types.ts";

export interface Price { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

export const PRICES: Record<string, Price> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  // Introductory Gemini 3.8 Flash rate; see datedPrice for the 2027 change.
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  // TypeSafe Jev: $42 per billion input tokens; output is free.
  "jev-latest": { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Prices that change on a known date. */
const DATED: Record<string, { from: string; price: Price }[]> = {
  "gemini-3.8-flash": [{ from: "2027-01-01", price: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 } }],
};

/** Conservative stand-in for models this table doesn't know. */
const UNKNOWN_FALLBACK = PRICES["claude-opus-5"];

export function priceFor(model: string, at: Date = new Date()): Price | null {
  const key = model.startsWith("jev-") ? "jev-latest" : model;
  const day = at.toISOString().slice(0, 10);
  const dated = (DATED[key] ?? []).filter((d) => d.from <= day).at(-1);
  return dated?.price ?? PRICES[key] ?? null;
}

export function priceCall(model: string, usage: Usage, at: Date = new Date()): number {
  const p = priceFor(model, at) ?? UNKNOWN_FALLBACK;
  return (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 1_000_000;
}

/**
 * Per-run reservation by horizon when the main model is Claude Opus 5, measured against real
 * runs (daily ≈ $0.04–0.16) with headroom. Other models scale by their price relative to Opus.
 */
export const RUN_ESTIMATE_USD: Record<string, number> = {
  daily: 0.35,
  weekly: 0.6,
  monthly: 0.6,
  yearly: 0.9,
  decade: 0.9,
};
const MIN_RUN_ESTIMATE_USD = 0.02;

export function estimateRunUsd(horizon: string, mainModel: string, at: Date = new Date()): number {
  const base = RUN_ESTIMATE_USD[horizon] ?? 0.6;
  const p = priceFor(mainModel, at) ?? UNKNOWN_FALLBACK;
  const opus = PRICES["claude-opus-5"];
  // Output (including thinking) dominates ranker cost; weight it accordingly.
  const ratio = (p.input + 3 * p.output) / (opus.input + 3 * opus.output);
  return Math.round(Math.max(MIN_RUN_ESTIMATE_USD, base * Math.min(ratio, 2)) * 1000) / 1000;
}

export function recordCall(ledger: CostLedger, call: Omit<ModelCall, "at">): void {
  ledger.calls.push({ ...call, at: new Date().toISOString() });
  ledger.actualUsd = Math.round((ledger.actualUsd + call.usd) * 1e6) / 1e6;
}

/** Sum of recorded spend for the current UTC calendar month. */
export async function monthlySpend(db: SupabaseClient, ownerId: string): Promise<number> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data } = await db.from("generation_jobs").select("cost").eq("owner_id", ownerId).gte("created_at", start);
  let total = 0;
  for (const row of data ?? []) {
    const c = row.cost as { actualUsd?: number; actual_usd?: number } | null;
    total += Number(c?.actualUsd ?? c?.actual_usd ?? 0) || 0;
  }
  return total;
}
