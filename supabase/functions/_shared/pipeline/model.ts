// Provider-neutral model adapter with an Anthropic implementation (official SDK).
//
// Two roles: a capable ranker (Claude Opus 5) for final selection and deeper judgment,
// and a lower-cost classifier (Claude Haiku 4.5) for query generation and access checks.
import Anthropic from "@anthropic-ai/sdk";
import type { Candidate, CostLedger, RankingContext, RankingResult, Selection } from "./types.ts";
import type { Horizon } from "../periods.ts";
import { priceCall, recordCall } from "./budget.ts";

export const PROMPT_VERSION = "2026-09-06.1";

export interface ModelAdapter {
  name: string;
  generateQueries(input: QueryInput): Promise<{ core: string[]; exploration: string[] }>;
  classifyAccess(items: AccessInput[], ledger: CostLedger): Promise<AccessVerdict[]>;
  proposeLeads(input: LeadInput): Promise<{ title: string; url?: string; why: string }[]>;
  rank(input: RankInput, model?: string): Promise<RankingResult>;
}

export interface QueryInput {
  horizon: Horizon;
  windowLabel: string;
  context: RankingContext;
  ledger: CostLedger;
}

export interface AccessInput {
  id: string;
  url: string;
  title?: string;
  words: number;
  sample: string;
  markers: string[];
}
export interface AccessVerdict {
  id: string;
  complete: boolean;
  kind: "full_text" | "abstract" | "teaser" | "unclear";
  note: string;
}

export interface LeadInput {
  horizon: Horizon;
  windowLabel: string;
  windowStart: string;
  windowEnd: string;
  context: RankingContext;
  ledger: CostLedger;
  count: number;
}

export interface RankInput {
  horizon: Horizon;
  windowLabel: string;
  targetCount: number;
  context: RankingContext;
  candidates: Candidate[];
  ledger: CostLedger;
}

const HORIZON_GUIDANCE: Record<Horizon, string> = {
  daily: "Daily shelf: favour usefulness and information density over breaking news. Typical items take 5–15 minutes; the batch should total roughly an hour. Prefer pieces the reader would be glad to have read tomorrow, not merely today.",
  weekly: "Weekly shelf: favour explanation and synthesis over reporting. Typical items take 20–60 minutes; a shorter exceptional piece is fine.",
  monthly: "Monthly shelf: favour depth and sustained value: substantial essays, reports, or papers (often 45–180 minutes). Only two slots, so each must be clearly worth an evening.",
  yearly: "Yearly shelf: favour plausible enduring significance: enduring ideas, major discoveries, exceptional synthesis. Distinguish 'potentially important' from 'demonstrably influential' and say which you mean. No minimum length.",
  decade: "Decade shelf: favour foundational contributions with evidence of lasting influence, such as citations, adoption, or later work building on it. Later commentary may support the judgment, but the work itself must belong to the period.",
};

function textOf(msg: Anthropic.Message): string {
  return msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
}

function usageOf(msg: Anthropic.Message) {
  return {
    input: msg.usage.input_tokens,
    output: msg.usage.output_tokens,
    cacheRead: msg.usage.cache_read_input_tokens ?? 0,
    cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
  };
}

function parseJson<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return JSON.parse(start >= 0 ? trimmed.slice(start, end + 1) : trimmed) as T;
}

function contextBlock(ctx: RankingContext): string {
  const interests = ctx.interests.map((i) => `${i.topic}${i.weight !== 1 ? ` (weight ${i.weight})` : ""}`).join("; ") || "none stated";
  const exclusions = ctx.exclusions.map((e) => `${e.kind}: ${e.value}`).join("; ") || "none";
  const feedback = ctx.feedback.slice(0, 40).map((f) => {
    const who = f.title ? ` on "${f.title}"` : "";
    const pub = f.publisher ? ` [${f.publisher}]` : "";
    return `- ${f.action.replace(/_/g, " ")}${f.scope !== "item" ? ` (${f.scope})` : ""}${who}${pub}${f.text ? `: ${f.text}` : ""}`;
  }).join("\n") || "- none yet";
  const summary = ctx.preferenceSummary ? JSON.stringify(ctx.preferenceSummary).slice(0, 2000) : "none yet";
  return `Reader's stated interests: ${interests}
Hard exclusions (never select): ${exclusions}
Length preferences: ${JSON.stringify(ctx.lengthPreferences)}
Access exceptions: ${ctx.accessExceptions.join(", ") || "none"}
Recent explicit feedback (most recent first):
${feedback}
Derived preference summary: ${summary}
Books the reader has finished (for calibration, not exclusion): ${ctx.finishedBookTitles.slice(0, 60).join("; ") || "unknown"}`;
}

