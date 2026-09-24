// TypeSafe Jev client and the access check built on it.
//
// Jev answers typed questions (noul = yes/no probability, choice = one of named options)
// about a supplied state; it never writes text. Here it answers one narrow question set per
// borderline article: is the extracted text the whole free work, an abstract, a teaser, or
// not an article at all? Code turns the probabilities into a decision; anything Jev is not
// sure about goes to the main text model instead of being guessed. Design follows the
// stock-monitoring research (research/REPORT1.md, REPORT2.md): one request per article with
// all questions on shared state, decisions from full distributions rather than the `choice`
// label, and a conservative rejection threshold so a good article is not silently dropped.
import type { Candidate, CostLedger } from "./types.ts";
import { priceCall, recordCall } from "./budget.ts";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const RETRYABLE = new Set([429, 500, 502, 503, 504, 520, 529]);

export interface NoulAnswer { type: "noul"; noul: number }
export interface ChoiceAnswer { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
export type JevAnswer = NoulAnswer | ChoiceAnswer;
export interface JevResponse { model: string; answers: Record<string, JevAnswer>; usage?: { input_tokens?: number; output_tokens?: number } }

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export class JevClient {
  constructor(private apiKey: string, public model = "jev-latest", private fetchImpl: typeof fetch = fetch) {}

  async ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResponse> {
    const body = JSON.stringify({ state, model: this.model, questions });
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(JEV_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return (await res.json()) as JevResponse;
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      if (!RETRYABLE.has(res.status) || attempt >= 2) throw new Error(`Jev ${res.status}: ${detail}`);
      await new Promise((r) => setTimeout(r, 1_000 * 3 ** attempt));
    }
  }
}

// ---------------------------------------------------------------------------------------
// Access check
// ---------------------------------------------------------------------------------------

/** At most this many borderline articles go to Jev per run. */
export const MAX_JEV_ITEMS = 25;

export const ACCESS_QUESTIONS: Record<string, JevQuestion> = {
  access: {
    type: "choice",
    instructions: "What does the extracted text in `article` represent? Judge from `article.opening`, `article.ending`, `article.word_count` and `article.paywall_markers`.",
    criteria: {
      full_text: "The complete work itself, freely readable: the text runs on substantively and ends naturally, with no sign that the rest is withheld.",
      abstract: "An abstract, summary or landing page describing a longer work (such as a paper's abstract page), not the work itself.",
      teaser: "The opening of a work that is cut off or gated: a subscribe, sign-in, register or pay prompt, or a 'continue reading' break before the substance.",
      listing: "Not a single work: a homepage, index, search results, table of contents, newsletter sign-up, error or cookie page.",
      unclear: "The text does not establish which of these it is.",
    },
  },
  gated: {
    type: "noul",
    instructions: "Does `article` show that the rest of the work requires a subscription, login, registration or payment to read?",
    criteria: {
      true: "Visible paywall, subscriber-only, sign-in-to-continue or metered-access wording, or text that stops abruptly behind such a prompt.",
      false: "No sign of gating; any subscribe links are ordinary site navigation or newsletter offers alongside a complete text.",
    },
  },
  // Recorded only, never used to accept or reject. Collected so a later Jev pre-screen can be
  // compared against what the ranker actually picks before it is trusted to filter anything.
  substantive: {
    type: "noul",
    instructions: "Is `article` substantive reading, such as an essay, long-form report, analysis or paper, rather than a short news brief, press release, product page or promotion?",
  },
};

export interface AccessProbabilities { full: number; abstract: number; blocked: number; gated: number; substantive: number | null }
export type AccessDecision =
  | { decision: "full_text"; p: AccessProbabilities }
  | { decision: "abstract"; p: AccessProbabilities }
  | { decision: "reject"; reason: string; p: AccessProbabilities }
  | { decision: "uncertain"; p: AccessProbabilities };

function prob(a: JevAnswer | undefined, option?: string): number {
  if (!a) return 0;
  if (a.type === "noul") return Number(a.noul) || 0;
  return Number(a.probabilities?.[option ?? ""]) || 0;
}

/**
 * Turn Jev's answers into a decision. Thresholds are deliberately strict on both sides:
 * accept only clear full texts, reject only clear teasers, and send the middle to the text
 * model. Uses the probability distribution, not the `choice` label, which can disagree with
 * the rounded maximum by 0.01.
 */
export function routeAccess(answers: Record<string, JevAnswer>, hasOpenCopySource: boolean): AccessDecision {
  const access = answers.access;
  const p: AccessProbabilities = {
    full: prob(access, "full_text"),
    abstract: prob(access, "abstract"),
    blocked: prob(access, "teaser") + prob(access, "listing"),
    gated: prob(answers.gated),
    substantive: answers.substantive ? prob(answers.substantive) : null,
  };
  if (!access || access.type !== "choice" || !answers.gated) return { decision: "uncertain", p };
  if (p.blocked >= 0.8) return { decision: "reject", reason: prob(access, "listing") > prob(access, "teaser") ? "not an article page" : "teaser or paywalled", p };
  if (p.gated >= 0.85 && p.full < 0.5) return { decision: "reject", reason: "gated", p };
  if (p.full >= 0.75 && p.gated < 0.5) return { decision: "full_text", p };
  if (p.abstract >= 0.75 && p.gated < 0.5) {
    // An abstract only counts when a scholarly source vouches for an open copy.
    return hasOpenCopySource ? { decision: "abstract", p } : { decision: "reject", reason: "abstract without an open copy", p };
  }
  return { decision: "uncertain", p };
}

export function accessState(c: Candidate): Record<string, unknown> {
  const text = c.text ?? "";
  let host = "";
  try { host = new URL(c.url).hostname; } catch { /* keep empty */ }
  return {
    article: {
      url: c.url,
      host,
      title: c.title ?? null,
      publisher: c.publisher ?? null,
      word_count: c.words ?? 0,
      paywall_markers: (c.accessEvidence.markers as string[] | undefined) ?? [],
      opening: text.slice(0, 3000),
      // The end of the extraction is where a paywall cut shows up.
      ending: text.length > 3600 ? text.slice(-600) : null,
    },
  };
}

export interface ScreenResult { id: string; result: AccessDecision | null; error?: string }

/** Ask Jev about each item (bounded concurrency). A failed item comes back with result null. */
export async function screenAccess(jev: JevClient, items: Candidate[], ledger: CostLedger, concurrency = 4): Promise<ScreenResult[]> {
  const out: ScreenResult[] = new Array(items.length);
  let inputTokens = 0;
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const c = items[i];
      try {
        const res = await jev.ask(accessState(c), ACCESS_QUESTIONS);
        inputTokens += res.usage?.input_tokens ?? 0;
        out[i] = { id: c.id, result: routeAccess(res.answers ?? {}, Boolean(c.sourceEvidence.openalex || c.sourceEvidence.arxiv)) };
      } catch (e) {
        out[i] = { id: c.id, result: null, error: e instanceof Error ? e.message : String(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (inputTokens) {
    const usage = { input: inputTokens, output: 0, cacheRead: 0, cacheWrite: 0 };
    recordCall(ledger, { purpose: "access-jev", model: jev.model, input: inputTokens, output: 0, cacheRead: 0, usd: priceCall(jev.model, usage) });
  }
  return out;
}
