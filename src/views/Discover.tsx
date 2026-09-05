import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Batch, Horizon, RecommendationEntry, Shelf } from "../lib/types";
import { fmtDate, fmtDateTime, fmtMinutes, hostOf } from "../lib/format";
import { useRealtime } from "../lib/useRealtime";
import { useToast } from "../components/Toast";
import { AccessBadge, Badge, Empty, Modal } from "../components/ui";
import { HORIZON_LABELS, TARGET_COUNTS } from "@shared/periods";

const LENGTH_NOTE: Record<Horizon, string> = {
  daily: "Usually 5–15 minutes each; about an hour in total.",
  weekly: "Usually 20–60 minutes each; explanation and synthesis.",
  monthly: "Substantial essays, reports, or papers; depth over breadth.",
  yearly: "Work with plausible enduring significance.",
  decade: "Foundational work with demonstrated influence.",
};

const FEEDBACK_ACTIONS: { id: string; label: string }[] = [
  { id: "more_like_this", label: "More like this" },
  { id: "less_like_this", label: "Less like this" },
  { id: "already_know", label: "Already know this" },
  { id: "too_superficial", label: "Too superficial" },
  { id: "too_technical", label: "Too technical" },
  { id: "too_long", label: "Too long" },
  { id: "wrong_topic", label: "Wrong topic" },
  { id: "unreliable_source", label: "Unreliable source" },
  { id: "cannot_access", label: "Cannot access" },
];

