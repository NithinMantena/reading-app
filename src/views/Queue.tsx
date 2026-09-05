import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import type { QueueStatus, Reading } from "../lib/types";
import { fmtDate, fmtMinutes, hostOf } from "../lib/format";
import { useRealtime } from "../lib/useRealtime";
import { useToast } from "../components/Toast";
import { AccessBadge, Badge, ChipsInput, Empty, Modal, QueueBadge, RatingInput } from "../components/ui";

type Tab = "active" | QueueStatus;
const TABS: { id: Tab; label: string }[] = [
  { id: "active", label: "Queue" },
  { id: "saved", label: "Saved" },
  { id: "reading", label: "Reading" },
  { id: "finished", label: "Finished" },
  { id: "archived", label: "Archived" },
];

export function Queue() {
  const { id: focusId } = useParams();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("active");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Reading[] | null>(null);
  const [input, setInput] = useState("");
  const [inputNotes, setInputNotes] = useState("");
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<Reading | null>(null);
  const [rateItem, setRateItem] = useState<Reading | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [rateText, setRateText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.readings.list({ q: q || undefined, status: tab === "active" ? undefined : tab, limit: 500 });
      setItems(res.items);
    } catch (e) {
      toast.fail(e);
    }
  }, [q, tab, toast]);
  useEffect(() => {
    const t = window.setTimeout(() => void load(), q ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [load, q]);
  const tables = useMemo(() => ["reading_items"], []);
  useRealtime(tables, load);

  useEffect(() => {
    if (focusId && items) {
      const it = items.find((x) => x.id === focusId);
      if (it) document.getElementById(`reading-${it.id}`)?.scrollIntoView({ block: "center" });
    }
  }, [focusId, items]);

  const add = async () => {
    const v = input.trim();
    if (!v) return;
    setAdding(true);
    try {
      const isUrl = /^(https?:\/\/)?[^\s]+\.[a-z]{2,}(\/\S*)?$/i.test(v);
      const res = await api.readings.create(isUrl ? { url: v, notes: inputNotes || undefined } : { title: v, notes: inputNotes || undefined });
      toast.notify(res.existing ? "Already saved. Opening the existing item." : `Saved: ${res.title}`);
      setInput("");
      setInputNotes("");
      await load();
      if (res.existing) setEdit(res);
    } catch (e) {
      toast.fail(e);
    } finally {
      setAdding(false);
    }
  };

  const patch = async (r: Reading, body: Record<string, unknown>, done?: string) => {
    setBusy(true);
    try {
      await api.readings.patch(r.id, { ...body, version: r.version });
      if (done) toast.notify(done);
      await load();
    } catch (e) {
      toast.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!edit) return;
    await patch(edit, {
      title: edit.title, authors: edit.authors, publisher: edit.publisher, published_on: edit.published_on,
      published_precision: edit.published_precision, item_type: edit.item_type, duration_minutes: edit.duration_minutes,
      topics: edit.topics, notes: edit.notes, access_class: edit.access_class,
    }, "Saved");
    setEdit(null);
  };

  const submitRating = async () => {
    if (!rateItem || rating === null) return;
    setBusy(true);
    try {
      await api.feedback.create({ reading_id: rateItem.id, action: "quality_rating", quality_rating: rating, text: rateText || undefined });
      toast.notify("Reading quality recorded");
      setRateItem(null);
    } catch (e) {
      toast.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reading queue</h1>
          <p>Articles, papers, essays, and reports you chose to keep. Only explicitly saved items live here.</p>
        </div>
      </div>

      <form className="card" onSubmit={(e) => { e.preventDefault(); void add(); }} style={{ marginBottom: "1.25rem" }}>
        <div className="form-grid">
          <div className="field wide">
            <label htmlFor="q-add">Paste a URL or type a title</label>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input id="q-add" type="text" value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://… or “Title of a reading”" />
              <button className="btn primary" type="submit" disabled={adding || !input.trim()}>{adding ? "Saving…" : "Save"}</button>
            </div>
            <span className="hint">URLs are enriched with title, author, publisher, and date when the page allows it. Anything can be corrected afterwards.</span>
          </div>
          <div className="field wide">
            <label htmlFor="q-notes">Note (optional)</label>
            <input id="q-notes" type="text" value={inputNotes} onChange={(e) => setInputNotes(e.target.value)} placeholder="Why you saved it, who sent it…" />
          </div>
        </div>
      </form>

      <div className="tabs" role="tablist">
        {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      <input type="search" placeholder="Search title, publisher, or URL" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 340, marginBottom: "1rem" }} aria-label="Search readings" />

      {items === null ? <p className="muted">Loading…</p> : items.length === 0 ? (
        <Empty title="Nothing saved here">Save a URL above, or save a recommendation from Discover.</Empty>
      ) : (
        <div className="stack">
          {items.map((r) => (
            <article key={r.id} id={`reading-${r.id}`} className="card rec-card" style={focusId === r.id ? { outline: "2px solid var(--accent-2)" } : undefined}>
              <div className="spread" style={{ alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="title">
                    {r.canonical_url ? <a href={r.canonical_url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>{r.title}</a> : r.title}
                  </div>
                  <div className="meta">
                    {r.authors.length > 0 && <span>{r.authors.join(", ")}</span>}
                    <span>{r.publisher ?? hostOf(r.canonical_url)}</span>
                    {r.published_on && <span>{fmtDate(r.published_on, r.published_precision)}{r.published_precision !== "day" && r.published_precision !== "unknown" ? ` (${r.published_precision} precision)` : ""}</span>}
                    {r.duration_minutes ? <span>{fmtMinutes(r.duration_minutes)}</span> : null}
                    <span className="muted">{r.item_type}</span>
                  </div>
                </div>
                <div className="row">
                  <QueueBadge status={r.queue_status} />
                  <AccessBadge access={r.access_class} />
                  {r.enrichment_status === "pending" && <Badge tone="amber">Enriching…</Badge>}
                  {r.enrichment_status === "failed" && <Badge tone="amber">Metadata lookup failed</Badge>}
                </div>
              </div>
              {r.description && <p className="small muted" style={{ margin: 0 }}>{r.description}</p>}
              {r.notes && <div className="why"><b>Note</b> · {r.notes}</div>}
              {r.topics.length > 0 && <div className="chips">{r.topics.map((t) => <span key={t} className="chip">{t}</span>)}</div>}
              <div className="row">
                {r.canonical_url && <a className="btn sm" href={r.canonical_url} target="_blank" rel="noopener noreferrer">Open original ↗</a>}
                {r.queue_status !== "reading" && r.queue_status !== "finished" && <button className="btn sm" disabled={busy} onClick={() => void patch(r, { queue_status: "reading" })}>Start</button>}
                {r.queue_status !== "finished" && <button className="btn sm" disabled={busy} onClick={() => void patch(r, { queue_status: "finished" }, "Marked finished")}>Mark finished</button>}
                {r.queue_status === "finished" && <button className="btn sm" onClick={() => { setRateItem(r); setRating(null); setRateText(""); }}>Rate reading quality</button>}
                <button className="btn sm ghost" onClick={() => setEdit({ ...r })}>Edit</button>
                {r.queue_status === "archived"
                  ? <button className="btn sm ghost" disabled={busy} onClick={() => void patch(r, { archived: false }, "Restored")}>Restore</button>
                  : <button className="btn sm ghost" disabled={busy} onClick={() => void patch(r, { archived: true }, "Archived")}>Archive</button>}
              </div>
            </article>
          ))}
        </div>
      )}

      <Modal open={edit !== null} title="Edit reading" onClose={() => setEdit(null)}
        footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void saveEdit()}>Save</button></>}>
        {edit && (
          <div className="form-grid">
            <div className="field wide"><label htmlFor="re-title">Title</label><input id="re-title" type="text" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></div>
            <div className="field"><label htmlFor="re-authors">Authors</label><input id="re-authors" type="text" value={edit.authors.join(", ")} onChange={(e) => setEdit({ ...edit, authors: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></div>
            <div className="field"><label htmlFor="re-pub">Publisher</label><input id="re-pub" type="text" value={edit.publisher ?? ""} onChange={(e) => setEdit({ ...edit, publisher: e.target.value || null })} /></div>
            <div className="field"><label htmlFor="re-date">Published</label><input id="re-date" type="date" value={edit.published_on ?? ""} onChange={(e) => setEdit({ ...edit, published_on: e.target.value || null, published_precision: e.target.value ? edit.published_precision === "unknown" ? "day" : edit.published_precision : "unknown" })} /></div>
            <div className="field"><label htmlFor="re-prec">Date precision</label>
              <select id="re-prec" value={edit.published_precision} onChange={(e) => setEdit({ ...edit, published_precision: e.target.value as Reading["published_precision"] })}>
                <option value="day">Day</option><option value="month">Month</option><option value="year">Year</option><option value="unknown">Unknown</option>
              </select></div>
            <div className="field"><label htmlFor="re-type">Type</label>
              <select id="re-type" value={edit.item_type} onChange={(e) => setEdit({ ...edit, item_type: e.target.value })}>
                {["article", "essay", "paper", "report", "newsletter", "document", "other"].map((t) => <option key={t} value={t}>{t}</option>)}
              </select></div>
            <div className="field"><label htmlFor="re-dur">Estimated minutes</label><input id="re-dur" type="number" min={0} value={edit.duration_minutes ?? ""} onChange={(e) => setEdit({ ...edit, duration_minutes: e.target.value ? Number(e.target.value) : null })} /></div>
            <div className="field"><label htmlFor="re-access">Access</label>
              <select id="re-access" value={edit.access_class} onChange={(e) => setEdit({ ...edit, access_class: e.target.value as Reading["access_class"] })}>
                <option value="free_full_text">Free full text</option><option value="open_copy">Legitimate open copy</option><option value="nyt_subscription">NYT subscription</option>
                <option value="preview_only">Preview / abstract only</option><option value="paywall">Other paywall</option><option value="unknown">Unknown</option>
              </select></div>
            <div className="field wide"><span className="label">Topics</span><ChipsInput values={edit.topics} onChange={(t) => setEdit({ ...edit, topics: t })} /></div>
            <div className="field wide"><label htmlFor="re-notes">Notes</label><textarea id="re-notes" value={edit.notes ?? ""} onChange={(e) => setEdit({ ...edit, notes: e.target.value || null })} /></div>
            {edit.canonical_url && <div className="small muted wide">URL: <span className="mono">{edit.canonical_url}</span></div>}
          </div>
        )}
      </Modal>

      <Modal open={rateItem !== null} title="Reading quality" onClose={() => setRateItem(null)}
        footer={<><button className="btn" onClick={() => setRateItem(null)}>Cancel</button><button className="btn primary" disabled={busy || rating === null} onClick={() => void submitRating()}>Save</button></>}>
        <p className="small muted">How good was this as a reading? This is separate from book ratings and from relevance feedback.</p>
        <RatingInput value={rating} onChange={setRating} />
        <div className="field" style={{ marginTop: "0.75rem" }}>
          <label htmlFor="rq-text">Anything to remember</label>
          <textarea id="rq-text" value={rateText} onChange={(e) => setRateText(e.target.value)} />
        </div>
      </Modal>
    </>
  );
}
