import type { AccessClass, DatePrecision, LibraryStatus, QueueStatus } from "./types";

export function todayLocal(timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export function fmtDate(iso: string | null | undefined, precision: DatePrecision = "day"): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (precision === "year") return String(y);
  if (precision === "month") return date.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function fmtMinutes(min: number | null | undefined): string {
  if (!min) return "";
  if (min < 60) return `~${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `~${h} h ${m} min` : `~${h} h`;
}

export function fmtRating(r: number | null | undefined): string {
  if (r === null || r === undefined) return "Unrated";
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export const LIBRARY_STATUS_LABEL: Record<LibraryStatus, string> = {
  want_to_read: "Want to read",
  reading: "Reading",
  finished: "Finished",
  stopped: "Stopped",
};

export const QUEUE_STATUS_LABEL: Record<QueueStatus, string> = {
  candidate: "Suggested",
  saved: "Saved",
  reading: "Reading",
  finished: "Finished",
  archived: "Archived",
};

export const ACCESS_LABEL: Record<AccessClass, string> = {
  free_full_text: "Free full text",
  open_copy: "Open copy",
  nyt_subscription: "NYT subscription",
  preview_only: "Preview only",
  paywall: "Paywalled",
  unknown: "Access unverified",
};

export function authorsText(authors: string[], unknown = false): string {
  if (unknown || !authors?.length) return "Unknown author";
  return authors.join(", ");
}

export function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
