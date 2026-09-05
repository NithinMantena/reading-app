// Typed client for the /v1 API. All writes go through here so the website and the
// OpenClaw bot share one set of business rules.
import { API_BASE, supabase } from "./supabase";
import type {
  Book, FeedbackEvent, IntegrationToken, Job, Paged, Reading, ReadingSession, Settings, Shelf, Batch,
} from "./types";

export class ApiClientError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiClientError(401, "unauthenticated", "Please sign in");
  return { authorization: `Bearer ${token}` };
}

function idempotencyKey(): string {
  return crypto.randomUUID();
}

async function call<T>(method: string, path: string, body?: unknown, opts: { idempotent?: boolean; raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(await authHeader()) };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotent) headers["idempotency-key"] = idempotencyKey();
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (opts.raw) {
    if (!res.ok) throw new ApiClientError(res.status, "request_failed", await res.text());
    return (await res.text()) as unknown as T;
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiClientError(res.status, e.code ?? "request_failed", e.message ?? res.statusText, e.details);
  }
  return json as T;
}

const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  me: () => call<{ timeZone: string; onboardingComplete: boolean; windows: Record<string, { periodKey: string; label: string }> }>("GET", "/me"),

  books: {
    list: (params: Record<string, string | number | boolean | undefined> = {}) => call<Paged<Book>>("GET", `/books${qs(params)}`),
    get: (id: string) => call<Book>("GET", `/books/${id}`),
    create: (body: Record<string, unknown>) => call<Book & { existing?: boolean }>("POST", "/books", body, { idempotent: true }),
    patch: (id: string, body: Record<string, unknown>) => call<Book>("PATCH", `/books/${id}`, body),
    remove: (id: string) => call<{ deleted: boolean }>("DELETE", `/books/${id}`),
    createSession: (id: string, body: Record<string, unknown>) =>
      call<{ session: ReadingSession; book: Book }>("POST", `/books/${id}/sessions`, body, { idempotent: true }),
    patchSession: (id: string, body: Record<string, unknown>) =>
      call<{ session: ReadingSession; book: Book }>("PATCH", `/reading-sessions/${id}`, body),
  },

  readings: {
    list: (params: Record<string, string | number | boolean | undefined> = {}) => call<Paged<Reading>>("GET", `/readings${qs(params)}`),
    get: (id: string) => call<Reading>("GET", `/readings/${id}`),
    create: (body: Record<string, unknown>) => call<Reading>("POST", "/readings", body, { idempotent: true }),
    patch: (id: string, body: Record<string, unknown>) => call<Reading>("PATCH", `/readings/${id}`, body),
    remove: (id: string) => call<{ deleted: boolean }>("DELETE", `/readings/${id}`),
  },

  recommendations: {
    all: () => call<{ shelves: Shelf[] }>("GET", "/recommendations"),
    shelf: (horizon: string, period?: string, version?: number) =>
      call<Shelf>("GET", `/recommendations${qs({ horizon, period, version })}`),
    archive: (horizon?: string) => call<Paged<Batch>>("GET", `/recommendations/archive${qs({ horizon })}`),
    patchEntry: (id: string, state: string) => call<unknown>("PATCH", `/recommendation-entries/${id}`, { state }),
  },

  feedback: {
    list: (params: Record<string, string | undefined> = {}) => call<Paged<FeedbackEvent>>("GET", `/feedback${qs(params)}`),
    create: (body: Record<string, unknown>) => call<FeedbackEvent>("POST", "/feedback", body, { idempotent: true }),
    patch: (id: string, body: Record<string, unknown>) => call<FeedbackEvent>("PATCH", `/feedback/${id}`, body),
    remove: (id: string) => call<{ deleted: boolean }>("DELETE", `/feedback/${id}`),
  },

  preferences: {
    get: () => call<Settings>("GET", "/preferences"),
    patch: (body: Partial<Settings> & { version?: number }) => call<Settings>("PATCH", "/preferences", body),
    summary: () => call<{ explicit: unknown; derived: unknown; activeFeedbackCount: number; note?: string }>("GET", "/preference-summary"),
  },

  jobs: {
    create: (body: { kind: string; horizon?: string }) => call<{ jobs: Job[]; warnings: string[] }>("POST", "/recommendation-jobs", body, { idempotent: true }),
    list: () => call<Paged<Job>>("GET", "/jobs"),
    get: (id: string) => call<Job>("GET", `/jobs/${id}`),
  },

  tokens: {
    list: () => call<{ items: IntegrationToken[] }>("GET", "/integration-tokens"),
    create: (body: { name: string; scopes?: string[]; expires_in_days?: number }) => call<IntegrationToken>("POST", "/integration-tokens", body),
    revoke: (id: string) => call<{ revoked: boolean }>("DELETE", `/integration-tokens/${id}`),
  },

  transfer: {
    exportJson: () => call<Record<string, unknown>>("GET", "/export"),
    exportBooksCsv: () => call<string>("GET", "/export/books.csv", undefined, { raw: true }),
    importPreview: (data: unknown) => call<ImportReport>("POST", "/import", { mode: "preview", data }),
    importCommit: (data: unknown) => call<ImportReport>("POST", "/import", { mode: "commit", data }),
  },
};

export interface ImportReport {
  mode: string;
  books: { create: number; skipDuplicate: number; skipExistingId: number };
  reading_sessions: { create: number; skipExistingId: number; skipMissingBook: number };
  readings: { create: number; skipDuplicate: number; skipExistingId: number };
  feedback: { create: number; skipExistingId: number };
  preferences: string;
  problems: string[];
}
