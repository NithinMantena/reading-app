// Tiny validation helpers (no external dependency). Each returns the cleaned value or throws ApiError.
import { ApiError } from "./http.ts";

export function bad(field: string, message: string): never {
  throw new ApiError(422, "validation_failed", `${field}: ${message}`, { field });
}

export function optString(v: unknown, field: string, max = 4000): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string") bad(field, "must be a string");
  if (v.length > max) bad(field, `must be at most ${max} characters`);
  return v.trim();
}

export function reqString(v: unknown, field: string, max = 4000): string {
  const s = optString(v, field, max);
  if (!s) bad(field, "is required");
  return s;
}

export function optStringArray(v: unknown, field: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (v === null) return [];
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) bad(field, "must be an array of strings");
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
}

export function optEnum<T extends string>(v: unknown, field: string, values: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !values.includes(v as T)) bad(field, `must be one of ${values.join(", ")}`);
  return v as T;
}

export function optDate(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad(field, "must be YYYY-MM-DD");
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) bad(field, "is not a real calendar date");
  return v;
}

/** Rating 0–10 inclusive, one decimal, null = unrated (distinct from 0). */
export function optRating(v: unknown, field = "rating"): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || Number.isNaN(n)) bad(field, "must be a number");
  if (n < 0 || n > 10) bad(field, "must be between 0 and 10");
  return Math.round(n * 10) / 10;
}

export function optBool(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  bad(field, "must be a boolean");
}

export function optInt(v: unknown, field: string, min = 0, max = 1_000_000): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isInteger(n)) bad(field, "must be an integer");
  if ((n as number) < min || (n as number) > max) bad(field, `must be between ${min} and ${max}`);
  return n as number;
}

export function optVersion(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) bad("version", "must be a positive integer");
  return n;
}

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
