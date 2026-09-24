// Book metadata lookup via Open Library (free, no key). Assists entry only; the user
// can always correct or ignore the suggestion.
export interface BookSuggestion {
  title: string;
  authors: string[];
  isbn?: string;
  coverUrl?: string;
  firstPublishYear?: number;
  key: string;
}

export async function searchBooks(query: string, signal?: AbortSignal): Promise<BookSuggestion[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=8&fields=key,title,author_name,isbn,cover_i,first_publish_year`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const json = (await res.json()) as { docs?: Array<Record<string, unknown>> };
  return (json.docs ?? []).map((d) => ({
    key: String(d.key),
    title: String(d.title ?? ""),
    authors: (d.author_name as string[] | undefined) ?? [],
    isbn: (d.isbn as string[] | undefined)?.find((i) => i.length === 13) ?? (d.isbn as string[] | undefined)?.[0],
    coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : undefined,
    firstPublishYear: d.first_publish_year as number | undefined,
  }));
}

// ---------------------------------------------------------------------------------------
// Cover lookup for books that have none. The stored value is only a URL; the image itself is
// served by Open Library's cover CDN straight to the browser, so covers cost no Supabase
// storage or egress.
// ---------------------------------------------------------------------------------------

export function coverUrlForId(coverId: number, size: "S" | "M" | "L" = "M"): string {
  return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;
}

function norm(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/^(the|a|an) /, "").trim();
}

/** Title before any subtitle, normalised. */
function mainTitle(s: string): string {
  return norm(s.split(/[:(]/)[0]);
}

function surname(author: string): string {
  const parts = norm(author).split(" ").filter(Boolean);
  return parts.at(-1) ?? "";
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** Surname match that tolerates small typos ("Khaneman") and run-together names ("AliceSchroeder"). */
function authorMatches(surnameWanted: string, docAuthors: string[]): boolean {
  const words = norm(docAuthors.join(" ")).split(" ").filter(Boolean);
  const squashed = words.join("");
  if (words.includes(surnameWanted)) return true;
  if (surnameWanted.length >= 6 && words.some((w) => w.length >= 4 && surnameWanted.endsWith(w) && squashed.includes(surnameWanted))) return true;
  return surnameWanted.length >= 5 && words.some((w) => Math.abs(w.length - surnameWanted.length) <= 2 && editDistance(w, surnameWanted) <= 2);
}

export interface CoverDoc { title?: string; author_name?: string[]; cover_i?: number }

/** Pick the first result whose title and (when known) author plausibly match the book. */
export function pickCover(book: { title: string; authors: string[] }, docs: CoverDoc[]): number | null {
  const want = mainTitle(book.title);
  if (!want) return null;
  const surnames = book.authors.map(surname).filter((s) => s.length > 1);
  for (const d of docs) {
    if (!d.cover_i || !d.title) continue;
    const got = mainTitle(d.title);
    const titleOk = got === want || (want.length >= 6 && (got.startsWith(want) || want.startsWith(got)) && Math.min(got.length, want.length) >= 6);
    if (!titleOk) continue;
    if (surnames.length && !surnames.some((s) => authorMatches(s, d.author_name ?? []))) continue;
    return d.cover_i;
  }
  return null;
}

/** Look up a cover for one book: by ISBN when known, else by title and author. */
export async function findCover(book: { title: string; authors: string[]; isbn: string | null }, signal?: AbortSignal): Promise<string | null> {
  const fields = "fields=title,author_name,cover_i&limit=5";
  const tries: string[] = [];
  const isbn = book.isbn?.replace(/[^0-9Xx]/g, "");
  if (isbn && (isbn.length === 10 || isbn.length === 13)) tries.push(`isbn=${isbn}`);
  const author = book.authors[0];
  const title = encodeURIComponent(book.title.split(/[:(]/)[0].trim());
  tries.push(`title=${title}${author ? `&author=${encodeURIComponent(author)}` : ""}`);
  // A misspelt author defeats Open Library's author filter; retry on the title alone and let
  // pickCover's typo-tolerant author check decide.
  if (author) tries.push(`title=${title}`);
  for (const q of tries) {
    const res = await fetch(`https://openlibrary.org/search.json?${q}&${fields}`, { signal });
    if (!res.ok) continue;
    const docs = ((await res.json()) as { docs?: CoverDoc[] }).docs ?? [];
    // An ISBN hit is the edition itself; only the title search needs the plausibility check.
    const id = q.startsWith("isbn=") ? docs.find((d) => d.cover_i)?.cover_i ?? null : pickCover(book, docs);
    if (id) return coverUrlForId(id);
  }
  return null;
}
