// GET /v1/generation-config — the services, rates, spend, and scheduler state behind generation.
// Never returns keys; only whether they are present.
import type { Handler } from "../index.ts";
import { estimateRunUsd, monthlySpend, priceFor, RUN_ESTIMATE_USD } from "../../_shared/pipeline/budget.ts";
import { loadModelSetup, providerReady } from "../../_shared/pipeline/setup.ts";
import { loadSettings } from "./preferences.ts";

export const get: Handler = async (ctx) => {
  const settings = await loadSettings(ctx);
  const [setup, spend, scheduler] = await Promise.all([loadModelSetup(ctx.db), monthlySpend(ctx.db, ctx.ownerId), ctx.db.rpc("scheduler_status")]);
  const { main, helper, provider, compare } = setup.config;
  const access = setup.keys.typesafe ? "jev-latest" : helper;
  return {
    status: 200,
    body: {
      provider: providerReady(setup) ? provider : null,
      models: { ranker: main, helper, classifier: access, comparison: compare },
      access: setup.keys.typesafe ? "jev" : "text-model",
      prices: { [main]: priceFor(main), [helper]: priceFor(helper), [access]: priceFor(access), unit: "USD per million tokens" },
      search: Deno.env.get("EXA_API_KEY") ? "exa" : Deno.env.get("BRAVE_API_KEY") ? "brave" : "free-sources-only",
      freeSources: ["OpenAlex", "arXiv", "Hacker News", "Crossref", "your RSS feeds"],
      estimatePerRunUsd: Object.fromEntries(Object.keys(RUN_ESTIMATE_USD).map((h) => [h, estimateRunUsd(h, main)])),
      monthlySpendUsd: Math.round(spend * 1000) / 1000,
      monthlyCapUsd: Number((settings.budget as { monthly_cap_usd?: number }).monthly_cap_usd ?? 0),
      scheduler: scheduler.data ?? { error: scheduler.error?.message },
      sources: settings.sources ?? [],
    },
  };
};