export class AnthropicAdapter implements ModelAdapter {
  name = "anthropic";
  private client: Anthropic;
  constructor(apiKey: string, private rankerModel: string, private classifierModel: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  private async call(purpose: string, model: string, params: Omit<Anthropic.MessageCreateParamsNonStreaming, "model">, ledger: CostLedger): Promise<Anthropic.Message> {
    const msg = await this.client.messages.create({ model, ...params });
    const usage = usageOf(msg);
    recordCall(ledger, { purpose, model, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, usd: priceCall(model, usage) });
    if (msg.stop_reason === "refusal") {
      throw new Error(`Model declined (${msg.stop_details?.category ?? "unspecified"}): ${msg.stop_details?.explanation ?? ""}`.trim());
    }
    if (msg.stop_reason === "max_tokens") throw new Error("Model output was truncated (max_tokens)");
    return msg;
  }

  async generateQueries(input: QueryInput): Promise<{ core: string[]; exploration: string[] }> {
    const msg = await this.call("queries", this.classifierModel, {
      max_tokens: 1500,
      system: "You write web and scholarly search queries for a personal reading recommender. Reply with JSON only.",
      messages: [{
        role: "user",
        content: `Shelf: ${input.horizon} (works published ${input.windowLabel}).
${contextBlock(input.context)}

Produce search queries that would surface high-quality readings from that period. Return JSON:
{"core": [8-12 short queries grounded in the stated interests and feedback],
 "exploration": [3-4 queries for adjacent or unfamiliar subjects with a credible link to the reader's interests, avoiding the hard exclusions]}
Queries should be specific enough to find substantive essays, reports, or papers, not generic news. Do not include dates in the queries; the date window is applied separately.`,
      }],
    }, input.ledger);
    const parsed = parseJson<{ core?: string[]; exploration?: string[] }>(textOf(msg));
    return {
      core: (parsed.core ?? []).filter((q) => typeof q === "string" && q.trim()).slice(0, 12),
      exploration: (parsed.exploration ?? []).filter((q) => typeof q === "string" && q.trim()).slice(0, 4),
    };
  }

  async classifyAccess(items: AccessInput[], ledger: CostLedger): Promise<AccessVerdict[]> {
    if (!items.length) return [];
    const msg = await this.call("access", this.classifierModel, {
      max_tokens: 2500,
      system: "You judge whether extracted web text is the complete reading, an abstract, or a paywall teaser. Reply with JSON only.",
      messages: [{
        role: "user",
        content: `For each item decide: is the extracted text the complete work (full_text), a substantive abstract/summary of a longer work (abstract), a truncated teaser behind a paywall or login (teaser), or unclear. Return JSON {"verdicts":[{"id":"...","complete":true|false,"kind":"full_text|abstract|teaser|unclear","note":"<=20 words"}]}.

${items.map((it) => `ID ${it.id} | ${it.url} | ~${it.words} words | markers: ${it.markers.join(", ") || "none"}
Title: ${it.title ?? "?"}
Text sample:
${it.sample}
---`).join("\n")}`,
      }],
    }, ledger);
    const parsed = parseJson<{ verdicts?: AccessVerdict[] }>(textOf(msg));
    return (parsed.verdicts ?? []).filter((v) => v && typeof v.id === "string");
  }

  async proposeLeads(input: LeadInput): Promise<{ title: string; url?: string; why: string }[]> {
    const msg = await this.call("leads", this.rankerModel, {
      max_tokens: 4000,
      output_config: { effort: "medium" },
      system: "You suggest candidate readings for later verification. Every suggestion will be independently checked for publication date and free access; unverifiable suggestions are simply dropped, so prefer works you are confident exist and are freely readable.",
      messages: [{
        role: "user",
        content: `Shelf: ${input.horizon}. Eligible works were originally published between ${input.windowStart.slice(0, 10)} and ${input.windowEnd.slice(0, 10)} (exclusive): ${input.windowLabel}.
${contextBlock(input.context)}

Suggest up to ${input.count} works from that period that a serious reader with these interests should know: enduring essays, landmark papers, foundational reports. Include about a quarter from adjacent or unfamiliar fields with a credible connection. Prefer items with a stable, free full-text URL (publisher page, arXiv, institutional repository, author site). Return JSON {"leads":[{"title":"...","url":"https://...","why":"<=25 words"}]}. Omit the url if unsure rather than inventing one.`,
      }],
    }, input.ledger);
    const parsed = parseJson<{ leads?: { title: string; url?: string; why: string }[] }>(textOf(msg));
    return (parsed.leads ?? []).filter((l) => l && typeof l.title === "string").slice(0, input.count);
  }

  async rank(input: RankInput, model = this.rankerModel): Promise<RankingResult> {
    const cands = input.candidates.filter((c) => c.status === "valid");
    const list = cands.map((c) => {
      const excerpt = (c.text ?? c.description ?? "").slice(0, 3500);
      return `### ${c.id}
Title: ${c.title ?? "(untitled)"}
Authors: ${c.authors.join(", ") || "unknown"} | Publisher: ${c.publisher ?? "unknown"} | Published: ${c.publishedOn ?? "?"} (${c.precision} precision)
Type: ${c.itemType} | Access: ${c.accessClass} | Evidence available to you: ${c.evidenceDepth} | Approx. reading time: ${c.durationMinutes ?? "?"} min${c.previouslySuggested ? " | previously suggested on another shelf" : ""}
Source evidence: ${JSON.stringify(c.sourceEvidence).slice(0, 300)}
Excerpt:
${excerpt}`;
    }).join("\n\n");

    const system = `You are the final judge for a personal reading recommender. You see only candidates that have already passed date and access checks. Your job is quality: relevance to this reader, depth, originality, source support, readability, and importance appropriate to the shelf's time horizon.

Rules that matter:
- Judge only from the evidence shown. If a candidate's evidence is an abstract or excerpt, say so in your rationale; never claim to have assessed a full text you have not seen.
- Reserve exactly one selection as "outside the reader's usual reading": an adjacent or unfamiliar subject with a credible reason it could interest this reader. Mark it isSurprise and explain the connection. If no candidate is good enough for that role, select none for it and explain in batchNote. Exploration never overrides hard exclusions.
- Prefer at most two selections from one publisher in a five-item batch; for a two-item batch prefer different publishers. Diversity yields to quality, never to eligibility.
- Rationale text is shown to the reader on cards. "whyMatters" is about the work; "whyFits" is about this reader and should reference their interests or feedback concretely.
- Rank more candidates than needed (up to ${Math.max(input.targetCount * 2, 6)}) so the composer can enforce diversity; give each a 0–100 quality score.
Reply with JSON only: {"selections":[{"candidateId":"c1","rank":1,"score":0-100,"whyMatters":"<=45 words","whyFits":"<=40 words","topics":["..","..","(<=3)"],"isSurprise":false,"surpriseConnection":"optional"}],"rejected":[{"candidateId":"cN","reason":"<=15 words"}],"batchNote":"optional <=60 words about gaps or caveats"}`;

    const user = `${HORIZON_GUIDANCE[input.horizon]}
Period: works published ${input.windowLabel}. Target batch size: ${input.targetCount}.

${contextBlock(input.context)}

Candidates (${cands.length}):

${list}`;

    const msg = await this.call("rank", model, {
      max_tokens: 12000,
      output_config: { effort: "high" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    }, input.ledger);
    const parsed = parseJson<{ selections?: Selection[]; rejected?: { candidateId: string; reason: string }[]; batchNote?: string }>(textOf(msg));
    const ids = new Set(cands.map((c) => c.id));
    const selections = (parsed.selections ?? [])
      .filter((s) => s && ids.has(s.candidateId))
      .map((s, i) => ({
        candidateId: s.candidateId,
        rank: Number(s.rank) || i + 1,
        score: Math.max(0, Math.min(100, Number(s.score) || 0)),
        whyMatters: String(s.whyMatters ?? "").slice(0, 400),
        whyFits: String(s.whyFits ?? "").slice(0, 400),
        topics: (Array.isArray(s.topics) ? s.topics : []).map(String).slice(0, 3),
        isSurprise: Boolean(s.isSurprise),
        surpriseConnection: s.surpriseConnection ? String(s.surpriseConnection).slice(0, 300) : undefined,
      }))
      .sort((a, b) => a.rank - b.rank);
    const usage = usageOf(msg);
    return {
      model,
      promptVersion: PROMPT_VERSION,
      selections,
      rejected: (parsed.rejected ?? []).filter((r) => r && ids.has(r.candidateId)),
      batchNote: parsed.batchNote,
      usage,
      costUsd: priceCall(model, usage),
    };
  }
}

export function makeAdapter(cfg: { anthropicKey?: string; rankerModel: string; classifierModel: string }): ModelAdapter | null {
  if (cfg.anthropicKey) return new AnthropicAdapter(cfg.anthropicKey, cfg.rankerModel, cfg.classifierModel);
  return null;
}
