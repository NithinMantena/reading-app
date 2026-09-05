// Spend accounting. Prices are USD per million tokens (Anthropic first-party, 2026-06).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CostLedger, ModelCall } from "./types.ts";

export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

/** Rough per-run reservation by horizon, used to stop before exceeding the cap. */
export const RUN_ESTIMATE_USD: Record<string, number> = {
  daily: 0.35,
  weekly: 0.6,
  monthly: 0.6,
  yearly: 0.9,
  decade: 0.9,
};

export function priceCall(model: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5"];
  return (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 1_000_000;
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
