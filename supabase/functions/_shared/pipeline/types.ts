import type { Horizon, PeriodWindow } from "../periods.ts";

export type Stage = "queued" | "context" | "retrieve" | "validate" | "assess" | "rank" | "compose" | "publish" | "done";
export const STAGE_ORDER: Stage[] = ["queued", "context", "retrieve", "validate", "assess", "rank", "compose", "publish", "done"];

export type AccessClass = "free_full_text" | "open_copy" | "nyt_subscription" | "preview_only" | "paywall" | "unknown";
export type Precision = "day" | "month" | "year" | "unknown";
export type EvidenceDepth = "full_text" | "excerpt" | "abstract" | "none";

export interface Candidate {
  /** Short stable id used in model prompts (c1, c2, ...) */
  id: string;
  url: string;
  originalUrl: string;
  title?: string;
  authors: string[];
  publisher?: string;
  source: string;
  sourceEvidence: Record<string, unknown>;
  publishedOn?: string;
  precision: Precision;
  dateEvidence: Record<string, unknown>;
  accessClass: AccessClass;
  accessEvidence: Record<string, unknown>;
  description?: string;
  text?: string;
  words?: number;
  durationMinutes?: number;
  evidenceDepth: EvidenceDepth;
  itemType: string;
  topics: string[];
  status: "new" | "fetched" | "valid" | "rejected";
  rejectReason?: string;
  previouslySuggested?: boolean;
  /** true when the candidate was suggested by the model as a lead and must be verified */
  lead?: boolean;
}

export interface FeedbackSummary {
  action: string;
  scope: string;
  text: string | null;
  topics: string[];
  publisher: string | null;
  title?: string;
  created_at: string;
}

export interface RankingContext {
  timeZone: string;
  interests: { topic: string; weight: number }[];
  exclusions: { kind: string; value: string }[];
  lengthPreferences: Record<string, number>;
  accessExceptions: string[];
  sources: { url: string; label?: string }[];
  feedback: FeedbackSummary[];
  preferenceSummary: unknown | null;
  preferenceVersion: number | null;
  /** canonical URLs already surfaced on this horizon (hard exclude) */
  surfacedSameHorizon: string[];
  /** canonical URLs surfaced on other horizons (allowed, flagged) */
  surfacedOtherHorizons: string[];
  /** canonical URLs the user saved/read/archived (suppress) */
  knownUrls: string[];
  /** titles of finished books, for "already read" awareness */
  finishedBookTitles: string[];
  /** entries to keep when filling missing slots */
  keepEntries?: { reading_id: string; slot: number; is_surprise: boolean; why_matters: string | null; why_fits: string | null; evidence_depth: string; ranking_evidence: unknown; previously_suggested: boolean }[];
  keepUrls?: string[];
}

export interface Selection {
  candidateId: string;
  rank: number;
  score: number;
  whyMatters: string;
  whyFits: string;
  topics: string[];
  isSurprise: boolean;
  surpriseConnection?: string;
}

export interface RankingResult {
  model: string;
  promptVersion: string;
  selections: Selection[];
  rejected: { candidateId: string; reason: string }[];
  batchNote?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
}

export interface ComposedSlot {
  slot: number;
  candidateId: string;
  isSurprise: boolean;
  selection: Selection;
  previouslySuggested: boolean;
}

export interface Composed {
  slots: ComposedSlot[];
  targetCount: number;
  statusReason?: string;
  unfilled: number;
}

export interface ModelCall {
  purpose: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  usd: number;
  at: string;
}

export interface CostLedger {
  estimatedUsd: number;
  actualUsd: number;
  calls: ModelCall[];
  fetches: number;
  searches: number;
}

export interface Checkpoint {
  window: { start: string; end: string; label: string; timeZone: string; periodKey: string };
  context?: RankingContext;
  queries?: { core: string[]; exploration: string[] };
  candidates?: Candidate[];
  cursor?: number;
  ranking?: RankingResult;
  comparison?: RankingResult[];
  composed?: Composed;
  batchId?: string;
  log: string[];
  cost: CostLedger;
}

export interface JobRow {
  id: string;
  owner_id: string;
  kind: string;
  horizon: Horizon;
  period_key: string;
  batch_id: string | null;
  status: string;
  stage: Stage;
  checkpoint: Checkpoint;
  attempts: number;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  preference_version: number | null;
  counts: Record<string, number>;
  cost: Record<string, unknown>;
  error: string | null;
  created_at: string;
}

export interface RunConfig {
  rankerModel: string;
  classifierModel: string;
  anthropicKey?: string;
  exaKey?: string;
  braveKey?: string;
  openAlexMailto?: string;
  maxCandidates: number;
  maxFetches: number;
  fetchConcurrency: number;
  /** wall-clock budget per invocation, ms */
  timeBudgetMs: number;
}

export function emptyLedger(): CostLedger {
  return { estimatedUsd: 0, actualUsd: 0, calls: [], fetches: 0, searches: 0 };
}

export function windowToCheckpoint(w: PeriodWindow): Checkpoint["window"] {
  return { start: w.startUtc.toISOString(), end: w.endUtc.toISOString(), label: w.label, timeZone: w.timeZone, periodKey: w.periodKey };
}
