// GET/PUT /v1/model-settings — which provider and models run discovery, and their API keys.
//
// Keys are write-only: a PUT stores them in Supabase Vault and nothing ever returns them;
// reads report only whether a key is set and its last four characters. Only the owner's
// signed-in browser session may change keys or models; integration tokens cannot.
import type { Handler } from "../index.ts";
import type { Ctx } from "../../_shared/auth.ts";
import { ApiError } from "../../_shared/http.ts";
import { bad } from "../../_shared/validate.ts";
import { priceFor } from "../../_shared/pipeline/budget.ts";
import { DEFAULT_COMPARE, isProvider, KEY_NAMES, loadModelSetup, parseCompareEntry, PROVIDER_DEFAULTS, type KeyName, type ModelConfig } from "../../_shared/pipeline/setup.ts";

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{1,79}$/i;

function requireSession(ctx: Ctx) {
  if (ctx.principal !== "session") throw new ApiError(403, "session_required", "Model settings can only be changed from the signed-in website");
}

export async function modelSettingsView(ctx: Ctx) {
  const setup = await loadModelSetup(ctx.db);
  const keys: Record<string, { set: boolean; last4: string | null; source: "settings" | "server" | null }> = {};
  for (const k of KEY_NAMES) {
    const v = setup.keys[k];
    keys[k] = { set: Boolean(v), last4: v ? v.slice(-4) : null, source: setup.keySource[k] ?? null };
  }
  const models = [setup.config.main, setup.config.helper, ...setup.config.compare.map((c) => parseCompareEntry(c)?.model ?? "")].filter(Boolean);
  return {
    config: setup.config,
    saved: setup.saved,
    keys,
    access: setup.keys.typesafe ? "jev" : "text-model",
    defaults: { providers: PROVIDER_DEFAULTS, compare: DEFAULT_COMPARE },
    prices: Object.fromEntries(models.map((m) => [m, priceFor(m)])),
  };
}

export const get: Handler = async (ctx) => {
  requireSession(ctx);
  return { status: 200, body: await modelSettingsView(ctx) };
};

function modelId(v: unknown, field: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!MODEL_ID.test(s)) bad(field, "must be a model id such as gemini-3.8-flash or claude-sonnet-5");
  return s;
}

/**
 * PUT { provider, main, helper, compare?, keys?: { anthropic?, google?, typesafe? } }
 * A key given as a string is stored (replacing any saved key); null removes the saved key;
 * an omitted key is left unchanged.
 */
export const put: Handler = async (ctx, _p, body) => {
  requireSession(ctx);
  if (!isProvider(body.provider)) bad("provider", "must be 'google' or 'anthropic'");
  const config: ModelConfig = {
    provider: body.provider as ModelConfig["provider"],
    main: modelId(body.main, "main"),
    helper: modelId(body.helper, "helper"),
    compare: DEFAULT_COMPARE,
  };
  if (body.compare !== undefined) {
    if (!Array.isArray(body.compare) || body.compare.length > 4) bad("compare", "must be a list of up to 4 'provider:model' entries");
    config.compare = (body.compare as unknown[]).map((c, i) => {
      const parsed = typeof c === "string" ? parseCompareEntry(c) : null;
      if (!parsed || !MODEL_ID.test(parsed.model)) bad(`compare[${i}]`, "must look like google:gemini-3.8-flash");
      return `${parsed!.provider}:${parsed!.model}`;
    });
  }

  const keyUpdates: [KeyName, string | null][] = [];
  if (body.keys !== undefined) {
    const k = body.keys as Record<string, unknown>;
    if (!k || typeof k !== "object" || Array.isArray(k)) bad("keys", "must be an object");
    for (const name of Object.keys(k)) {
      if (!KEY_NAMES.includes(name as KeyName)) bad(`keys.${name}`, "unknown key");
      const v = k[name];
      if (v === null) keyUpdates.push([name as KeyName, null]);
      else if (typeof v === "string" && /^\S{10,400}$/.test(v.trim())) keyUpdates.push([name as KeyName, v.trim()]);
      else bad(`keys.${name}`, "must be an API key (no spaces) or null to remove it");
    }
  }

  for (const [name, secret] of keyUpdates) {
    const { error } = await ctx.db.rpc("set_provider_key", { p_provider: name, p_secret: secret });
    if (error) throw new ApiError(500, "key_store_failed", `Could not store the ${name} key: ${error.message}`);
  }
  const { error } = await ctx.db.rpc("set_model_config", { p_config: config });
  if (error) throw new ApiError(500, "config_store_failed", `Could not save model settings: ${error.message}`);
  return { status: 200, body: await modelSettingsView(ctx) };
};
