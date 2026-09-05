// Stage 6: turn a ranking into a batch that respects diversity, the surprise slot, and
// hard exclusions. Pure function; unit-tested.
import type { Candidate, Composed, RankingContext, Selection } from "./types.ts";

export const SURPRISE_MIN_SCORE = 60;
export const MIN_SCORE = 45;

export function compose(
  selections: Selection[],
  candidates: Candidate[],
  targetCount: number,
  ctx: Pick<RankingContext, "exclusions">,
  opts: { allowSurprise?: boolean } = {},
): Composed {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const excludedTopics = ctx.exclusions.filter((e) => e.kind === "topic").map((e) => e.value.toLowerCase());
  const reasons: string[] = [];
  const eligible = selections
    .filter((s) => byId.get(s.candidateId)?.status === "valid")
    .filter((s) => {
      const bad = s.topics.some((t) => excludedTopics.some((x) => t.toLowerCase().includes(x)));
      if (bad) reasons.push(`dropped ${s.candidateId}: excluded topic`);
      return !bad;
    })
    .filter((s) => s.score >= MIN_SCORE)
    .sort((a, b) => a.rank - b.rank || b.score - a.score);

  const maxPerPublisher = targetCount >= 5 ? 2 : 1;
  const allowSurprise = opts.allowSurprise ?? true;
  const surpriseSlots = targetCount >= 5 ? 1 : 0; // monthly pair: at most one, only if strong
  const chosen: Selection[] = [];
  const publisherCount = new Map<string, number>();
  const pubOf = (s: Selection) => (byId.get(s.candidateId)?.publisher ?? byId.get(s.candidateId)?.url ?? "").toLowerCase();

  const take = (s: Selection, soft: boolean): boolean => {
    const p = pubOf(s);
    if (soft && (publisherCount.get(p) ?? 0) >= maxPerPublisher) return false;
    chosen.push(s);
    publisherCount.set(p, (publisherCount.get(p) ?? 0) + 1);
    return true;
  };

  // 1. Core picks (non-surprise), honouring publisher diversity first, relaxing it after.
  const core = eligible.filter((s) => !s.isSurprise);
  const surprises = eligible.filter((s) => s.isSurprise && s.score >= SURPRISE_MIN_SCORE);
  // Five-item shelves always reserve the surprise slot, even if it ends up empty. The monthly
  // pair only gives up a core slot when a strong surprise actually exists.
  const reserve = surpriseSlots > 0 ? surpriseSlots : surprises.length ? 1 : 0;
  const coreTarget = targetCount - (allowSurprise ? reserve : 0);
  for (const s of core) { if (chosen.length >= coreTarget) break; take(s, true); }
  if (chosen.length < coreTarget) for (const s of core) { if (chosen.length >= coreTarget) break; if (!chosen.includes(s)) take(s, false); }

  // 2. Surprise slot: exactly one for five-item batches; optional strong one for the pair.
  let surpriseUsed = false;
  if (allowSurprise && chosen.length < targetCount && surprises.length) {
    for (const s of surprises) { if (take(s, true) || take(s, false)) { surpriseUsed = true; break; } }
  }
  // 3. If the surprise slot stays empty, do not backfill it with a core item on 5-item shelves:
  //    the slot is reserved. For the monthly pair, fill with the next core item instead.
  if (!surpriseUsed && targetCount === 2) {
    for (const s of core) { if (chosen.length >= targetCount) break; if (!chosen.includes(s)) take(s, false); }
  }
  const unfilled = targetCount - chosen.length;
  if (unfilled > 0) {
    if (!surpriseUsed && targetCount >= 5 && unfilled === 1) reasons.push("Surprise slot left unfilled: no candidate outside the usual reading met the quality bar.");
    else reasons.push(`${unfilled} slot${unfilled === 1 ? "" : "s"} unfilled: only ${eligible.length} candidate${eligible.length === 1 ? "" : "s"} passed date, access, and quality checks.`);
  }
  const slots = chosen.map((s, i) => ({
    slot: i + 1, candidateId: s.candidateId, isSurprise: s.isSurprise, selection: s,
    previouslySuggested: Boolean(byId.get(s.candidateId)?.previouslySuggested),
  }));
  return { slots, targetCount, unfilled, statusReason: reasons.length ? reasons.join(" ") : undefined };
}
