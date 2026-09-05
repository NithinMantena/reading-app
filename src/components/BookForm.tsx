import { useEffect, useRef, useState } from "react";
import type { Book, LibraryStatus } from "../lib/types";
import { LIBRARY_STATUS_LABEL, todayLocal } from "../lib/format";
import { searchBooks, type BookSuggestion } from "../lib/openlibrary";
import { ChipsInput, RatingInput } from "./ui";

export interface BookFormValues {
  title: string;
  authors: string[];
  author_unknown: boolean;
  library_status: LibraryStatus;
  started_on: string | null;
  finished_on: string | null;
  rating: number | null;
  topics: string[];
  isbn: string;
  edition: string;
  cover_url: string;
  description: string;
  why_read: string;
  recommended_by: string;
  notes: string;
}

export function fromBook(b?: Partial<Book> | null): BookFormValues {
  return {
    title: b?.title ?? "",
    authors: b?.authors ?? [],
    author_unknown: b?.author_unknown ?? false,
    library_status: b?.library_status ?? "want_to_read",
    started_on: b?.started_on ?? null,
    finished_on: b?.finished_on ?? null,
    rating: b?.rating ?? null,
    topics: b?.topics ?? [],
    isbn: b?.isbn ?? "",
    edition: b?.edition ?? "",
    cover_url: b?.cover_url ?? "",
    description: b?.description ?? "",
    why_read: b?.why_read ?? "",
    recommended_by: b?.recommended_by ?? "",
    notes: b?.notes ?? "",
  };
}

export function toPayload(v: BookFormValues, mode: "create" | "edit", timeZone?: string): Record<string, unknown> {
  const p: Record<string, unknown> = {
    title: v.title.trim(),
    authors: v.author_unknown ? [] : v.authors,
    author_unknown: v.author_unknown,
    topics: v.topics,
    isbn: v.isbn || null,
    edition: v.edition || null,
    cover_url: v.cover_url || null,
    description: v.description || null,
    why_read: v.why_read || null,
    recommended_by: v.recommended_by || null,
    notes: v.notes || null,
  };
  if (mode === "create") {
    p.library_status = v.library_status;
    if (v.library_status !== "want_to_read") {
      p.started_on = v.started_on;
      p.finished_on = v.library_status === "finished" ? v.finished_on ?? todayLocal(timeZone) : null;
      p.rating = v.rating;
    }
  }
  return p;
}