export function Discover() {
  const toast = useToast();
  const [shelves, setShelves] = useState<Shelf[] | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<RecommendationEntry | null>(null);
  const [fbAction, setFbAction] = useState("more_like_this");
  const [fbScope, setFbScope] = useState("item");
  const [fbText, setFbText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setShelves((await api.recommendations.all()).shelves);
    } catch (e) {
      toast.fail(e);
    }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  const tables = useMemo(() => ["recommendation_batches", "generation_jobs"], []);
  useRealtime(tables, load, 20000);

  const anyBatch = shelves?.some((s) => s.batch) ?? false;
  const anyJob = shelves?.some((s) => s.activeJob) ?? false;

  const generate = async (kind: string, horizon?: Horizon) => {
    setBusy(true);
    try {
      const res = await api.jobs.create({ kind, horizon });
      toast.notify(res.jobs.some((j) => (j as { existing?: boolean }).existing) ? "A job for this period is already queued." : "Generation queued.");
      res.warnings.forEach((w) => toast.notify(w));
      await load();
    } catch (e) {
      toast.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const entryAction = async (e: RecommendationEntry, state: string, done: string) => {
    setBusy(true);
    try {
      await api.recommendations.patchEntry(e.id, state);
      toast.notify(done);
      await load();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  };

  const sendFeedback = async () => {
    if (!feedbackFor) return;
    setBusy(true);
    try {
      await api.feedback.create({ reading_id: feedbackFor.reading.id, recommendation_entry_id: feedbackFor.id, action: fbAction, scope: fbAction === "less_like_this" ? fbScope : "item", text: fbText || undefined });
      toast.notify("Feedback saved. It will shape the next search.");
      setFeedbackFor(null);
      setFbText("");
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
          <h1>Discover</h1>
          <p>Five shelves, each drawn only from the immediately preceding period. Recommendations are choices, not assignments.</p>
        </div>
        {shelves && !anyBatch && (
          <button className="btn primary" disabled={busy || anyJob} onClick={() => void generate("initial")}>{anyJob ? "Generating…" : "Generate first editions"}</button>
        )}
      </div>

      {shelves === null ? <p className="muted">Loading…</p> : shelves.map((s) => <ShelfView key={s.horizon} shelf={s} busy={busy}
        onGenerate={(kind) => void generate(kind, s.horizon)}
        onEntry={entryAction}
        onFeedback={(e) => { setFeedbackFor(e); setFbAction("more_like_this"); setFbScope("item"); setFbText(""); }} />)}

      <Modal open={feedbackFor !== null} title="Feedback" onClose={() => setFeedbackFor(null)}
        footer={<><button className="btn" onClick={() => setFeedbackFor(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void sendFeedback()}>Save feedback</button></>}>
        {feedbackFor && (
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>{feedbackFor.reading.title}</p>
            <div className="chips">
              {FEEDBACK_ACTIONS.map((a) => (
                <button key={a.id} type="button" className={`btn sm ${fbAction === a.id ? "primary" : ""}`} onClick={() => setFbAction(a.id)}>{a.label}</button>
              ))}
            </div>
            {fbAction === "less_like_this" && (
              <div className="field">
                <label htmlFor="fb-scope">Less of…</label>
                <select id="fb-scope" value={fbScope} onChange={(e) => setFbScope(e.target.value)}>
                  <option value="item">Just this item</option><option value="topic">This topic</option><option value="author">This author</option><option value="publisher">This publisher</option>
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="fb-text">In your own words (optional)</label>
              <textarea id="fb-text" value={fbText} onChange={(e) => setFbText(e.target.value)} placeholder="e.g. Good topic, but I wanted the primary source." />
            </div>
            <p className="hint" style={{ margin: 0 }}>Feedback is stored, editable, and removable from Preferences. One poor article never blocks a whole field.</p>
          </div>
        )}
      </Modal>
    </>
  );
}

function ShelfView({ shelf, busy, onGenerate, onEntry, onFeedback }: {
  shelf: Shelf; busy: boolean; onGenerate: (kind: string) => void;
  onEntry: (e: RecommendationEntry, state: string, done: string) => Promise<void>;
  onFeedback: (e: RecommendationEntry) => void;
}) {
  const [archive, setArchive] = useState<Batch[] | null>(null);
  const b = shelf.batch;
  const active = shelf.entries.filter((e) => e.state !== "dismissed");
  const loadArchive = async () => {
    if (archive) return;
    try { setArchive((await api.recommendations.archive(shelf.horizon)).items); } catch { setArchive([]); }
  };
  return (
    <section className="section">
      <div className="shelf-head">
        <div>
          <h2 style={{ marginBottom: 0 }}>{HORIZON_LABELS[shelf.horizon]}</h2>
          <div className="period">Published {shelf.window.label}<span className="muted small"> · {shelf.window.timeZone}</span></div>
        </div>
        <div className="shelf-status">
          <span>{b ? `${active.length} of ${shelf.targetCount}` : `0 of ${TARGET_COUNTS[shelf.horizon]}`}</span>
          {b?.published_at && <span>Updated {fmtDateTime(b.published_at)}{b.version > 1 ? ` · v${b.version}` : ""}</span>}
          {shelf.activeJob && <Badge tone="blue">{shelf.activeJob.status === "running" ? `Generating: ${shelf.activeJob.stage}` : "Queued"}</Badge>}
          {b?.status === "failed" && <Badge tone="red">Last run failed</Badge>}
          {b?.status === "partial" && <Badge tone="amber">Partial</Badge>}
          {b && <button className="btn sm ghost" disabled={busy || Boolean(shelf.activeJob)} onClick={() => onGenerate("alternatives")}>Find alternatives</button>}
          {b && active.length < shelf.targetCount && <button className="btn sm ghost" disabled={busy || Boolean(shelf.activeJob)} onClick={() => onGenerate("fill_missing")}>Fill missing slots</button>}
        </div>
      </div>
      <p className="small muted" style={{ marginTop: "-0.4rem" }}>{LENGTH_NOTE[shelf.horizon]}</p>

      {!b ? (
        <Empty title={shelf.activeJob ? "Generation in progress" : "No edition for this period yet"}>
          {shelf.activeJob ? "This shelf fills in when the job completes." : "Generation runs on the backend once a model provider and budget are configured (Phase 2)."}
        </Empty>
      ) : active.length === 0 ? (
        <Empty title="No verified selections">{b.status_reason ?? "Fewer than the target passed the date and access checks."}</Empty>
      ) : (
        <>
          {b.status_reason && <div className="notice small" style={{ marginBottom: "0.75rem" }}>{b.status_reason}</div>}
          <div className="grid">
            {active.map((e) => <EntryCard key={e.id} entry={e} busy={busy} onEntry={onEntry} onFeedback={onFeedback} />)}
          </div>
        </>
      )}

      <details className="archive" style={{ marginTop: "0.75rem" }} onToggle={(ev) => { if ((ev.target as HTMLDetailsElement).open) void loadArchive(); }}>
        <summary>Archived editions</summary>
        {archive === null ? <p className="small muted">Loading…</p> : archive.length === 0 ? <p className="small muted">No earlier editions.</p> : (
          <ul className="timeline small">
            {archive.map((a) => (
              <li key={a.id}>
                <span>{a.window_label}{a.version > 1 ? ` · v${a.version}` : ""}<span className="muted"> · {a.time_zone}</span></span>
                <span className="muted">{a.status}{a.published_at ? ` · ${fmtDateTime(a.published_at)}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}

function EntryCard({ entry, busy, onEntry, onFeedback }: {
  entry: RecommendationEntry; busy: boolean;
  onEntry: (e: RecommendationEntry, state: string, done: string) => Promise<void>;
  onFeedback: (e: RecommendationEntry) => void;
}) {
  const r = entry.reading;
  return (
    <article className="card rec-card">
      <div className="row">
        {entry.is_surprise && <Badge tone="accent">Outside your usual reading</Badge>}
        {entry.previously_suggested && <Badge>Previously suggested</Badge>}
        {entry.state === "read" && <Badge tone="green">Read</Badge>}
        {entry.state === "saved" && <Badge tone="blue">Saved</Badge>}
      </div>
      <div className="title">
        {r.canonical_url ? <a href={r.canonical_url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>{r.title}</a> : r.title}
      </div>
      <div className="meta">
        {r.authors.length > 0 && <span>{r.authors.join(", ")}</span>}
        <span>{r.publisher ?? hostOf(r.canonical_url)}</span>
        <span>{fmtDate(r.published_on, r.published_precision)}{r.published_precision !== "day" ? ` (${r.published_precision})` : ""}</span>
        {r.duration_minutes ? <span>{fmtMinutes(r.duration_minutes)}</span> : null}
      </div>
      <div className="row"><AccessBadge access={r.access_class} />{entry.evidence_depth !== "full_text" && <Badge tone="amber">Assessed from {entry.evidence_depth.replace("_", " ")}</Badge>}</div>
      {r.topics.length > 0 && <div className="chips">{r.topics.map((t) => <span key={t} className="chip">{t}</span>)}</div>}
      {entry.why_matters && <div className="why"><b>Why this matters</b> · {entry.why_matters}</div>}
      {entry.why_fits && <div className="why"><b>Why this fits you</b> · {entry.why_fits}</div>}
      <div className="row" style={{ marginTop: "auto" }}>
        {r.canonical_url && <a className="btn sm" href={r.canonical_url} target="_blank" rel="noopener noreferrer">Open original ↗</a>}
        {entry.state !== "saved" && entry.state !== "read" && <button className="btn sm" disabled={busy} onClick={() => void onEntry(entry, "saved", "Saved to your queue")}>Save</button>}
        {entry.state !== "read" && <button className="btn sm" disabled={busy} onClick={() => void onEntry(entry, "read", "Marked read")}>Mark read</button>}
        <button className="btn sm ghost" onClick={() => onFeedback(entry)}>Feedback</button>
        <button className="btn sm ghost" disabled={busy} onClick={() => void onEntry(entry, "dismissed", "Dismissed")}>Dismiss</button>
      </div>
    </article>
  );
}
