// Stage 3/4: verify each candidate's identity, publication date, and access, and gather
// the content evidence the ranker is allowed to see. Resumable via checkpoint.cursor.
import { parseLocalDate, publicationFits, windowFor, type Horizon, type PeriodWindow } from "../periods.ts";
import { isNytUrl } from "../urls.ts";
import { extractMainText, fetchDocument, parseDateEvidence, parseMetadata, paywallMarkers, wordCount } from "../extract.ts";
import type { Candidate, Checkpoint, RunConfig } from "./types.ts";
import type { AccessInput, ModelAdapter } from "./model.ts";
import { crossrefDate } from "./sources.ts";

const PAYWALL_HOSTS = ["wsj.com", "ft.com", "bloomberg.com", "economist.com", "barrons.com", "thetimes.co.uk", "telegraph.co.uk", "washingtonpost.com", "theinformation.com", "stratechery.com", "hbr.org", "nature.com", "science.org", "cell.com", "sciencedirect.com", "springer.com", "wiley.com", "jstor.org", "tandfonline.com", "sagepub.com", "ieee.org", "acm.org"];

function hostIn(url: string, list: string[]): boolean {
  const h = new URL(url).hostname.replace(/^www\./, "");
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}

function windowOf(cp: Checkpoint, horizon: Horizon): PeriodWindow {
  // Rebuild the window object from the checkpoint (deterministic).
  const w = windowFor(horizon, new Date(cp.window.start), cp.window.timeZone);
  // The checkpoint's window is authoritative if the job was queued for a specific past period.
  if (w.startUtc.toISOString() !== cp.window.start) {
    return { ...w, startUtc: new Date(cp.window.start), endUtc: new Date(cp.window.end), startDate: parseLocalDate(cp.window.start.slice(0, 10)), endDate: parseLocalDate(cp.window.end.slice(0, 10)), periodKey: cp.window.periodKey, label: cp.window.label };
  }
  return w;
}

/** Choose the best-supported publication date. Sources disagreeing beyond their precision => ambiguous. */
function resolveDate(c: Candidate, pageRaw: string | undefined, crossref: { date?: string; precision: string } | null): { date?: string; precision: Candidate["precision"]; evidence: Record<string, unknown>; ambiguous?: string } {
  const evidence: Record<string, unknown> = { ...c.dateEvidence };
  const votes: { src: string; date: string; precision: "day" | "month" | "year" }[] = [];
  const push = (src: string, raw: string | undefined) => {
    if (!raw) return;
    const p = parseDateEvidence(raw);
    if (p.date && p.precision !== "unknown") votes.push({ src, date: p.date, precision: p.precision });
  };
  const arx = (c.sourceEvidence.arxiv as { arxivPublished?: string } | undefined)?.arxivPublished;
  const oa = (c.sourceEvidence.openalex as { publicationDate?: string } | undefined)?.publicationDate;
  push("arxiv", arx);
  push("openalex", oa);
  if (crossref?.date) { votes.push({ src: "crossref", date: crossref.date, precision: crossref.precision as "day" | "month" | "year" }); evidence.crossref = crossref; }
  push("page", pageRaw);
  if (pageRaw) evidence.page = pageRaw;
  const exa = (c.sourceEvidence.exa as { exaPublishedDate?: string } | undefined)?.exaPublishedDate;
  if (!votes.length) push("exa", exa); // search-engine dates only as a last resort, flagged
  const rss = (c.sourceEvidence.rss as { feedDate?: string } | undefined)?.feedDate;
  if (!votes.length) push("rss", rss);
  if (!votes.length) return { precision: "unknown", evidence };

  // Publisher-grade sources first.
  const order = ["crossref", "arxiv", "openalex", "page", "rss", "exa"];
  votes.sort((a, b) => order.indexOf(a.src) - order.indexOf(b.src));
  const best = votes[0];
  // Disagreement check: any two day-precise votes more than 3 days apart is ambiguous.
  const dayVotes = votes.filter((v) => v.precision === "day");
  for (const v of dayVotes) {
    const diff = Math.abs(new Date(v.date).getTime() - new Date(best.date).getTime()) / 86400000;
    if (diff > 3) return { date: best.date, precision: best.precision, evidence: { ...evidence, votes }, ambiguous: `${best.src} says ${best.date}, ${v.src} says ${v.date}` };
  }
  evidence.chosen = best;
  evidence.votes = votes;
  if (best.src === "exa" || best.src === "rss") evidence.note = "Only a search/feed date was available; treated as publisher-supplied date with unknown time zone";
  return { date: best.date, precision: best.precision, evidence };
}

