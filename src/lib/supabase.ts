import { createClient } from "@supabase/supabase-js";

// Empty strings (e.g. unset CI variables) count as unconfigured.
export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || undefined;
export const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || undefined;

export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = createClient(
  SUPABASE_URL ?? "https://placeholder.supabase.co",
  SUPABASE_ANON_KEY ?? "placeholder",
  { auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

/** Base URL of the versioned API served by the `api` Edge Function. */
export const API_BASE = `${SUPABASE_URL ?? ""}/functions/v1/api/v1`;
