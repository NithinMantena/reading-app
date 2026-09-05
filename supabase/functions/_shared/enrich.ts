// Metadata enrichment for manually saved readings. Uses the safe fetcher in extract.ts.
import { extractMainText, fetchDocument, parseMetadata, wordCount } from "./extract.ts";
import { isNytUrl } from "./urls.ts";

export interface Enrichment {
  title?: string;
  authors?: string[];
  publisher?: string;
  description?: string;
  publishedOn?: string;
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

export async function enrichUrl(url: string): Promise<Enrichment> {
  try {
    const { url: finalUrl, html, contentType, status } = await fetchDocument(url);
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
    const m = parseMetadata(html, finalUrl);
    const text = extractMainText(html);
    const words = wordCount(text);
    const durationMinutes = words > 100 ? Math.max(1, Math.round(words / 230)) : undefined;
    return {
      status: "done",
      finalUrl,
      title: m.title,
      authors: m.authors,
      publisher: m.publisher,
      description: m.description?.slice(0, 1000),
      publishedOn: m.publishedOn,
      publishedPrecision: m.precision,
      publishedEvidence: m.publishedRaw
        ? { source: "page-metadata", raw: m.publishedRaw, note: "Publisher-supplied date; time-zone precision unavailable" }
        : {},
      durationMinutes,
      itemType: m.isPaper ? "paper" : "article",
      accessClass: nyt ? "nyt_subscription" : "unknown",
      accessEvidence: {
        note: nyt ? "NYT article; opens on nytimes.com with the user's own login" : "Access not verified for manual saves",
        httpStatus: status,
        approxWords: words,
      },
    };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e), accessClass: "unknown" };
  }
}
