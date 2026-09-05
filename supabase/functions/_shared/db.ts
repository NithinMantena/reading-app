// Small helpers around supabase-js results so handlers stay readable.
import type { PostgrestError } from "@supabase/supabase-js";
import { ApiError } from "./http.ts";

export function must<T>(res: { data: T; error: PostgrestError | null }, what = "record"): NonNullable<T> {
  if (res.error) throw fromPgError(res.error);
  if (res.data === null || res.data === undefined) throw new ApiError(404, "not_found", `${what} not found`);
  return res.data as NonNullable<T>;
}

export function fromPgError(e: PostgrestError): ApiError {
  switch (e.code) {
    case "23505":
      return new ApiError(409, "conflict", "A record with the same unique key already exists", { detail: e.details });
    case "23514":
      return new ApiError(422, "validation_failed", e.message.replace(/^new row .* violates check constraint /, "Constraint: "));
    case "22P02":
      return new ApiError(400, "invalid_value", e.message);
    case "PGRST116":
      return new ApiError(404, "not_found", "Record not found");
    default:
      console.error("db error", e);
      return new ApiError(500, "database_error", e.message);
  }
}

export function pageParams(url: URL, defaultLimit = 100, maxLimit = 500): { limit: number; offset: number } {
  const limit = Math.min(maxLimit, Math.max(1, Number(url.searchParams.get("limit") ?? defaultLimit) || defaultLimit));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  return { limit, offset };
}

export function appLink(path: string): string {
  const base = (Deno.env.get("APP_URL") ?? "https://nithinmantena.github.io/reading-app").replace(/\/$/, "");
  return `${base}${path}`;
}
