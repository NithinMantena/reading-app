// Shared cache keys and fetchers. Views that show the same data share one entry, so
// Home → Discover → Home never refetches the shelves, and the Library's tabs filter a
// single in-memory list instead of asking the server again.
import { api } from "./api";
import { prefetch } from "./cache";

const PAGE = 500;

export const queries = {
  books: { key: "books:all", fetch: () => api.books.list({ limit: PAGE, sort: "updated" }) },
  booksArchived: { key: "books:archived", fetch: () => api.books.list({ limit: PAGE, sort: "updated", archived: true }) },
  book: (id: string) => ({ key: `books:one:${id}`, fetch: () => api.books.get(id) }),
  readings: { key: "readings:all", fetch: () => api.readings.list({ include_archived: true, limit: PAGE }) },
  recommendations: { key: "recs", fetch: () => api.recommendations.all() },
  archive: (horizon: string) => ({ key: `recs:archive:${horizon}`, fetch: () => api.recommendations.archive(horizon) }),
  generationConfig: { key: "generation:config", fetch: () => api.generation.config() },
  jobs: { key: "jobs", fetch: () => api.jobs.list() },
  tokens: { key: "tokens", fetch: () => api.tokens.list() },
  feedback: { key: "feedback:list", fetch: () => api.feedback.list({}) },
  feedbackSummary: { key: "feedback:summary", fetch: () => api.preferences.summary() },
};

/** Warm everything the main tabs need, right after sign-in, so the first click is instant. */
export function prefetchAll(): void {
  prefetch(queries.books.key, queries.books.fetch);
  prefetch(queries.recommendations.key, queries.recommendations.fetch);
  prefetch(queries.readings.key, queries.readings.fetch);
}

export { filterBooks, filterReadings } from "./filters";
