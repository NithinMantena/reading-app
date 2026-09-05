// GET /v1/generation-config — the services, rates, spend, and scheduler state behind generation.
// Never returns keys; only whether they are present.
import type { Handler } from "../index.ts";
import { PRICES, RUN_ESTIMATE_USD, monthlySpend } from "../../_shared/pipeline/budget.ts";
import { loadSettings } from "./preferences.ts";

export const get: Handler = async (ctx) => {
  const settings = await loadSettings(ctx);
  const ranker = Deno.env.get("RANKER_MODEL") ?? "claude-opus-5";
  const classifier = Deno.env.get("CLASSIFIER_MODEL") ?? "claude-haiku-4-5";
  const [spend, scheduler] = await Promise.all([monthlySpend(ctx.db, ctx.ownerId), ctx.db.rpc("scheduler_status")]);
  return {
    status: 200,
    body: {
      provider: Deno.env.get("ANTHROPIC_API_KEY") ? "anthropic" : null,
      models: { ranker, classifier, comparison: Deno.env.get("COMPARISON_MODEL") ?? "claude-sonnet-5" },
      prices: { [ranker]: PRICES[ranker] ?? null, [classifier]: PRICES[classifier] ?? null, unit: "USD per million tokens" },
      search: Deno.env.get("EXA_API_KEY") ? "exa" : Deno.env.get("BRAVE_API_KEY") ? "brave" : "free-sources-only",
      freeSources: ["OpenAlex", "arXiv", "Hacker News", "Crossref", "your RSS feeds"],
      estimatePerRunUsd: RUN_ESTIMATE_USD,
      monthlySpendUsd: Math.round(spend * 1000) / 1000,
      monthlyCapUsd: Number((settings.budget as { monthly_cap_usd?: number }).monthly_cap_usd ?? 0),
      scheduler: scheduler.data ?? { error: scheduler.error?.message },
      sources: settings.sources ?? [],
    },
  };
};
