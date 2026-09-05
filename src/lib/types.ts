export type LibraryStatus = "want_to_read" | "reading" | "finished" | "stopped" | "unknown";
export type SessionStatus = "reading" | "finished" | "stopped" | "unknown";
export type QueueStatus = "candidate" | "saved" | "reading" | "finished" | "archived";
export type AccessClass = "free_full_text" | "open_copy" | "nyt_subscription" | "preview_only" | "paywall" | "unknown";
export type DatePrecision = "day" | "month" | "year" | "unknown";
export type Horizon = "daily" | "weekly" | "monthly" | "yearly" | "decade";

export interface ReadingSession {
  id: string;
  book_id: string;
  started_on: string | null;
  finished_on: string | null;
  status: SessionStatus;
  rating: number | null;
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Book {
  id: string;
  title: string;
  authors: string[];
  author_unknown: boolean;
  isbn: string | null;
  edition: string | null;
  topics: string[];
  cover_url: string | null;
  description: string | null;
  recommended_by: string | null;
  why_read: string | null;
  notes: string | null;
  library_status: LibraryStatus;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  app_link?: string;
  sessions?: ReadingSession[];
  // From the books_with_latest_session view
  session_id?: string | null;
  started_on?: string | null;
  finished_on?: string | null;
  session_status?: SessionStatus | null;
  rating?: number | null;
  session_notes?: string | null;
  session_version?: number | null;
}

export interface Reading {
  id: string;
  canonical_url: string | null;
  original_url: string | null;
  title: string;
  authors: string[];
  publisher: string | null;
  published_on: string | null;
  published_precision: DatePrecision;
  published_evidence: Record<string, unknown>;
  item_type: string;
  access_class: AccessClass;
  access_evidence: Record<string, unknown>;
  access_checked_at: string | null;
  duration_minutes: number | null;
  topics: string[];
  notes: string | null;
  description: string | null;
  queue_status: QueueStatus;
  enrichment_status: string;
  recommendation_entry_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  app_link?: string;
  existing?: boolean;
}

export interface Settings {
  time_zone: string;
  language: string;
  access_exceptions: string[];
  interests: { topic: string; weight: number }[];
  exclusions: { kind: "topic" | "author" | "publisher"; value: string }[];
  length_preferences: Record<string, number>;
  budget: { monthly_cap_usd: number; currency?: string };
  sources: { url: string; label?: string }[];
  onboarding_complete: boolean;
  version: number;
}

export interface GenerationConfig {
  provider: string | null;
  models: { ranker: string; classifier: string; comparison: string };
  prices: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number } | null | string>;
  search: string;
  freeSources: string[];
  estimatePerRunUsd: Record<string, number>;
  monthlySpendUsd: number;
  monthlyCapUsd: number;
  scheduler: { workerRegistered?: boolean; jobs?: { name: string; schedule: string; active: boolean; lastRun: { status: string; started: string; message: string } | null }[]; error?: string };
  sources: { url: string; label?: string }[];
}

export interface RecommendationEntry {
  id: string;
  slot: number;
  is_surprise: boolean;
  why_matters: string | null;
  why_fits: string | null;
  evidence_depth: string;
  previously_suggested: boolean;
  state: "active" | "dismissed" | "saved" | "read";
  reading: Reading;
}

export interface Batch {
  id: string;
  horizon: Horizon;
  period_key: string;
  window_start: string;
  window_end: string;
  window_label: string;
  time_zone: string;
  version: number;
  status: "pending" | "generating" | "published" | "partial" | "failed";
  status_reason: string | null;
  target_count: number;
  created_at: string;
  published_at: string | null;
}

export interface Shelf {
  horizon: Horizon;
  isCurrent: boolean;
  window: { periodKey: string; label: string; start: string; end: string; timeZone: string };
  targetCount: number;
  batch: Batch | null;
  entries: RecommendationEntry[];
  activeJob: { id: string; status: string; stage: string; updated_at: string } | null;
  lastJob: { id: string; status: string; stage: string; error: string | null; attempts: number; updated_at: string; created_at: string; kind: string } | null;
}

export interface Job {
  id: string;
  kind: string;
  horizon: Horizon;
  period_key: string;
  status: string;
  stage: string;
  attempts: number;
  error: string | null;
  cost: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface FeedbackEvent {
  id: string;
  reading_id: string | null;
  book_id: string | null;
  action: string;
  scope: string;
  text: string | null;
  quality_rating: number | null;
  topics: string[];
  publisher: string | null;
  source: string;
  created_at: string;
}

export interface IntegrationToken {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  token?: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