export async function validateBatch(cp: Checkpoint, horizon: Horizon, cfg: RunConfig, deadline: number, log: (s: string) => void): Promise<boolean> {
  const cands = cp.candidates ?? [];
  const ctx = cp.context!;
  const w = windowOf(cp, horizon);
  const nytOk = ctx.accessExceptions.includes("nyt_subscription");
  let i = cp.cursor ?? 0;
  const excludedPublishers = ctx.exclusions.filter((e) => e.kind === "publisher").map((e) => e.value.toLowerCase());
  const excludedAuthors = ctx.exclusions.filter((e) => e.kind === "author").map((e) => e.value.toLowerCase());

  const one = async (c: Candidate) => {
    if (cp.cost.fetches >= cfg.maxFetches) { c.status = "rejected"; c.rejectReason = "fetch budget exhausted"; return; }
    cp.cost.fetches++;
    try {
      const doc = await fetchDocument(c.url);
      if (doc.status >= 400) { c.status = "rejected"; c.rejectReason = `HTTP ${doc.status}`; return; }
      const nyt = isNytUrl(doc.url);
      if (!/html|xml/i.test(doc.contentType)) {
        // PDFs and other binaries: keep only when a scholarly source vouches for it and gave an abstract.
        if (c.sourceEvidence.openalex || c.sourceEvidence.arxiv) {
          c.evidenceDepth = c.description ? "abstract" : "none";
          c.accessEvidence = { note: `Non-HTML full text (${doc.contentType}) reachable; assessed from source abstract`, httpStatus: doc.status };
          c.accessClass = "open_copy";
        } else { c.status = "rejected"; c.rejectReason = `non-HTML content (${doc.contentType}) without bibliographic source`; return; }
      } else {
        const m = parseMetadata(doc.html, doc.url);
        const text = extractMainText(doc.html);
        const words = wordCount(text);
        c.title = m.title ?? c.title;
        if (!c.authors.length && m.authors.length) c.authors = m.authors;
        c.publisher ??= m.publisher;
        c.description ??= m.description;
        if (m.isPaper) c.itemType = "paper";
        c.text = text.slice(0, 6000);
        c.words = words;
        c.durationMinutes = words > 100 ? Math.max(1, Math.round(words / 230)) : undefined;
        const markers = paywallMarkers(text.slice(0, 5000));
        // Access classification (article-level; a 200 response proves nothing on its own).
        if (nyt) {
          if (!nytOk) { c.status = "rejected"; c.rejectReason = "NYT without subscription exception"; return; }
          c.accessClass = "nyt_subscription";
          c.accessEvidence = { note: "NYT subscription exception; opens on nytimes.com with the reader's login", httpStatus: doc.status, approxWords: words };
          c.evidenceDepth = words > 400 ? "excerpt" : m.description ? "abstract" : "none";
        } else if (m.accessibleForFree === false) {
          c.status = "rejected"; c.rejectReason = "publisher declares isAccessibleForFree=false"; return;
        } else if (c.sourceEvidence.openAccessClaimed && (c.sourceEvidence.arxiv || c.sourceEvidence.openalex)) {
          c.accessClass = "open_copy";
          c.accessEvidence = { note: "Open-access copy per bibliographic source", source: c.sourceEvidence.arxiv ? "arxiv" : "openalex", httpStatus: doc.status, approxWords: words };
          c.evidenceDepth = words > 1500 ? "full_text" : m.description || words > 150 ? "abstract" : "none";
        } else if (markers.length && words < 1200) {
          c.status = "rejected"; c.rejectReason = `paywall/teaser markers (${markers.length}) with short text`; return;
        } else if (hostIn(doc.url, PAYWALL_HOSTS) && words < 1500) {
          c.status = "rejected"; c.rejectReason = "known paywalled publisher and short extracted text"; return;
        } else if (words >= 600 && !markers.length) {
          c.accessClass = "free_full_text";
          c.accessEvidence = { note: "Full text extracted without payment or login", httpStatus: doc.status, approxWords: words, accessibleForFree: m.accessibleForFree ?? null };
          c.evidenceDepth = "full_text";
        } else {
          // Borderline: leave for the assess stage's classifier.
          c.accessClass = "unknown";
          c.accessEvidence = { note: "Borderline length or markers; needs classification", httpStatus: doc.status, approxWords: words, markers };
          c.evidenceDepth = words > 150 ? "excerpt" : "none";
        }
        // Date resolution.
        const cr = m.doi ? await crossrefDate(m.doi, cfg.openAlexMailto) : null;
        const resolved = resolveDate(c, m.publishedRaw, cr);
        if (resolved.ambiguous) { c.status = "rejected"; c.rejectReason = `ambiguous publication date: ${resolved.ambiguous}`; c.dateEvidence = resolved.evidence; return; }
        if (!resolved.date || resolved.precision === "unknown") { c.status = "rejected"; c.rejectReason = "no publication date evidence"; c.dateEvidence = resolved.evidence; return; }
        c.publishedOn = resolved.date;
        c.precision = resolved.precision;
        c.dateEvidence = resolved.evidence;
        if (m.modifiedRaw) c.dateEvidence.modified = m.modifiedRaw;
      }
      if (!c.publishedOn) {
        const resolved = resolveDate(c, undefined, null);
        if (!resolved.date || resolved.precision === "unknown") { c.status = "rejected"; c.rejectReason = "no publication date evidence"; return; }
        c.publishedOn = resolved.date; c.precision = resolved.precision; c.dateEvidence = resolved.evidence;
      }
      if (!publicationFits(parseLocalDate(c.publishedOn), c.precision, w)) {
        c.status = "rejected"; c.rejectReason = `published ${c.publishedOn} (${c.precision}) is outside ${w.label}`; return;
      }
      if (c.publisher && excludedPublishers.some((p) => c.publisher!.toLowerCase().includes(p))) { c.status = "rejected"; c.rejectReason = "excluded publisher"; return; }
      if (c.authors.some((a) => excludedAuthors.some((x) => a.toLowerCase().includes(x)))) { c.status = "rejected"; c.rejectReason = "excluded author"; return; }
      if (!c.title) { c.status = "rejected"; c.rejectReason = "no title"; return; }
      c.status = "fetched";
    } catch (e) {
      c.status = "rejected";
      c.rejectReason = `fetch failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  while (i < cands.length && Date.now() < deadline) {
    const slice = cands.slice(i, i + cfg.fetchConcurrency).filter((c) => c.status === "new");
    await Promise.all(slice.map(one));
    i += cfg.fetchConcurrency;
    cp.cursor = i;
  }
  const done = i >= cands.length;
  if (done) {
    // Duplicate works within the batch (same normalised title) keep the richer copy.
    const seen = new Map<string, Candidate>();
    for (const c of cands) {
      if (c.status !== "fetched") continue;
      const key = (c.title ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const prev = seen.get(key);
      if (prev) {
        const keep = (prev.words ?? 0) >= (c.words ?? 0) ? prev : c;
        const drop = keep === prev ? c : prev;
        drop.status = "rejected"; drop.rejectReason = "duplicate work within batch";
        seen.set(key, keep);
      } else seen.set(key, c);
    }
    const fetched = cands.filter((c) => c.status === "fetched").length;
    log(`validated: ${fetched} fetched, ${cands.filter((c) => c.status === "rejected").length} rejected`);
  }
  return done;
}

/** Assess stage: classify borderline access with the cheaper model, then mark valid. */
export async function assess(cp: Checkpoint, adapter: ModelAdapter | null, log: (s: string) => void): Promise<void> {
  const cands = (cp.candidates ?? []).filter((c) => c.status === "fetched");
  const borderline = cands.filter((c) => c.accessClass === "unknown");
  if (borderline.length && adapter) {
    const inputs: AccessInput[] = borderline.slice(0, 40).map((c) => ({
      id: c.id, url: c.url, title: c.title, words: c.words ?? 0, sample: (c.text ?? "").slice(0, 1800), markers: (c.accessEvidence.markers as string[]) ?? [],
    }));
    try {
      const verdicts = await adapter.classifyAccess(inputs, cp.cost);
      for (const v of verdicts) {
        const c = borderline.find((x) => x.id === v.id);
        if (!c) continue;
        if (v.kind === "full_text" && v.complete) { c.accessClass = "free_full_text"; c.evidenceDepth = "full_text"; c.accessEvidence = { ...c.accessEvidence, classifier: v.note }; }
        else if (v.kind === "abstract" && (c.sourceEvidence.openalex || c.sourceEvidence.arxiv)) { c.accessClass = "open_copy"; c.evidenceDepth = "abstract"; c.accessEvidence = { ...c.accessEvidence, classifier: v.note }; }
        else { c.status = "rejected"; c.rejectReason = `access unverified (${v.kind}: ${v.note})`; }
      }
    } catch (e) {
      log(`access classification failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  for (const c of cands) {
    if (c.status !== "fetched") continue;
    if (c.accessClass === "unknown" || c.accessClass === "preview_only" || c.accessClass === "paywall") { c.status = "rejected"; c.rejectReason = "access could not be verified"; continue; }
    if (c.evidenceDepth === "none") { c.status = "rejected"; c.rejectReason = "no content evidence (title/snippet only)"; continue; }
    c.status = "valid";
  }
  const valid = (cp.candidates ?? []).filter((c) => c.status === "valid").length;
  log(`assessed: ${valid} valid candidates`);
  // Trim stored text to keep the checkpoint compact for the ranker prompt.
  for (const c of cp.candidates ?? []) if (c.status !== "valid") delete c.text;
}
