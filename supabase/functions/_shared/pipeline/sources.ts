// Candidate retrieval sources. Each returns raw hits with whatever date/access evidence
// the source supplies. Nothing here is trusted for eligibility; validation re-checks.
import type { Horizon } from "../periods.ts";
import { canonicalizeUrl } from "../urls.ts";
import { assertPublicHost, decodeEntities } from "../extract.ts";

export interface Hit {
  url: string;
  title?: string;
  authors?: string[];
  publisher?: string;
  publishedRaw?: string;
  description?: string;
  source: string;
  evidence: Record<string, unknown>;
  itemType?: string;
  /** set when the source vouches for open access (still re-checked) */
  openAccess?: boolean;
}

export interface WindowIso {
  start: string; // inclusive ISO date-time
  end: string; // exclusive
  startDate: string; // YYYY-MM-DD
  endDateInclusive: string; // YYYY-MM-DD
}

const TIMEOUT = 12000;

async function getJson(url: string, headers: Record<string, string> = {}, init: RequestInit = {}): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...init, headers: { accept: "application/json", ...headers }, signal: ac.signal });
    if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function getText(url: string): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    await assertPublicHost(new URL(url));
    const res = await fetch(url, { signal: ac.signal, headers: { "user-agent": "reading-app/0.2 feed reader" } });
    if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Exa (neural search with publication-date filters and text contents)
// ---------------------------------------------------------------------------
export async function exaSearch(key: string, query: string, w: WindowIso, num = 10, category?: string): Promise<Hit[]> {
  const body: Record<string, unknown> = {
    query, numResults: num, type: "auto", startPublishedDate: w.start, endPublishedDate: w.end,
    contents: { text: { maxCharacters: 4000 }, highlights: false },
  };
  if (category) body.category = category;
  const json = (await getJson("https://api.exa.ai/search", { "x-api-key": key, "content-type": "application/json" }, { method: "POST", body: JSON.stringify(body) })) as { results?: Array<Record<string, unknown>> };
  return (json.results ?? []).filter((r) => typeof r.url === "string").map((r) => ({
    url: String(r.url),
    title: r.title ? String(r.title) : undefined,
    authors: r.author ? [String(r.author)] : undefined,
    publishedRaw: r.publishedDate ? String(r.publishedDate) : undefined,
    description: r.text ? String(r.text).slice(0, 1500) : undefined,
    source: "exa",
    evidence: { exaPublishedDate: r.publishedDate ?? null, query },
  }));
}

// ---------------------------------------------------------------------------
// Brave Search (web, with freshness date range)
// ---------------------------------------------------------------------------
export async function braveSearch(key: string, query: string, w: WindowIso, num = 10): Promise<Hit[]> {
  const freshness = `${w.startDate}to${w.endDateInclusive}`;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${num}&freshness=${freshness}&text_decorations=false&result_filter=web`;
  const json = (await getJson(url, { "X-Subscription-Token": key })) as { web?: { results?: Array<Record<string, unknown>> } };
  return (json.web?.results ?? []).filter((r) => typeof r.url === "string").map((r) => ({
    url: String(r.url),
    title: r.title ? String(r.title) : undefined,
    publishedRaw: r.page_age ? String(r.page_age) : undefined,
    description: r.description ? String(r.description) : undefined,
    source: "brave",
    evidence: { bravePageAge: r.page_age ?? null, query },
  }));
}

// ---------------------------------------------------------------------------
// Hacker News (Algolia) — free; quality proxy via points
// ---------------------------------------------------------------------------
export async function hnTop(w: WindowIso, minPoints: number, query?: string, num = 40): Promise<Hit[]> {
  const startS = Math.floor(new Date(w.start).getTime() / 1000);
  const endS = Math.floor(new Date(w.end).getTime() / 1000);
  const q = query ? `&query=${encodeURIComponent(query)}` : "";
  const url = `https://hn.algolia.com/api/v1/search${query ? "" : "_by_date"}?tags=story&hitsPerPage=${num}&numericFilters=created_at_i>=${startS},created_at_i<${endS},points>=${minPoints}${q}`;
  const json = (await getJson(url)) as { hits?: Array<Record<string, unknown>> };
  return (json.hits ?? []).filter((h) => typeof h.url === "string" && h.url).map((h) => ({
    url: String(h.url),
    title: h.title ? String(h.title) : undefined,
    source: "hn",
    evidence: { hnPoints: h.points, hnComments: h.num_comments, hnId: h.objectID, hnCreated: h.created_at, note: "HN date is the submission date, not publication; verified separately" },
  }));
}

