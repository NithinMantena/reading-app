// Text-model transport for the discovery pipeline. Prompts live in model.ts; this file only
// knows how to send one system + user prompt to a provider and account for the tokens.
//
// Anthropic goes through the official SDK. Gemini goes through its REST endpoint (no SDK
// dependency in the edge functions).
import Anthropic from "@anthropic-ai/sdk";
import type { CostLedger } from "./types.ts";
import { priceCall, recordCall, type Usage } from "./budget.ts";

export type Provider = "anthropic" | "google";
export type Effort = "low" | "medium" | "high";

export interface TextRequest {
  purpose: string;
  system: string;
  user: string;
  /** Tokens for the visible answer. Gemini's thinking allowance is added on top. */
  maxTokens: number;
  effort?: Effort;
  /** Mark the system prompt cacheable (Anthropic only; Gemini caches implicitly). */
  cacheSystem?: boolean;
}

export interface TextResult {
  text: string;
  usage: Usage;
  usd: number;
}

export interface TextModel {
  provider: Provider;
  model: string;
  complete(req: TextRequest, ledger: CostLedger): Promise<TextResult>;
}

/** Effort is accepted by Opus, Sonnet and Fable-class models; Haiku 4.5 rejects it. */
export function anthropicSupportsEffort(model: string): boolean {
  return /opus|sonnet|fable|mythos/i.test(model);
}

export class AnthropicText implements TextModel {
  provider = "anthropic" as const;
  private client: Anthropic;
  constructor(apiKey: string, public model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async complete(req: TextRequest, ledger: CostLedger): Promise<TextResult> {
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens,
      ...(req.effort && anthropicSupportsEffort(this.model) ? { output_config: { effort: req.effort } } : {}),
      system: req.cacheSystem ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }] : req.system,
      messages: [{ role: "user", content: req.user }],
    });
    const usage: Usage = {
      input: msg.usage.input_tokens,
      output: msg.usage.output_tokens,
      cacheRead: msg.usage.cache_read_input_tokens ?? 0,
      cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
    };
    const usd = priceCall(this.model, usage);
    recordCall(ledger, { purpose: req.purpose, model: this.model, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, usd });
    if (msg.stop_reason === "refusal") {
      throw new Error(`Model declined (${msg.stop_details?.category ?? "unspecified"}): ${msg.stop_details?.explanation ?? ""}`.trim());
    }
    if (msg.stop_reason === "max_tokens") throw new Error("Model output was truncated (max_tokens)");
    const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    return { text, usage, usd };
  }
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
/** Room for thinking tokens, which Gemini counts against maxOutputTokens. */
const THINKING_ALLOWANCE: Record<Effort, number> = { low: 4_000, medium: 12_000, high: 32_000 };
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string; status?: string };
}

export class GeminiText implements TextModel {
  provider = "google" as const;
  constructor(private apiKey: string, public model: string, private fetchImpl: typeof fetch = fetch) {}

  async complete(req: TextRequest, ledger: CostLedger): Promise<TextResult> {
    const effort = req.effort ?? "low";
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: Math.min(65_536, req.maxTokens + THINKING_ALLOWANCE[effort]),
      responseMimeType: "application/json",
    };
    // Gemini 3.x takes a thinking level; 2.x used token budgets, so leave its default alone.
    if (!/^gemini-2\./.test(this.model)) generationConfig.thinkingConfig = { thinkingLevel: effort };
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig,
    });

    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await this.fetchImpl(`${GEMINI_BASE}/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body,
        signal: AbortSignal.timeout(150_000),
      });
      if (!RETRYABLE.has(res.status) || attempt === 2) break;
      const wait = Number(res.headers.get("retry-after")) * 1000 || 2_000 * 3 ** attempt;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, Math.min(wait, 20_000)));
    }
    const json = (await res!.json().catch(() => ({}))) as GeminiResponse;
    if (!res!.ok) {
      // Status code stays in the message so the runner's transient-error retry recognises 429/5xx.
      const hint = res!.status === 429 ? " rate limit" : "";
      throw new Error(`Gemini ${res!.status}${hint}: ${json.error?.message ?? res!.statusText}`.slice(0, 400));
    }

    const meta = json.usageMetadata ?? {};
    const cached = meta.cachedContentTokenCount ?? 0;
    const usage: Usage = {
      input: Math.max(0, (meta.promptTokenCount ?? 0) - cached),
      // Thinking tokens are billed as output.
      output: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
      cacheRead: cached,
      cacheWrite: 0,
    };
    const usd = priceCall(this.model, usage);
    recordCall(ledger, { purpose: req.purpose, model: this.model, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, usd });

    if (json.promptFeedback?.blockReason) throw new Error(`Model declined (${json.promptFeedback.blockReason})`);
    const cand = json.candidates?.[0];
    const finish = cand?.finishReason ?? "STOP";
    if (finish === "MAX_TOKENS") throw new Error("Model output was truncated (max_tokens)");
    if (finish !== "STOP") throw new Error(`Model declined (${finish})`);
    const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
    return { text, usage, usd };
  }
}

export function makeTextModel(provider: Provider, model: string, apiKey: string): TextModel {
  return provider === "google" ? new GeminiText(apiKey, model) : new AnthropicText(apiKey, model);
}
