import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import type { Book, ReadingSession, SessionStatus } from "../lib/types";
import { authorsText, fmtDate, fmtRating, todayLocal } from "../lib/format";
import { useRealtime } from "../lib/useRealtime";
import { useAuth } from "../auth/AuthProvider";
import { useToast } from "../components/Toast";
import { Badge, Modal, RatingInput, StatusBadge } from "../components/ui";
import { BookForm, fromBook, toPayload, type BookFormValues } from "../components/BookForm";

export function BookDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { settings } = useAuth();
  const [book, setBook] = useState<Book | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<BookFormValues>(fromBook());
  const [finishing, setFinishing] = useState(false);
  const [finishDate, setFinishDate] = useState<string | null>(null);
  const [finishRating, setFinishRating] = useState<number | null>(null);
  const [finishNotes, setFinishNotes] = useState("");
  const [sessionEdit, setSessionEdit] = useState<ReadingSession | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setBook(await api.books.get(id));
    } catch (e) {
      toast.fail(e);
      navigate("/library");
    }
  }, [id, navigate, toast]);
  useEffect(() => { void load(); }, [load]);
  const tables = useMemo(() => ["books", "reading_sessions"], []);
  useRealtime(tables, load);

  if (!book) return <p className="muted">Loading…</p>;
  const latest = book.sessions?.[0] ?? null;

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast.notify(done);
      await load();
    } catch (e) {
      toast.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (library_status: string, extra: Record<string, unknown> = {}) =>
    run(() => api.books.patch(book.id, { library_status, version: book.version, ...extra }));

  const openFinish = () => {
    setFinishDate(todayLocal(settings?.time_zone));
    setFinishRating(latest?.rating ?? null);
    setFinishNotes(latest?.notes ?? "");
    setFinishing(true);
  };

  const confirmFinish = async () => {
    await setStatus("finished", { finished_on: finishDate, rating: finishRating, session_notes: finishNotes || null });
    setFinishing(false);
  };

  const saveEdit = async () => {
    await run(() => api.books.patch(book.id, { ...toPayload(form, "edit"), version: book.version }), "Saved");
    setEditing(false);
  };

  const saveSession = async () => {
    if (!sessionEdit) return;
    await run(() => api.books.patchSession(sessionEdit.id, {
      started_on: sessionEdit.started_on, finished_on: sessionEdit.finished_on, status: sessionEdit.status,
      rating: sessionEdit.rating, notes: sessionEdit.notes, version: sessionEdit.version,
    }), "Session updated");
    setSessionEdit(null);
  };

  const permanentlyDelete = async () => {
    if (!window.confirm(`Permanently delete “${book.title}” and its reading history? Archive is reversible; this is not.`)) return;
    await run(() => api.books.remove(book.id), "Deleted");
    navigate("/library");
  };

  return (
    <>
      <p className="small"><Link to="/library">← Library</Link></p>
      <div className="two-col">
        <div>
          <div className="cover" style={{ maxWidth: 220 }}>
            {book.cover_url ? <img src={book.cover_url} alt="" /> : <span className="placeholder">{book.title}</span>}
          </div>
          {latest?.rating !== null && latest?.rating !== undefined && (
            <div style={{ marginTop: "1rem" }}>
              <div className="rating-big">{fmtRating(latest.rating)}<span className="muted" style={{ fontSize: "1rem" }}> / 10</span></div>
              <div className="small muted">Latest rating</div>
            </div>
          )}
        </div>
        <div className="stack" style={{ gap: "1.25rem" }}>
          <div>
            <div className="row" style={{ marginBottom: "0.4rem" }}>
              <StatusBadge status={book.library_status} />
              {book.archived_at && <Badge tone="amber">Archived</Badge>}
              {(book.sessions?.length ?? 0) > 1 && <Badge>Read {book.sessions!.length}×</Badge>}
            </div>
            <h1 style={{ marginBottom: "0.2rem" }}>{book.title}</h1>
            <p className="muted" style={{ fontSize: "1.05rem" }}>{authorsText(book.authors, book.author_unknown)}{book.edition ? ` · ${book.edition}` : ""}</p>
            {book.topics.length > 0 && <div className="chips">{book.topics.map((t) => <span className="chip" key={t}>{t}</span>)}</div>}
          </div>

          <div className="row">
            {book.library_status === "want_to_read" && <button className="btn primary" disabled={busy} onClick={() => void setStatus("reading", { started_on: todayLocal(settings?.time_zone) })}>Start reading</button>}
            {book.library_status === "reading" && <button className="btn primary" disabled={busy} onClick={openFinish}>Mark finished</button>}
            {book.library_status === "reading" && <button className="btn" disabled={busy} onClick={() => void setStatus("stopped")}>Stop</button>}
            {book.library_status === "stopped" && <button className="btn" disabled={busy} onClick={() => void setStatus("reading")}>Resume</button>}
            {book.library_status === "finished" && (
              <button className="btn" disabled={busy} onClick={() => void run(() => api.books.createSession(book.id, { started_on: todayLocal(settings?.time_zone) }), "New reading session started")}>Read again</button>
            )}
            {book.library_status !== "want_to_read" && <button className="btn ghost" disabled={busy} onClick={() => void setStatus("want_to_read")}>Back to want to read</button>}
            <button className="btn" onClick={() => { setForm(fromBook(book)); setEditing(true); }}>Edit</button>
          </div>

          {(book.why_read || book.recommended_by) && (
            <div className="card">
              {book.why_read && <><div className="label">Why I want to read this</div><p style={{ whiteSpace: "pre-wrap" }}>{book.why_read}</p></>}
              {book.recommended_by && <div className="small muted">Recommended by {book.recommended_by}</div>}
            </div>
          )}
          {book.description && <div><div className="label">Description</div><p style={{ whiteSpace: "pre-wrap" }}>{book.description}</p></div>}
          {book.notes && <div><div className="label">Notes</div><p style={{ whiteSpace: "pre-wrap" }}>{book.notes}</p></div>}

          <div>
            <div className="section-head"><h2>Reading history</h2></div>
            {book.sessions && book.sessions.length > 0 ? (
              <ul className="timeline">
                {book.sessions.map((s) => (
                  <li key={s.id}>
                    <div>
                      <div className="row">
                        <StatusBadge status={s.status} />
                        <span>{fmtDate(s.started_on)} → {s.status === "finished" ? fmtDate(s.finished_on) : s.status === "stopped" ? "stopped" : "…"}</span>
                        <span className="muted">{fmtRating(s.rating)}</span>
                      </div>
                      {s.notes && <p className="small" style={{ margin: "0.3rem 0 0", whiteSpace: "pre-wrap" }}><b>What stayed with me:</b> {s.notes}</p>}
                    </div>
                    <button className="btn ghost sm" onClick={() => setSessionEdit({ ...s })}>Edit</button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No reading sessions yet. Historical dates can be left blank; nothing is ever guessed.</p>
            )}
          </div>

          <hr className="divider" />
          <div className="row">
            {book.archived_at ? (
              <button className="btn" disabled={busy} onClick={() => void run(() => api.books.patch(book.id, { archived: false, version: book.version }), "Restored")}>Restore</button>
            ) : (
              <button className="btn" disabled={busy} onClick={() => void run(() => api.books.patch(book.id, { archived: true, version: book.version }), "Archived")}>Archive</button>
            )}
            <button className="btn danger" disabled={busy} onClick={() => void permanentlyDelete()}>Delete permanently</button>
            <span className="small muted">Archive is the default removal action and is reversible.</span>
          </div>
          <div className="small muted">Added {fmtDate(book.created_at)} · ISBN {book.isbn ?? "—"} · <span className="mono">{book.id}</span></div>
        </div>
      </div>

      <Modal open={editing} title="Edit book" onClose={() => setEditing(false)}
        footer={<><button className="btn" onClick={() => setEditing(false)}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void saveEdit()}>Save</button></>}>
        <BookForm values={form} onChange={setForm} mode="edit" />
      </Modal>

      <Modal open={finishing} title="Mark finished" onClose={() => setFinishing(false)}
        footer={<><button className="btn" onClick={() => setFinishing(false)}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void confirmFinish()}>Finish</button></>}>
        <div className="stack">
          <div className="field">
            <label htmlFor="fin-date">Finish date</label>
            <input id="fin-date" type="date" value={finishDate ?? ""} onChange={(e) => setFinishDate(e.target.value || null)} />
            <span className="hint">Proposed: today. <button type="button" className="btn ghost sm" onClick={() => setFinishDate(null)}>Date unknown</button></span>
          </div>
          <div className="field">
            <label htmlFor="fin-rating">Rating</label>
            <RatingInput id="fin-rating" value={finishRating} onChange={setFinishRating} />
          </div>
          <div className="field">
            <label htmlFor="fin-notes">What stayed with me</label>
            <textarea id="fin-notes" value={finishNotes} onChange={(e) => setFinishNotes(e.target.value)} />
          </div>
        </div>
      </Modal>

      <Modal open={sessionEdit !== null} title="Edit reading session" onClose={() => setSessionEdit(null)}
        footer={<><button className="btn" onClick={() => setSessionEdit(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void saveSession()}>Save</button></>}>
        {sessionEdit && (
          <div className="form-grid">
            <div className="field">
              <label htmlFor="se-status">Status</label>
              <select id="se-status" value={sessionEdit.status} onChange={(e) => setSessionEdit({ ...sessionEdit, status: e.target.value as SessionStatus })}>
                <option value="reading">Reading</option><option value="finished">Finished</option><option value="stopped">Stopped</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="se-start">Started</label>
              <input id="se-start" type="date" value={sessionEdit.started_on ?? ""} onChange={(e) => setSessionEdit({ ...sessionEdit, started_on: e.target.value || null })} />
            </div>
            <div className="field">
              <label htmlFor="se-finish">Finished</label>
              <input id="se-finish" type="date" value={sessionEdit.finished_on ?? ""} onChange={(e) => setSessionEdit({ ...sessionEdit, finished_on: e.target.value || null })} />
            </div>
            <div className="field wide">
              <label htmlFor="se-rating">Rating</label>
              <RatingInput id="se-rating" value={sessionEdit.rating} onChange={(r) => setSessionEdit({ ...sessionEdit, rating: r })} />
            </div>
            <div className="field wide">
              <label htmlFor="se-notes">What stayed with me</label>
              <textarea id="se-notes" value={sessionEdit.notes ?? ""} onChange={(e) => setSessionEdit({ ...sessionEdit, notes: e.target.value || null })} />
            </div>
            {sessionEdit.started_on && sessionEdit.finished_on && sessionEdit.finished_on < sessionEdit.started_on && (
              <div className="notice error wide">Finish date must not precede start date.</div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
