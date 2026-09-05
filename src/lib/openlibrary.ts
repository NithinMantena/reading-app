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