// ---------------------------------------------------------------------------
// arXiv — free; exact submission dates; abs pages carry citation_* metadata
// ---------------------------------------------------------------------------
export async function arxivSearch(query: string, w: WindowIso, num = 25): Promise<Hit[]> {
  const fmt = (iso: string) => iso.replace(/[-:T]/g, "").slice(0, 12);
  const endInclusive = new Date(new Date(w.end).getTime() - 60000).toISOString();
  const q = `submittedDate:[${fmt(w.start)} TO ${fmt(endInclusive)}] AND (${query.split(/\s+/).filter(Boolean).map((t) => `all:${t.replace(/[^\w-]/g, "")}`).filter((t) => t.length > 4).join(" AND ") || "all:the"})`;
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&max_results=${num}&sortBy=relevance`;
  const xml = await getText(url);
  const entries = xml.split("<entry>").slice(1);
  return entries.map((e) => {
    const g = (tag: string) => decodeEntities((new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(e)?.[1] ?? "").trim());
    const id = g("id");
    const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => decodeEntities(m[1].trim()));
    const published = g("published");
    return {
      url: id.replace(/^http:/, "https:"),
      title: g("title").replace(/\s+/g, " "),
      authors,
      publisher: "arXiv",
      publishedRaw: published,
      description: g("summary").replace(/\s+/g, " ").slice(0, 1500),
      source: "arxiv",
      itemType: "paper",
      openAccess: true,
      evidence: { arxivPublished: published, arxivUpdated: g("updated"), query },
    } as Hit;
  }).filter((h) => h.url);
}

// ---------------------------------------------------------------------------
// OpenAlex — free; publication dates, citation counts, open-access locations
// ---------------------------------------------------------------------------
export async function openAlexSearch(query: string | null, w: WindowIso, mailto: string | undefined, num = 25, sort: "cited_by_count:desc" | "relevance_score:desc" = "cited_by_count:desc"): Promise<Hit[]> {
  const endInclusive = new Date(new Date(w.end).getTime() - 86400000).toISOString().slice(0, 10);
  const filter = `from_publication_date:${w.startDate},to_publication_date:${endInclusive},is_oa:true,type:article|review|book|report|preprint`;
  const params = new URLSearchParams({ filter, "per-page": String(num), sort, select: "id,doi,title,display_name,publication_date,authorships,primary_location,open_access,cited_by_count,type,abstract_inverted_index" });
  if (query) params.set("search", query);
  if (mailto) params.set("mailto", mailto);
  const json = (await getJson(`https://api.openalex.org/works?${params}`)) as { results?: Array<Record<string, unknown>> };
  return (json.results ?? []).map((r) => {
    const oa = r.open_access as { oa_url?: string; is_oa?: boolean } | undefined;
    const loc = r.primary_location as { landing_page_url?: string; pdf_url?: string; source?: { display_name?: string } } | undefined;
    const url = oa?.oa_url ?? loc?.landing_page_url ?? (r.doi ? String(r.doi) : undefined);
    const authorships = (r.authorships as Array<{ author?: { display_name?: string } }> | undefined) ?? [];
    const inv = r.abstract_inverted_index as Record<string, number[]> | null | undefined;
    let abstract: string | undefined;
    if (inv) {
      const words: [number, string][] = [];
      for (const [wd, pos] of Object.entries(inv)) for (const p of pos) words.push([p, wd]);
      abstract = words.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(" ").slice(0, 1500);
    }
    return {
      url: url ?? "",
      title: (r.display_name ?? r.title) ? String(r.display_name ?? r.title) : undefined,
      authors: authorships.map((a) => a.author?.display_name).filter((x): x is string => Boolean(x)).slice(0, 12),
      publisher: loc?.source?.display_name,
      publishedRaw: r.publication_date ? String(r.publication_date) : undefined,
      description: abstract,
      source: "openalex",
      itemType: String(r.type ?? "paper") === "book" ? "book" : "paper",
      openAccess: Boolean(oa?.is_oa),
      evidence: { openalexId: r.id, doi: r.doi ?? null, publicationDate: r.publication_date ?? null, citedBy: r.cited_by_count ?? 0, oaUrl: oa?.oa_url ?? null, query },
    } as Hit;
  }).filter((h) => h.url);
}

