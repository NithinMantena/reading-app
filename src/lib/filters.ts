// Pure client-side filtering and sorting that mirrors the server's rules. Kept free of
// any Supabase import so it can be unit-tested under any Node version.
import type { Book, Reading } from "./types";


const norm = (s: string) => s.toLowerCase();

export function filterBooks(items: Book[], opts: { q?: string; status?: string; sort: string; asc: boolean }): Book[] {
  let out = items;
  if (opts.status) out = out.filter((b) => b.library_status === opts.status);
  if (opts.q) {
    const q = norm(opts.q.trim());
    out = out.filter((b) => norm(b.title).includes(q) || b.authors.some((a) => norm(a).includes(q)));
  }
  const col: Record<string, (b: Book) => string | number | null | undefined> = {
    updated: (b) => b.updated_at,
    created: (b) => b.created_at,
    rating: (b) => b.rating,
    title: (b) => norm(b.title),
    finished: (b) => b.finished_on,
    started: (b) => b.started_on,
  };
  const get = col[opts.sort] ?? col.updated;
  return [...out].sort((a, b) => {
    const av = get(a), bv = get(b);
    // Nulls last regardless of direction, as the server does.
    if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
    if (bv === null || bv === undefined) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return opts.asc ? cmp : -cmp;
  });
}

export function filterReadings(items: Reading[], opts: { q?: string; status?: string }): Reading[] {
  let out = opts.status ? items.filter((r) => r.queue_status === opts.status) : items.filter((r) => r.queue_status !== "archived");
  if (opts.q) {
    const q = norm(opts.q.trim());
    out = out.filter((r) => norm(r.title).includes(q) || (r.publisher && norm(r.publisher).includes(q)) || (r.canonical_url && norm(r.canonical_url).includes(q)));
  }
  return out;
}
