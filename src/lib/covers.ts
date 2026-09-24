// Fill in cover links for books that have none, one book at a time to stay polite to Open
// Library's API. Only the link is saved; images load from Open Library, not our database.
import { api } from "./api";
import { findCover } from "./openlibrary";
import type { Book } from "./types";

export interface CoverProgress { done: number; total: number; found: number }

export async function fillMissingCovers(books: Book[], onProgress?: (p: CoverProgress) => void): Promise<CoverProgress> {
  const list = books.filter((b) => !b.cover_url);
  const p: CoverProgress = { done: 0, total: list.length, found: 0 };
  onProgress?.(p);
  for (const b of list) {
    try {
      const url = await findCover(b);
      if (url) {
        await api.books.patch(b.id, { cover_url: url, version: b.version });
        p.found++;
      }
    } catch { /* skip this book; a later run can retry it */ }
    p.done++;
    onProgress?.({ ...p });
    await new Promise((r) => setTimeout(r, 400));
  }
  return p;
}
