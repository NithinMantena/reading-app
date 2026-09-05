// Safe document fetching and metadata/text extraction.
//
// Retrieved pages are untrusted content. This module refuses local/private network
// destinations, re-checks every redirect, caps response size and time, and extracts
// only bibliographic metadata plus a bounded main-text sample for assessment.

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "reading-app/0.2 (+https://github.com/NithinMantena/reading-app; metadata fetch)";

export interface FetchedDocument {
  url: string;
  html: string;
  contentType: string;
  status: number;
}

function isPrivateIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  return (
    p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224
  );
}

function isPrivateIpv6(ip: string): boolean {
  const s = ip.toLowerCase();
  return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80") ||
    s.startsWith("::ffff:") || s.startsWith("2001:db8");
}

export async function assertPublicHost(u: URL): Promise<void> {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Unsupported scheme");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Refusing local destination");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIpv4(host)) throw new Error("Refusing private IPv4 destination");
    return;
  }
  if (host.includes(":")) {
    if (isPrivateIpv6(host)) throw new Error("Refusing private IPv6 destination");
    return;
  }
  try {
    const [a, aaaa] = await Promise.all([
      Deno.resolveDns(host, "A").catch(() => [] as string[]),
      Deno.resolveDns(host, "AAAA").catch(() => [] as string[]),
    ]);
    const addrs = [...a, ...aaaa];
    if (addrs.length === 0) throw new Error("Host did not resolve");
    for (const ip of addrs) {
      if (ip.includes(".") ? isPrivateIpv4(ip) : isPrivateIpv6(ip)) throw new Error("Host resolves to a private address");
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Host")) throw e;
    // Resolver unavailable in this runtime: rely on hostname checks.
  }
}

export async function fetchDocument(startUrl: string, accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"): Promise<FetchedDocument> {
  let current = new URL(startUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublicHost(current);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(current.toString(), {
        redirect: "manual",
        signal: ac.signal,
        headers: { "user-agent": USER_AGENT, accept },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`Redirect without location (${res.status})`);
        current = new URL(loc, current);
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      const reader = res.body?.getReader();
      if (!reader) return { url: current.toString(), html: "", contentType, status: res.status };
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        chunks.push(value);
        if (total >= MAX_BYTES) {
          reader.cancel().catch(() => {});
          break;
        }
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      return { url: current.toString(), html: new TextDecoder("utf-8", { fatal: false }).decode(merged), contentType, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Too many redirects");
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function meta(html: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const k = escapeRe(key);
    const re = new RegExp(
      `<meta[^>]+(?:property|name|itemprop)=["']${k}["'][^>]*content=["']([^"']*)["']` +
        `|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${k}["']`,
      "i",
    );
    const m = re.exec(html);
    const v = (m?.[1] ?? m?.[2])?.trim();
    if (v) return decodeEntities(v);
  }
  return undefined;
}

export function metaAll(html: string, key: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRe(key)}["'][^>]*content=["']([^"']*)["']`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) if (m[1].trim()) out.push(decodeEntities(m[1].trim()));
  return out;
}

export function jsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1]);
      const items = Array.isArray(parsed) ? parsed : parsed["@graph"] ? parsed["@graph"] : [parsed];
      for (const it of items) if (it && typeof it === "object") out.push(it as Record<string, unknown>);
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return out;
}

export type Precision = "day" | "month" | "year" | "unknown";

export function parseDateEvidence(raw: string | undefined): { date?: string; precision: Precision } {
  if (!raw) return { precision: "unknown" };
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, precision: "day" };
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return { date: `${m[1]}-${m[2]}-01`, precision: "month" };
  m = /^(\d{4})$/.exec(s);
  if (m) return { date: `${m[1]}-01-01`, precision: "year" };
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return { date: d.toISOString().slice(0, 10), precision: "day" };
  return { precision: "unknown" };
}

function names(v: unknown): string[] {
  if (!v) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(names);
  if (typeof v === "object" && "name" in (v as Record<string, unknown>)) return names((v as Record<string, unknown>).name);
  return [];
}

