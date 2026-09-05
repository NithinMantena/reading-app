// Safe metadata enrichment for saved readings.
//
// Retrieved pages are untrusted content: this module only extracts bibliographic
// metadata. It refuses local/private network destinations, re-checks every redirect,
// caps response size and time, and never returns page text to the caller.
import { isNytUrl } from "./urls.ts";

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "reading-app/0.1 (+https://github.com/NithinMantena/reading-app; metadata fetch)";

export interface Enrichment {
  title?: string;
  authors?: string[];
  publisher?: string;
  description?: string;
  publishedOn?: string; // YYYY-MM-DD
  publishedPrecision?: "day" | "month" | "year" | "unknown";
  publishedEvidence?: Record<string, unknown>;
  durationMinutes?: number;
  itemType?: string;
  finalUrl?: string;
  accessClass?: "free_full_text" | "open_copy" | "nyt_subscription" | "preview_only" | "paywall" | "unknown";
  accessEvidence?: Record<string, unknown>;
  status: "done" | "failed";
  error?: string;
}

function isPrivateIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    p[0] >= 224
  );
}

function isPrivateIpv6(ip: string): boolean {
  const s = ip.toLowerCase();
  return (
    s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80") ||
    s.startsWith("::ffff:") || s.startsWith("2001:db8")
  );
}

async function assertPublicHost(u: URL): Promise<void> {
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
    // Resolver unavailable in this runtime: fall through and rely on hostname checks.
  }
}

async function safeFetch(startUrl: string): Promise<{ url: string; html: string; contentType: string; status: number }> {
  let current = new URL(startUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublicHost(current);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(current.toString(), {
        redirect: "manual",
        signal: ac.signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
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

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function meta(html: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name|itemprop)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*content=["']([^"']*)["']` +
        `|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
      "i",
    );
    const m = re.exec(html);
    const v = (m?.[1] ?? m?.[2])?.trim();
    if (v) return decodeEntities(v);
  }
  return undefined;
}

function jsonLd(html: string): Record<string, unknown>[] {
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

export function parseDateEvidence(raw: string | undefined): { date?: string; precision: "day" | "month" | "year" | "unknown" } {
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

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function names(v: unknown): string[] {
  if (!v) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(names);
  if (typeof v === "object" && "name" in (v as Record<string, unknown>)) return names((v as Record<string, unknown>).name);
  return [];
}

export async function enrichUrl(url: string): Promise<Enrichment> {
  try {
    const { url: finalUrl, html, contentType, status } = await safeFetch(url);
    const nyt = isNytUrl(finalUrl);
    if (!/html|xml/i.test(contentType)) {
      const isPdf = /pdf/i.test(contentType);
      return {
        status: "done",
        finalUrl,
        itemType: isPdf ? "paper" : "document",
        accessClass: nyt ? "nyt_subscription" : "unknown",
        accessEvidence: { note: `Non-HTML content (${contentType}); access not verified`, httpStatus: status },
      };
    }
    const ld = jsonLd(html);
    const article = ld.find((x) => /Article|Report|ScholarlyArticle|BlogPosting|NewsArticle/i.test(String(x["@type"])));
    const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    const title = meta(html, ["og:title", "twitter:title", "citation_title", "dc.title"]) ??
      (article?.headline as string | undefined) ?? (titleTag ? decodeEntities(titleTag.trim()) : undefined);
    const authorMeta = meta(html, ["citation_author", "author", "article:author", "dc.creator", "parsely-author"]);
    const authors = names(article?.author).length ? names(article?.author) : authorMeta ? [authorMeta] : [];
    const publisher = meta(html, ["og:site_name", "citation_publisher", "dc.publisher", "publisher"]) ??
      names(article?.publisher)[0] ?? new URL(finalUrl).hostname.replace(/^www\./, "");
    const description = meta(html, ["og:description", "description", "twitter:description", "citation_abstract"]);
    const rawDate = meta(html, [
      "article:published_time", "citation_publication_date", "citation_date", "dc.date", "date", "parsely-pub-date", "pubdate",
    ]) ?? (article?.datePublished as string | undefined) ??
      /<time[^>]+datetime=["']([^"']+)["']/i.exec(html)?.[1];
    const { date, precision } = parseDateEvidence(rawDate);
    const text = stripTags(html);
    const words = text.split(" ").filter((w) => w.length > 1).length;
    const durationMinutes = words > 100 ? Math.max(1, Math.round(words / 230)) : undefined;
    const isPaper = Boolean(meta(html, ["citation_title"])) || /ScholarlyArticle/i.test(String(article?.["@type"]));
    return {
      status: "done",
      finalUrl,
      title: title?.slice(0, 500),
      authors: authors.map((a) => a.slice(0, 200)).slice(0, 10),
      publisher: publisher?.slice(0, 200),
      description: description?.slice(0, 1000),
      publishedOn: date,
      publishedPrecision: precision,
      publishedEvidence: rawDate ? { source: "page-metadata", raw: rawDate, note: "Publisher-supplied date; time-zone precision unavailable" } : {},
      durationMinutes,
      itemType: isPaper ? "paper" : "article",
      accessClass: nyt ? "nyt_subscription" : "unknown",
      accessEvidence: {
        note: nyt ? "NYT article; opens on nytimes.com with the user's own login" : "Access not verified in Phase 1 (manual save)",
        httpStatus: status,
        approxWords: words,
      },
    };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e), accessClass: "unknown" };
  }
}
