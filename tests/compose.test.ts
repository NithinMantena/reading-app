import { describe, expect, it } from "vitest";
import { compose } from "@shared/pipeline/compose";
import type { Candidate, Selection } from "@shared/pipeline/types";

function cand(id: string, publisher: string, extra: Partial<Candidate> = {}): Candidate {
  return {
    id, url: `https://${publisher}/${id}`, originalUrl: `https://${publisher}/${id}`, title: `Title ${id}`, authors: [], publisher,
    source: "test", sourceEvidence: {}, precision: "day", dateEvidence: {}, accessClass: "free_full_text", accessEvidence: {},
    evidenceDepth: "full_text", itemType: "article", topics: [], status: "valid", ...extra,
  };
}
function sel(candidateId: string, rank: number, score: number, isSurprise = false, topics: string[] = ["economics"]): Selection {
  return { candidateId, rank, score, whyMatters: "m", whyFits: "f", topics, isSurprise };
}

describe("compose (PRD §7.1 step 7, §7.3, A7)", () => {
  it("fills five slots with exactly one surprise inside the five", () => {
    const cands = [cand("c1", "a.org"), cand("c2", "b.org"), cand("c3", "c.org"), cand("c4", "d.org"), cand("c5", "e.org"), cand("c6", "f.org")];
    const sels = [sel("c1", 1, 90), sel("c2", 2, 85), sel("c3", 3, 80), sel("c4", 4, 75), sel("c5", 5, 70, true, ["ornithology"]), sel("c6", 6, 65)];
    const out = compose(sels, cands, 5, { exclusions: [] });
    expect(out.slots).toHaveLength(5);
    expect(out.slots.filter((s) => s.isSurprise)).toHaveLength(1);
    expect(out.unfilled).toBe(0);
  });
  it("leaves the surprise slot unfilled rather than backfilling when no surprise qualifies", () => {
    const cands = ["c1", "c2", "c3", "c4", "c5", "c6"].map((id, i) => cand(id, `p${i}.org`));
    const sels = cands.map((c, i) => sel(c.id, i + 1, 90 - i));
    const out = compose(sels, cands, 5, { exclusions: [] });
    expect(out.slots).toHaveLength(4);
    expect(out.unfilled).toBe(1);
    expect(out.statusReason).toMatch(/Surprise slot left unfilled/);
  });
  it("prefers at most two per publisher, relaxing only when needed", () => {
    const cands = [cand("c1", "same.org"), cand("c2", "same.org"), cand("c3", "same.org"), cand("c4", "other.org"), cand("c5", "third.org", { topics: [] })];
    const sels = [sel("c1", 1, 95), sel("c2", 2, 94), sel("c3", 3, 93), sel("c4", 4, 70), sel("c5", 5, 68, true, ["art"])];
    const out = compose(sels, cands, 5, { exclusions: [] });
    const ids = out.slots.map((s) => s.candidateId);
    // c4 should be taken before c3 (third from same publisher) for diversity.
    expect(ids.indexOf("c4")).toBeLessThan(ids.indexOf("c3"));
  });
  it("hard topic exclusions beat the surprise slot", () => {
    const cands = [cand("c1", "a.org"), cand("c2", "b.org")];
    const sels = [sel("c1", 1, 90), sel("c2", 2, 88, true, ["crypto"])];
    const out = compose(sels, cands, 2, { exclusions: [{ kind: "topic", value: "crypto" }] });
    expect(out.slots.map((s) => s.candidateId)).toEqual(["c1"]);
  });
  it("monthly pair uses different publishers and only a strong surprise", () => {
    const cands = [cand("c1", "x.org"), cand("c2", "x.org"), cand("c3", "y.org"), cand("c4", "z.org")];
    const sels = [sel("c1", 1, 90), sel("c2", 2, 89), sel("c3", 3, 70), sel("c4", 4, 50, true, ["music"])];
    const out = compose(sels, cands, 2, { exclusions: [] });
    expect(out.slots.map((s) => s.candidateId)).toEqual(["c1", "c3"]);
  });
  it("never selects a candidate that is not valid, and explains a short batch", () => {
    const cands = [cand("c1", "a.org"), cand("c2", "b.org", { status: "rejected" })];
    const out = compose([sel("c1", 1, 80), sel("c2", 2, 99)], cands, 5, { exclusions: [] });
    expect(out.slots.map((s) => s.candidateId)).toEqual(["c1"]);
    expect(out.statusReason).toMatch(/passed date, access, and quality checks/);
  });
});