export interface PageMetadata {
  title?: string;
  authors: string[];
  publisher?: string;
  description?: string;
  publishedRaw?: string;
  publishedOn?: string;
  precision: Precision;
  modifiedRaw?: string;
  isPaper: boolean;
  /** schema.org isAccessibleForFree, when declared */
  accessibleForFree?: boolean;
  doi?: string;
  articleType?: string;
}

export function parseMetadata(html: string, finalUrl: string): PageMetadata {
  const ld = jsonLd(html);
  const article = ld.find((x) => /Article|Report|ScholarlyArticle|BlogPosting|NewsArticle|Book|CreativeWork/i.test(String(x["@type"])));
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = meta(html, ["og:title", "twitter:title", "citation_title", "dc.title"]) ??
    (article?.headline as string | undefined) ?? (titleTag ? decodeEntities(titleTag.trim()) : undefined);
  const citationAuthors = metaAll(html, "citation_author");
  const authorMeta = meta(html, ["author", "article:author", "dc.creator", "parsely-author"]);
  const authors = citationAuthors.length ? citationAuthors : names(article?.author).length ? names(article?.author) : authorMeta ? [authorMeta] : [];
  const publisher = meta(html, ["og:site_name", "citation_publisher", "citation_journal_title", "dc.publisher", "publisher"]) ??
    names(article?.publisher)[0] ?? new URL(finalUrl).hostname.replace(/^www\./, "");
  const description = meta(html, ["og:description", "description", "twitter:description", "citation_abstract", "dc.description"]);
  const publishedRaw = meta(html, [
    "article:published_time", "citation_publication_date", "citation_online_date", "citation_date", "dc.date", "dc.date.issued",
    "date", "parsely-pub-date", "pubdate", "datePublished",
  ]) ?? (article?.datePublished as string | undefined) ?? /<time[^>]+datetime=["']([^"']+)["'][^>]*(?:pubdate|published)/i.exec(html)?.[1];
  const modifiedRaw = meta(html, ["article:modified_time", "og:updated_time"]) ?? (article?.dateModified as string | undefined);
  const { date, precision } = parseDateEvidence(publishedRaw);
  const isPaper = citationAuthors.length > 0 || Boolean(meta(html, ["citation_title", "citation_doi"])) ||
    /ScholarlyArticle/i.test(String(article?.["@type"]));
  const aff = article?.isAccessibleForFree;
  const accessibleForFree = aff === undefined ? undefined : aff === true || aff === "True" || aff === "true";
  const doi = meta(html, ["citation_doi", "dc.identifier"])?.replace(/^doi:/i, "").trim();
  return {
    title: title?.slice(0, 500),
    authors: authors.map((a) => a.slice(0, 200)).slice(0, 12),
    publisher: publisher?.slice(0, 200),
    description: description?.slice(0, 1500),
    publishedRaw,
    publishedOn: date,
    precision,
    modifiedRaw,
    isPaper,
    accessibleForFree,
    doi: doi && /^10\.\d{4,9}\//.test(doi) ? doi : undefined,
    articleType: article?.["@type"] ? String(article["@type"]) : undefined,
  };
}

/** Main body text, roughly: drop scripts/nav/footer, prefer <article>/<main>, collapse whitespace. */
export function extractMainText(html: string, maxChars = 60000): string {
  let scope = html;
  const article = /<article[\s\S]*?<\/article>/i.exec(html)?.[0];
  const main = /<main[\s\S]*?<\/main>/i.exec(html)?.[0];
  const pick = [article, main].filter((x): x is string => Boolean(x && x.length > 1500)).sort((a, b) => b.length - a.length)[0];
  if (pick) scope = pick;
  const text = scope
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<(br|p|div|li|h[1-6]|tr|section)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return decodeEntities(text).slice(0, maxChars);
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 1).length;
}

const PAYWALL_MARKERS = [
  /subscribe to (continue|read|keep reading)/i, /already a subscriber/i, /sign in to continue reading/i, /this article is for subscribers/i,
  /become a member to read/i, /unlock this article/i, /start your free trial to/i, /log in to read the full/i, /premium content/i,
  /continue reading with a subscription/i, /you have reached your (free )?article limit/i, /paywall/i,
];

export function paywallMarkers(text: string): string[] {
  return PAYWALL_MARKERS.filter((re) => re.test(text)).map((re) => re.source);
}
