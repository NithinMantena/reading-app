// Which provider and models run discovery, and the keys they use.
//
// Chosen on the Preferences page and stored by the database: the choice in
// private.app_config, the API keys in Supabase Vault. Edge-function secrets remain a
// fallback (ANTHROPIC_API_KEY, GEMINI_API_KEY, TYPESAFE_API_KEY) so an existing deployment
// keeps working before anything is saved.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Provider } from "./llm.ts";

export type KeyName = Provider | "typesafe";
export const KEY_NAMES: KeyName[] = ["anthropic", "google", "typesafe"];
const ENV_KEYS: Record<KeyName, string> = { anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY", typesafe: "TYPESAFE_API_KEY" };

export interface ModelConfig {
  provider: Provider;
  /** Ranks candidates and suggests readings for long horizons. */
  main: string;
  /** Writes search queries and settles access checks Jev is unsure about. */
  helper: string;
  /** "provider:model" entries ranked side by side by a model_comparison job. */
  compare: string[];
}

export const PROVIDER_DEFAULTS: Record<Provider, { main: string; helper: string }> = {
  anthropic: { main: "claude-opus-5", helper: "claude-haiku-4-5" },
  google: { main: "gemini-3.8-flash", helper: "gemini-3.8-flash" },
};
export const DEFAULT_COMPARE = ["anthropic:claude-opus-5", "google:gemini-3.8-flash", "anthropic:claude-sonnet-5"];

export interface ModelSetup {
  config: ModelConfig;
  /** true when config came from the Preferences page rather than defaults. */
  saved: boolean;
  keys: Partial<Record<KeyName, string>>;
  keySource: Partial<Record<KeyName, "settings" | "server">>;
  /** Set when saved settings could not be read; defaults and server keys are in use. */
  loadError?: string;
}

const env = (name: string): string | undefined => (typeof Deno !== "undefined" ? Deno.env.get(name) : undefined) || undefined;

export function isProvider(v: unknown): v is Provider {
  return v === "anthropic" || v === "google";
}

export function parseCompareEntry(s: string): { provider: Provider; model: string } | null {
  const [p, ...rest] = s.split(":");
  const model = rest.join(":").trim();
  return isProvider(p) && model ? { provider: p, model } : null;
}

/** Merge a stored config (possibly partial or absent) with defaults. */
export function resolveConfig(stored: Partial<ModelConfig> | null, keys: Partial<Record<KeyName, string>>): ModelConfig {
  const provider: Provider = isProvider(stored?.provider)
    ? stored!.provider
    : keys.anthropic ? "anthropic" : keys.google ? "google" : "anthropic";
  const d = PROVIDER_DEFAULTS[provider];
  // Legacy env overrides only apply to the Anthropic defaults they were written for.
  const envMain = provider === "anthropic" ? env("RANKER_MODEL") : undefined;
  const envHelper = provider === "anthropic" ? env("CLASSIFIER_MODEL") : undefined;
  return {
    provider,
    main: stored?.main?.trim() || envMain || d.main,
    helper: stored?.helper?.trim() || envHelper || d.helper,
    compare: Array.isArray(stored?.compare) && stored!.compare.length ? stored!.compare.filter((s) => parseCompareEntry(s)) : DEFAULT_COMPARE,
  };
}

/** Load the model choice and keys. Service-role only: the RPC returns decrypted keys. */
export async function loadModelSetup(db: SupabaseClient): Promise<ModelSetup> {
  const { data, error } = await db.rpc("model_settings_private");
  const row = (error ? null : data) as { config?: Partial<ModelConfig> | null; keys?: Partial<Record<KeyName, string>> } | null;
  const keys: Partial<Record<KeyName, string>> = {};
  const keySource: Partial<Record<KeyName, "settings" | "server">> = {};
  for (const k of KEY_NAMES) {
    const saved = row?.keys?.[k];
    const fromEnv = env(ENV_KEYS[k]);
    if (saved) { keys[k] = saved; keySource[k] = "settings"; }
    else if (fromEnv) { keys[k] = fromEnv; keySource[k] = "server"; }
  }
  if (error) console.error("model_settings_private failed", error.message);
  return { config: resolveConfig(row?.config ?? null, keys), saved: Boolean(row?.config), keys, keySource, ...(error ? { loadError: error.message } : {}) };
}

export function providerReady(setup: ModelSetup): boolean {
  return Boolean(setup.keys[setup.config.provider]);
}
