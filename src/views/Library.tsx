import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { LibraryStatus } from "../lib/types";
import { authorsText, fmtDate, fmtRating, LIBRARY_STATUS_LABEL } from "../lib/format";
import { useRealtime } from "../lib/useRealtime";
import { useAuth } from "../auth/AuthProvider";
import { useToast } from "../components/Toast";
import { invalidate, useQuery } from "../lib/cache";
import { filterBooks, queries } from "../lib/queries";
import { Empty, Modal, StatusBadge } from "../components/ui";
import { BookForm, fromBook, toPayload, type BookFormValues } from "../components/BookForm";

type Tab = "all" | LibraryStatus | "archived";
const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "want_to_read", label: "Want to read" },
  { id: "reading", label: "Reading" },
  { id: "finished", label: "Finished" },
  { id: "stopped", label: "Stopped" },
  { id: "unknown", label: "Unknown" },
  { id: "archived", label: "Archived" },
];

export function Library() {
  const { settings } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem("lib.tab") as Tab) || "all");
  const [view, setView] = useState<"table" | "covers">(() => (localStorage.getItem("lib.view") as "table" | "covers") || "table");
  const [sort, setSort] = useState("updated");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<BookFormValues>(fromBook());
  const [saving, setSaving] = useState(false);

  useEffect(() => localStorage.setItem("lib.tab", tab), [tab]);
  useEffect(() => localStorage.setItem("lib.view", view), [view]);

  // One list per archive state; tabs, search, and sort are applied locally so they are instant.
  const source = tab === "archived" ? queries.booksArchived : queries.books;
  const { data, error, refresh } = useQuery(source.key, source.fetch);
  useEffect(() => { if (error) toast.fail(error); }, [error, toast]);
  const tables = useMemo(() => ["books", "reading_sessions"], []);
  useRealtime(tables, refresh);

  const books = useMemo(
    () => (data ? filterBooks(data.items, { q, status: tab !== "all" && tab !== "archived" ? tab : undefined, sort, asc: sort === "title" }) : null),
    [data, q, tab, sort],
  );
  const total = books?.length ?? 0;
  const truncated = data ? data.total > data.items.length : false;

  const submit = async () => {
    if (!form.title.trim()) return toast.fail(new Error("Title is required"));
    if (!form.author_unknown && form.authors.length === 0) return toast.fail(new Error("Add an author or tick “Author unknown”"));
    setSaving(true);
    try {
      const res = await api.books.create(toPayload(form, "create", settings?.time_zone));
      if (res.existing) toast.notify("That book is already in your library; opening it.");
      else toast.notify("Book added");
      setAdding(false);
      setForm(fromBook());
      invalidate("books");
      navigate(`/library/${res.id}`);
    } catch (e) {
      toast.fail(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <p>{total} {total === 1 ? "book" : "books"}{tab !== "all" ? ` · ${TABS.find((t) => t.id === tab)?.label}` : ""}{truncated ? " · showing the most recent 500" : ""}</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>+ Add book</button>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="spread" style={{ marginBottom: "1rem" }}>
        <input type="search" placeholder="Search title or author" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 340 }} aria-label="Search books" />
        <div className="row">
          <label className="small muted" htmlFor="sort">Sort</label>
          <select id="sort" value={sort} onChange={(e) => setSort(e.target.value)} style={{ width: "auto" }}>
            <option value="updated">Recently updated</option>
            <option value="created">Recently added</option>
            <option value="finished">Finish date</option>
            <option value="started">Start date</option>
            <option value="rating">Rating</option>
            <option value="title">Title</option>
          </select>
          <div className="btn-group" role="group" aria-label="View">
            <button className={`btn sm ${view === "table" ? "on" : ""}`} onClick={() => setView("table")}>Table</button>
            <button className={`btn sm ${view === "covers" ? "on" : ""}`} onClick={() => setView("covers")}>Covers</button>
          </div>
        </div>
      </div>

      {books === null ? (
        <p className="muted">Loading…</p>
      ) : books.length === 0 ? (
        <Empty title={q ? "No matches" : tab === "want_to_read" ? "Your wishlist is empty" : "Nothing here yet"}>
          {!q && <button className="btn" style={{ marginTop: "0.75rem" }} onClick={() => setAdding(true)}>Add a book</button>}
        </Empty>
      ) : view === "table" ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th><th>Author</th><th>Status</th><th>Started</th><th>Finished</th><th className="num">Rating</th>
              </tr>
            </thead>
            <tbody>
              {books.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link to={`/library/${b.id}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{b.title}</Link>
                    {b.topics.length > 0 && <div className="small muted">{b.topics.join(" · ")}</div>}
                  </td>
                  <td>{authorsText(b.authors, b.author_unknown)}</td>
                  <td><StatusBadge status={b.library_status} /></td>
                  <td className="small">{fmtDate(b.started_on)}</td>
                  <td className="small">{fmtDate(b.finished_on)}</td>
                  <td className="num">{fmtRating(b.rating)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid-covers">
          {books.map((b) => (
            <Link key={b.id} to={`/library/${b.id}`} className="cover-tile">
              <div className="cover">
                {b.cover_url ? <img src={b.cover_url} alt="" loading="lazy" /> : <span className="placeholder">{b.title}</span>}
              </div>
              <span className="t">{b.title}</span>
              <span className="a">{authorsText(b.authors, b.author_unknown)}</span>
              <span className="row small"><StatusBadge status={b.library_status} />{b.rating !== null && b.rating !== undefined && <span className="muted">{fmtRating(b.rating)}</span>}</span>
            </Link>
          ))}
        </div>
      )}

      <Modal open={adding} title="Add a book" onClose={() => setAdding(false)}
        footer={<><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary" disabled={saving} onClick={() => void submit()}>{saving ? "Saving…" : "Add book"}</button></>}>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <BookForm values={form} onChange={setForm} mode="create" timeZone={settings?.time_zone} />
          <button type="submit" className="sr-only">Save</button>
        </form>
      </Modal>
    </>
  );
}

export { LIBRARY_STATUS_LABEL };
