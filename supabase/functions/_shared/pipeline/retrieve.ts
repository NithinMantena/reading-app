// Stage 2: gather candidates from search APIs, feeds, and scholarly sources.
import type { Horizon } from "../periods.ts";
import { isNytUrl } from "../urls.ts";
import type { Candidate, Checkpoint, RunConfig } from "./types.ts";
import type { ModelAdapter } from "./model.ts";
import { arxivSearch, braveSearch, exaSearch, hnTop, openAlexSearch, rssItems, safeCanonical, sourcePlan, type Hit, type WindowIso } from "./sources.ts";

const BLOCKED_HOSTS = new Set([
  "youtube.com", "youtu.be", "twitter.com", "x.com", "facebook.com", "instagram.com", "tiktok.com", "reddit.com", "linkedin.com",
  "github.com", "amazon.com", "news.ycombinator.com", "wikipedia.org", "google.com", "apple.com", "play.google.com",
]);

function hostBlocked(url: string): boolean {
  const h = new URL(url).hostname.replace(/^www\./, "");
  for (const b of BLOCKED_HOSTS) if (h === b || h.endsWith(`.${b}`)) return true;
  return false;
}

export async function retrieve(cp: Checkpoint, horizon: Horizon, cfg: RunConfig, adapter: ModelAdapter | null, log: (s: string) => void): Promise<Candidate[]> {
  const ctx = cp.context!;
  const plan = sourcePlan(horizon);
  const endInclusive = new Date(new Date(cp.window.end).getTime() - 86400000).toISOString().slice(0, 10);
  const w: WindowIso = { start: cp.window.start, end: cp.window.end, startDate: cp.window.start.slice(0, 10), endDateInclusive: endInclusive };

  // Queries: model-generated when available, otherwise straight from interests.
  let queries = cp.queries;
  if (!queries) {
    if (adapter) {
      try {
        queries = await adapter.generateQueries({ horizon, windowLabel: cp.window.label, context: ctx, ledger: cp.cost });
      } catch (e) {
        log(`query generation failed (${e instanceof Error ? e.message : e}); using interests directly`);
      }
    }
    if (!queries || !queries.core.length) {
      queries = { core: ctx.interests.map((i) => i.topic).slice(0, 10), exploration: ["history of science essay", "long-form reportage", "mathematics exposition"] };
    }
    cp.queries = queries;
  }
  const allQueries = [...queries.core, ...queries.exploration];
  log(`queries: ${queries.core.length} core, ${queries.exploration.length} exploration`);

  const tasks: Promise<Hit[]>[] = [];
  const wrap = (name: string, p: Promise<Hit[]>) => tasks.push(p.then((h) => { cp.cost.searches++; return h; }).catch((e) => { log(`${name} failed: ${e instanceof Error ? e.message : e}`); return []; }));

  if (cfg.exaKey) for (const q of allQueries) wrap(`exa:${q}`, exaSearch(cfg.exaKey, q, w, plan.webPerQuery));
  else if (cfg.braveKey) for (const q of allQueries) wrap(`brave:${q}`, braveSearch(cfg.braveKey, q, w, plan.webPerQuery));
  if (plan.hn) {
    wrap("hn:top", hnTop(w, plan.hnMinPoints));
    for (const q of queries.core.slice(0, 4)) wrap(`hn:${q}`, hnTop(w, Math.max(20, plan.hnMinPoints / 4), q, 15));
  }
  if (plan.arxiv) for (const q of queries.core.slice(0, 5)) wrap(`arxiv:${q}`, arxivSearch(q, w, 12));
  if (plan.openalex) {
    wrap("openalex:top", openAlexSearch(null, w, cfg.openAlexMailto, 30));
    for (const q of queries.core.slice(0, 6)) wrap(`openalex:${q}`, openAlexSearch(q, w, cfg.openAlexMailto, 12, horizon === "monthly" ? "relevance_score:desc" : "cited_by_count:desc"));
    for (const q of queries.exploration.slice(0, 2)) wrap(`openalex:x:${q}`, openAlexSearch(q, w, cfg.openAlexMailto, 8));
  }
  for (const s of ctx.sources.slice(0, 40)) wrap(`rss:${s.url}`, rssItems(s.url, w, s.label));

  const hits = (await Promise.all(tasks)).flat();
  log(`raw hits: ${hits.length}`);

  // Model-proposed leads for long horizons (verified later like everything else).
  const leads: Hit[] = [];
  if (plan.leads && adapter) {
    try {
      const proposed = await adapter.proposeLeads({ horizon, windowLabel: cp.window.label, windowStart: cp.window.start, windowEnd: cp.window.end, context: ctx, ledger: cp.cost, count: horizon === "monthly" ? 10 : 16 });
      for (const l of proposed) if (l.url) leads.push({ url: l.url, title: l.title, source: "model_lead", evidence: { why: l.why, note: "Suggested by model; must be verified" } });
      log(`model leads: ${leads.length} with URLs`);
    } catch (e) {
      log(`lead proposal failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Dedupe by canonical URL, drop blocked hosts and things the reader already has.
  const known = new Set([...ctx.knownUrls, ...ctx.surfacedSameHorizon, ...(ctx.keepUrls ?? [])]);
  const seen = new Map<string, Candidate>();
  let n = 0;
  for (const h of [...hits, ...leads]) {
    const canon = safeCanonical(h.url);
    if (!canon || hostBlocked(canon)) continue;
    if (known.has(canon)) continue;
    if (isNytUrl(canon) && !ctx.accessExceptions.includes("nyt_subscription")) continue;
    const existing = seen.get(canon);
    if (existing) {
      // Merge evidence from multiple sources.
      existing.sourceEvidence[h.source] = h.evidence;
      existing.title ??= h.title;
      existing.description ??= h.description;
      if (h.publishedRaw && !existing.dateEvidence[h.source]) existing.dateEvidence[h.source] = h.publishedRaw;
      continue;
    }
    n++;
    seen.set(canon, {
      id: `c${n}`,
      url: canon,
      originalUrl: h.url,
      title: h.title,
      authors: h.authors ?? [],
      publisher: h.publisher,
      source: h.source,
      sourceEvidence: { [h.source]: h.evidence, openAccessClaimed: Boolean(h.openAccess) },
      precision: "unknown",
      dateEvidence: h.publishedRaw ? { [h.source]: h.publishedRaw } : {},
      accessClass: "unknown",
      accessEvidence: {},
      description: h.description,
      evidenceDepth: "none",
      itemType: h.itemType ?? "article",
      topics: [],
      status: "new",
      previouslySuggested: ctx.surfacedOtherHorizons.includes(canon),
      lead: h.source === "model_lead",
    });
  }
  // Prefer items with multiple sources or rich evidence when trimming to the cap.
  const ranked = [...seen.values()].sort((a, b) => Object.keys(b.sourceEvidence).length - Object.keys(a.sourceEvidence).length);
  const capped = ranked.slice(0, cfg.maxCandidates);
  log(`candidates after dedupe: ${seen.size}; kept ${capped.length}`);
  return capped;
}