export function BookForm({ values, onChange, mode, timeZone }: {
  values: BookFormValues; onChange: (v: BookFormValues) => void; mode: "create" | "edit"; timeZone?: string;
}) {
  const set = <K extends keyof BookFormValues>(k: K, val: BookFormValues[K]) => onChange({ ...values, [k]: val });
  const [suggestions, setSuggestions] = useState<BookSuggestion[]>([]);
  const [lookupOpen, setLookupOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // Metadata lookup assists entry; it never blocks manual entry.
  useEffect(() => {
    if (mode !== "create" || values.title.trim().length < 3 || !lookupOpen) {
      setSuggestions([]);
      return;
    }
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    const t = window.setTimeout(() => {
      searchBooks(values.title, ac.signal).then(setSuggestions).catch(() => setSuggestions([]));
    }, 350);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [values.title, mode, lookupOpen]);

  const applySuggestion = (s: BookSuggestion) => {
    onChange({ ...values, title: s.title, authors: s.authors.length ? s.authors : values.authors, author_unknown: false, isbn: s.isbn ?? values.isbn, cover_url: s.coverUrl ?? values.cover_url });
    setLookupOpen(false);
    setSuggestions([]);
  };

  const dateNote = values.started_on && values.finished_on && values.finished_on < values.started_on ? "Finish date must not precede start date." : null;

  return (
    <div className="form-grid">
      <div className="field wide">
        <label htmlFor="bf-title">Title</label>
        <input id="bf-title" type="text" required value={values.title} autoComplete="off"
          onChange={(e) => { set("title", e.target.value); setLookupOpen(true); }} onFocus={() => setLookupOpen(true)} />
        {mode === "create" && suggestions.length > 0 && (
          <div className="suggestions" role="listbox" aria-label="Suggestions from Open Library">
            {suggestions.map((s) => (
              <button type="button" key={s.key} onClick={() => applySuggestion(s)} role="option" aria-selected={false}>
                {s.coverUrl ? <img src={s.coverUrl} alt="" loading="lazy" /> : <span style={{ width: 28, height: 40, background: "var(--paper-2)", borderRadius: 3, flex: "none" }} />}
                <span>
                  <span style={{ fontWeight: 600 }}>{s.title}</span>
                  <span className="muted small"> — {s.authors.join(", ") || "Unknown author"}{s.firstPublishYear ? ` (${s.firstPublishYear})` : ""}</span>
                </span>
              </button>
            ))}
            <button type="button" className="muted small" onClick={() => { setLookupOpen(false); setSuggestions([]); }}>Keep typing manually</button>
          </div>
        )}
      </div>
      <div className="field">
        <label htmlFor="bf-authors">Authors</label>
        <input id="bf-authors" type="text" placeholder="Separate with commas" disabled={values.author_unknown}
          value={values.authors.join(", ")}
          onChange={(e) => set("authors", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
        <label className="check small"><input type="checkbox" checked={values.author_unknown} onChange={(e) => set("author_unknown", e.target.checked)} /> Author unknown</label>
      </div>
      {mode === "create" && (
        <div className="field">
          <label htmlFor="bf-status">Status</label>
          <select id="bf-status" value={values.library_status} onChange={(e) => set("library_status", e.target.value as LibraryStatus)}>
            {(Object.keys(LIBRARY_STATUS_LABEL) as LibraryStatus[]).map((s) => <option key={s} value={s}>{LIBRARY_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
      )}
      {mode === "create" && values.library_status !== "want_to_read" && (
        <>
          <div className="field">
            <label htmlFor="bf-start">Started</label>
            <input id="bf-start" type="date" value={values.started_on ?? ""} onChange={(e) => set("started_on", e.target.value || null)} />
            <span className="hint">Leave blank if unknown. Never guess.</span>
          </div>
          {values.library_status === "finished" && (
            <div className="field">
              <label htmlFor="bf-finish">Finished</label>
              <input id="bf-finish" type="date" value={values.finished_on ?? todayLocal(timeZone)} onChange={(e) => set("finished_on", e.target.value || null)} />
              <button type="button" className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => set("finished_on", null)}>Finish date unknown</button>
            </div>
          )}
          {(values.library_status === "finished" || values.library_status === "stopped") && (
            <div className="field wide">
              <label htmlFor="bf-rating">Rating</label>
              <RatingInput id="bf-rating" value={values.rating} onChange={(r) => set("rating", r)} />
            </div>
          )}
          {dateNote && <div className="notice error wide">{dateNote}</div>}
        </>
      )}
      <div className="field wide">
        <span className="label">Topics</span>
        <ChipsInput values={values.topics} onChange={(t) => set("topics", t)} placeholder="e.g. Economics, Biography" />
      </div>
      <div className="field">
        <label htmlFor="bf-isbn">ISBN</label>
        <input id="bf-isbn" type="text" value={values.isbn} onChange={(e) => set("isbn", e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="bf-edition">Edition</label>
        <input id="bf-edition" type="text" value={values.edition} onChange={(e) => set("edition", e.target.value)} />
      </div>
      <div className="field wide">
        <label htmlFor="bf-cover">Cover image URL</label>
        <input id="bf-cover" type="url" value={values.cover_url} onChange={(e) => set("cover_url", e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="bf-rec">Recommended by</label>
        <input id="bf-rec" type="text" value={values.recommended_by} onChange={(e) => set("recommended_by", e.target.value)} />
      </div>
      <div className="field wide">
        <label htmlFor="bf-why">Why I want to read this</label>
        <textarea id="bf-why" value={values.why_read} onChange={(e) => set("why_read", e.target.value)} />
      </div>
      <div className="field wide">
        <label htmlFor="bf-desc">Description</label>
        <textarea id="bf-desc" value={values.description} onChange={(e) => set("description", e.target.value)} />
      </div>
      <div className="field wide">
        <label htmlFor="bf-notes">Notes</label>
        <textarea id="bf-notes" value={values.notes} onChange={(e) => set("notes", e.target.value)} />
      </div>
    </div>
  );
}