// ---------------------------------------------------------------------------
// Crossref — DOI metadata for date verification
// ---------------------------------------------------------------------------
export async function crossrefDate(doi: string, mailto?: string): Promise<{ date?: string; precision: "day" | "month" | "year" | "unknown"; raw?: unknown } | null> {
  try {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}${mailto ? `?mailto=${encodeURIComponent(mailto)}` : ""}`;
    const json = (await getJson(url)) as { message?: { issued?: { "date-parts"?: number[][] }; published?: { "date-parts"?: number[][] } } };
    const parts = json.message?.published?.["date-parts"]?.[0] ?? json.message?.issued?.["date-parts"]?.[0];
    if (!parts?.length) return { precision: "unknown", raw: json.message?.issued };
    const [y, m, d] = parts;
    if (d) return { date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, precision: "day", raw: parts };
    if (m) return { date: `${y}-${String(m).padStart(2, "0")}-01`, precision: "month", raw: parts };
    return { date: `${y}-01-01`, precision: "year", raw: parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// RSS / Atom feeds the owner trusts
// ---------------------------------------------------------------------------
export async function rssItems(feedUrl: string, w: WindowIso, label?: string): Promise<Hit[]> {
  const xml = await getText(feedUrl);
  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const chunks = isAtom ? xml.split(/<entry[\s>]/i).slice(1) : xml.split(/<item[\s>]/i).slice(1);
  const feedTitle = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(xml)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim() ?? "");
  const startMs = new Date(w.start).getTime();
  const endMs = new Date(w.end).getTime();
  const out: Hit[] = [];
  for (const c of chunks) {
    const g = (tag: string) => (new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(c)?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    let link = g("link");
    if (isAtom) link = /<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i.exec(c)?.[1] ?? /<link[^>]+href=["']([^"']+)["']/i.exec(c)?.[1] ?? link;
    const dateRaw = g("pubDate") || g("published") || g("dc:date") || g("updated");
    const t = new Date(dateRaw).getTime();
    if (!link || Number.isNaN(t) || t < startMs || t >= endMs) continue;
    out.push({
      url: decodeEntities(link),
      title: decodeEntities(g("title")).replace(/<[^>]+>/g, ""),
      authors: [g("dc:creator") || g("author") ? decodeEntities((g("dc:creator") || /<name>([\s\S]*?)<\/name>/i.exec(g("author"))?.[1] || g("author")).replace(/<[^>]+>/g, "")) : ""].filter(Boolean),
      publisher: label || feedTitle || undefined,
      publishedRaw: dateRaw,
      description: decodeEntities((g("description") || g("summary") || g("content")).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").slice(0, 1500),
      source: "rss",
      evidence: { feed: feedUrl, feedDate: dateRaw },
    });
  }
  return out;
}

export function safeCanonical(url: string): string | null {
  try {
    return canonicalizeUrl(url);
  } catch {
    return null;
  }
}

export function sourcePlan(h: Horizon): { hn: boolean; arxiv: boolean; openalex: boolean; leads: boolean; webPerQuery: number; hnMinPoints: number } {
  switch (h) {
    case "daily": return { hn: true, arxiv: false, openalex: false, leads: false, webPerQuery: 6, hnMinPoints: 80 };
    case "weekly": return { hn: true, arxiv: true, openalex: false, leads: false, webPerQuery: 8, hnMinPoints: 200 };
    case "monthly": return { hn: true, arxiv: true, openalex: true, leads: true, webPerQuery: 8, hnMinPoints: 400 };
    case "yearly": return { hn: false, arxiv: true, openalex: true, leads: true, webPerQuery: 8, hnMinPoints: 0 };
    case "decade": return { hn: false, arxiv: false, openalex: true, leads: true, webPerQuery: 6, hnMinPoints: 0 };
  }
}
