import { useEffect, useRef, useState } from "react";
import { api, type CsvImportReport, type ImportReport } from "../lib/api";
import { fillMissingCovers, type CoverProgress } from "../lib/covers";
import type { IntegrationToken, Settings } from "../lib/types";
import { fmtDateTime } from "../lib/format";
import { useAuth } from "../auth/AuthProvider";
import { useToast } from "../components/Toast";
import { Badge, Modal } from "../components/ui";
import { API_BASE } from "../lib/supabase";
import { invalidate, useQuery } from "../lib/cache";
import { queries } from "../lib/queries";
import { ComparisonSection, ModelsSection } from "./ModelSettings";

export function Preferences() {
  const { settings, setSettings, refreshSettings } = useAuth();
  const toast = useToast();
  const [draft, setDraft] = useState<Settings | null>(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(settings), [settings]);

  const save = async () => {
    if (!draft || !settings) return;
    setSaving(true);
    try {
      const s = await api.preferences.patch({ ...draft, version: settings.version });
      setSettings(s);
      toast.notify("Preferences saved");
    } catch (e) {
      toast.fail(e);
      if ((e as { status?: number }).status === 409) await refreshSettings();
    } finally {
      setSaving(false);
    }
  };

  if (!draft) return <p className="muted">Loading…</p>;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft({ ...draft, [k]: v });
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  return (
    <>
      <div className="page-head">
        <div><h1>Preferences</h1><p>Explicit settings outrank everything the app infers.</p></div>
        <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</button>
      </div>

      <div className="stack" style={{ gap: "1.25rem" }}>
        <section className="card">
          <h2>Time and language</h2>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="p-tz">Time zone</label>
              <input id="p-tz" type="text" value={draft.time_zone} onChange={(e) => set("time_zone", e.target.value)} list="tz-list" />
              <datalist id="tz-list">{(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []).map((z) => <option key={z} value={z} />)}</datalist>
              <span className="hint">Changes apply to future editions; historical windows keep their original zone.</span>
            </div>
            <div className="field">
              <label htmlFor="p-lang">Language</label>
              <input id="p-lang" type="text" value={draft.language} onChange={(e) => set("language", e.target.value)} />
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Interests</h2>
          <p className="small muted">Broad topics that seed discovery. Weight 1 is normal; 2 or 3 emphasises a topic.</p>
          <div className="stack">
            {draft.interests.map((it, i) => (
              <div key={i} className="row">
                <input type="text" value={it.topic} style={{ maxWidth: 320 }} aria-label="Topic" onChange={(e) => set("interests", draft.interests.map((x, j) => (j === i ? { ...x, topic: e.target.value } : x)))} />
                <select value={it.weight} aria-label="Weight" style={{ width: "auto" }} onChange={(e) => set("interests", draft.interests.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)))}>
                  <option value={0.5}>Light</option><option value={1}>Normal</option><option value={2}>Strong</option><option value={3}>Core</option>
                </select>
                <button className="btn ghost sm" aria-label="Remove" onClick={() => set("interests", draft.interests.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button className="btn sm" onClick={() => set("interests", [...draft.interests, { topic: "", weight: 1 }])}>+ Add interest</button>
          </div>
        </section>

        <section className="card">
          <h2>Exclusions</h2>
          <p className="small muted">Hard blocks. Exploration never overrides these.</p>
          <div className="stack">
            {draft.exclusions.map((ex, i) => (
              <div key={i} className="row">
                <select value={ex.kind} aria-label="Kind" style={{ width: "auto" }} onChange={(e) => set("exclusions", draft.exclusions.map((x, j) => (j === i ? { ...x, kind: e.target.value as Settings["exclusions"][number]["kind"] } : x)))}>
                  <option value="topic">Topic</option><option value="author">Author</option><option value="publisher">Publisher</option>
                </select>
                <input type="text" value={ex.value} style={{ maxWidth: 320 }} aria-label="Value" onChange={(e) => set("exclusions", draft.exclusions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <button className="btn ghost sm" aria-label="Remove" onClick={() => set("exclusions", draft.exclusions.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button className="btn sm" onClick={() => set("exclusions", [...draft.exclusions, { kind: "topic", value: "" }])}>+ Add exclusion</button>
          </div>
        </section>

        <section className="card">
          <h2>Reading lengths and access</h2>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="p-daily">Daily maximum (minutes per item)</label>
              <input id="p-daily" type="number" min={1} value={draft.length_preferences.daily_max_minutes ?? 20} onChange={(e) => set("length_preferences", { ...draft.length_preferences, daily_max_minutes: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label htmlFor="p-weekly">Weekly maximum (minutes per item)</label>
              <input id="p-weekly" type="number" min={1} value={draft.length_preferences.weekly_max_minutes ?? 60} onChange={(e) => set("length_preferences", { ...draft.length_preferences, weekly_max_minutes: Number(e.target.value) })} />
            </div>
            <div className="field wide">
              <label className="check">
                <input type="checkbox" checked={draft.access_exceptions.includes("nyt_subscription")} onChange={(e) => set("access_exceptions", e.target.checked ? ["nyt_subscription"] : [])} />
                I have a New York Times subscription (NYT articles are eligible and open on nytimes.com)
              </label>
              <span className="hint">Everything else must be free to read in full. No passwords are stored.</span>
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Trusted sources</h2>
          <p className="small muted">RSS or Atom feeds from publishers you trust. They join the free sources (OpenAlex, arXiv, Hacker News) and any search provider when retrieving candidates. Dates and access are still verified per item.</p>
          <div className="stack">
            {(draft.sources ?? []).map((s, i) => (
              <div key={i} className="row">
                <input type="url" value={s.url} placeholder="https://example.org/feed.xml" style={{ maxWidth: 420 }} aria-label="Feed URL" onChange={(e) => set("sources", (draft.sources ?? []).map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
                <input type="text" value={s.label ?? ""} placeholder="Label" style={{ maxWidth: 200 }} aria-label="Label" onChange={(e) => set("sources", (draft.sources ?? []).map((x, j) => (j === i ? { ...x, label: e.target.value || undefined } : x)))} />
                <button className="btn ghost sm" aria-label="Remove" onClick={() => set("sources", (draft.sources ?? []).filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button className="btn sm" onClick={() => set("sources", [...(draft.sources ?? []), { url: "" }])}>+ Add feed</button>
          </div>
        </section>

        <ModelsSection />

        <section className="card">
          <h2>Generation budget</h2>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="p-cap">Monthly spending cap (USD)</label>
              <input id="p-cap" type="number" min={0} step={1} value={draft.budget.monthly_cap_usd} onChange={(e) => set("budget", { ...draft.budget, monthly_cap_usd: Number(e.target.value) })} />
              <span className="hint">Generation stops when the cap is reached; the library and existing lists keep working. A cap of 0 keeps generation off.</span>
            </div>
          </div>
          <GenerationSection />
        </section>

        <ComparisonSection />
        <TokensSection />
        <DataSection />
        <FeedbackSection />
        <JobsSection />
      </div>
    </>
  );
}

function GenerationSection() {
  const { data: cfg, error } = useQuery(queries.generationConfig.key, queries.generationConfig.fetch);
  if (error && !cfg) return <p className="small" style={{ color: "var(--red)" }}>{error.message}</p>;
  if (!cfg) return <p className="small muted">Loading generation configuration…</p>;
  const price = (m: string) => {
    const p = cfg.prices[m];
    return p && typeof p === "object" ? `$${p.input}/M in · $${p.output}/M out` : "rate unknown; budgeted at Opus rates";
  };
  return (
    <div style={{ marginTop: "1rem" }}>
      <h3>Services and rates</h3>
      <div className="table-wrap">
        <table>
          <tbody>
            <tr><th>Model provider</th><td>{cfg.provider ?? <Badge tone="red">No API key (add one under AI models)</Badge>}</td></tr>
            <tr><th>Main model</th><td className="mono">{cfg.models.ranker} <span className="muted small">({price(cfg.models.ranker)})</span></td></tr>
            <tr><th>Helper model</th><td className="mono">{cfg.models.helper} <span className="muted small">({price(cfg.models.helper)})</span></td></tr>
            <tr><th>Access check</th><td className="mono">{cfg.access === "jev" ? `${cfg.models.classifier}, helper when unsure` : cfg.models.helper} {cfg.access === "jev" && <span className="muted small">({price(cfg.models.classifier)})</span>}</td></tr>
            <tr><th>Search</th><td>{cfg.search === "free-sources-only" ? "Free sources only" : cfg.search} <span className="muted small">· always: {cfg.freeSources.join(", ")}</span></td></tr>
            <tr><th>Estimated cost per run</th><td className="small">{Object.entries(cfg.estimatePerRunUsd).map(([h, v]) => `${h} ~$${v.toFixed(2)}`).join(" · ")}</td></tr>
            <tr><th>Spent this month</th><td>${cfg.monthlySpendUsd.toFixed(2)} of ${cfg.monthlyCapUsd.toFixed(2)} cap</td></tr>
            <tr><th>Scheduler</th><td className="small">
              {cfg.scheduler.error ? <span style={{ color: "var(--red)" }}>{cfg.scheduler.error}</span> : (cfg.scheduler.jobs ?? []).length === 0 ? "No cron jobs registered" : (cfg.scheduler.jobs ?? []).map((j) => (
                <div key={j.name}><span className="mono">{j.name}</span> ({j.schedule}) {j.active ? "" : "inactive"}{j.lastRun ? ` · last ${j.lastRun.status} ${fmtDateTime(j.lastRun.started)}` : " · not run yet"}</div>
              ))}
              {cfg.scheduler.workerRegistered === false && <div className="muted">Worker URL not registered yet; it registers on the first generation.</div>}
            </td></tr>
          </tbody>
        </table>
      </div>
      <p className="hint" style={{ marginTop: "0.5rem" }}>Daily and weekly editions target 07:00 in your time zone; monthly on the 1st, yearly on January 1, decade on January 1, 2030. Costs shown are provider list prices; each run records its actual usage.</p>
    </div>
  );
}

function TokensSection() {
  const toast = useToast();
  const { data, error, refresh } = useQuery(queries.tokens.key, queries.tokens.fetch);
  useEffect(() => { if (error) toast.fail(error); }, [error, toast]);
  const items = data?.items ?? [];
  const [created, setCreated] = useState<IntegrationToken | null>(null);
  const [name, setName] = useState("OpenClaw");
  const create = async () => {
    try {
      const t = await api.tokens.create({ name });
      setCreated(t);
      await refresh();
    } catch (e) { toast.fail(e); }
  };
  const revoke = async (id: string) => {
    if (!window.confirm("Revoke this token? The bot will lose access immediately.")) return;
    try { await api.tokens.revoke(id); toast.notify("Token revoked"); await refresh(); } catch (e) { toast.fail(e); }
  };
  return (
    <section className="card">
      <h2>OpenClaw integration</h2>
      <p className="small muted">Tokens let the local bot read and update this app through the API. Only a hash is stored here; the token itself lives in the bot's secret configuration. Scopes: read, library write, feedback write, preferences write, generation. Permanent deletion is never delegated.</p>
      <div className="row" style={{ marginBottom: "0.75rem" }}>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 240 }} aria-label="Token name" />
        <button className="btn" onClick={() => void create()}>Create token</button>
      </div>
      {items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td><td className="mono">{t.token_prefix}…</td><td className="small">{t.scopes.join(", ")}</td>
                  <td className="small">{fmtDateTime(t.last_used_at)}</td>
                  <td>{t.revoked_at ? <Badge tone="red">Revoked</Badge> : t.expires_at && new Date(t.expires_at) < new Date() ? <Badge tone="amber">Expired</Badge> : <Badge tone="green">Active</Badge>}</td>
                  <td>{!t.revoked_at && <button className="btn sm danger" onClick={() => void revoke(t.id)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={created !== null} title="Token created" onClose={() => setCreated(null)} footer={<button className="btn primary" onClick={() => setCreated(null)}>Done</button>}>
        {created && (
          <div className="stack">
            <div className="notice">Copy this token now. It will not be shown again.</div>
            <code className="block">{created.token}</code>
            <p className="small">Configure the bot once:</p>
            <code className="block">{`node bot/reading.mjs configure --url "${API_BASE}" --token "${created.token}"`}</code>
          </div>
        )}
      </Modal>
    </section>
  );
}

const FIELD_LABEL: Record<string, string> = {
  title: "Title", authors: "Authors", isbn: "ISBN", edition: "Edition", topics: "Topics", library_status: "Status",
  started_on: "Started", finished_on: "Finished", rating: "Rating", session_notes: "Session notes", notes: "Notes",
  why_read: "Why read", recommended_by: "Recommended by", archived: "Archived", cover_url: "Cover URL",
};

function showValue(v: unknown): string {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "—";
  const s = Array.isArray(v) ? v.join("; ") : typeof v === "boolean" ? (v ? "yes" : "no") : String(v).replace(/_/g, " ");
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

type Pending =
  | { kind: "json"; data: unknown; report: ImportReport }
  | { kind: "csv"; csv: string; name: string; report: CsvImportReport };

function DataSection() {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [covers, setCovers] = useState<CoverProgress | null>(null);

  const download = (name: string, content: string, type: string) => {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const exportJson = async () => {
    try { download(`reading-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await api.transfer.exportJson(), null, 2), "application/json"); } catch (e) { toast.fail(e); }
  };
  const exportCsv = async () => {
    try { download("books.csv", await api.transfer.exportBooksCsv(), "text/csv"); } catch (e) { toast.fail(e); }
  };
  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const text = await f.text();
      const looksJson = /\.json$/i.test(f.name) || /^\s*[{[]/.test(text);
      if (looksJson) {
        const data = JSON.parse(text);
        setPending({ kind: "json", data, report: await api.transfer.importPreview(data) });
      } else {
        setPending({ kind: "csv", csv: text, name: f.name, report: await api.transfer.csvPreview(text) });
      }
    } catch (e) { toast.fail(e, "Could not read that file"); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const refreshCovers = async () => {
    const fresh = await api.books.list({ limit: 500, sort: "updated" });
    const missing = fresh.items.filter((b) => !b.cover_url);
    if (!missing.length) return;
    const r = await fillMissingCovers(missing, setCovers);
    setCovers(null);
    invalidate("books");
    toast.notify(`Covers: found ${r.found} of ${r.total} missing`);
  };
  const commit = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === "json") {
        const r = await api.transfer.importCommit(pending.data);
        toast.notify(`Imported ${r.books.create} books, ${r.readings.create} readings, ${r.feedback.create} feedback events`);
        setPending(null);
      } else {
        const r = await api.transfer.csvCommit(pending.csv);
        const a = r.applied ?? { updated: 0, created: 0, duplicates: 0, failed: 0 };
        toast.notify(`Updated ${a.updated} books${a.created ? `, added ${a.created}` : ""}${a.failed ? `, ${a.failed} failed (see the list)` : ""}`);
        invalidate("books");
        if (a.failed) setPending({ ...pending, report: r });
        else setPending(null);
        if (a.updated || a.created) void refreshCovers();
      }
    } catch (e) { toast.fail(e); } finally { setBusy(false); }
  };

  const csvReport = pending?.kind === "csv" ? pending.report : null;
  const csvChanges = csvReport ? csvReport.updates.length + csvReport.creates.length : 0;
  return (
    <section className="card">
      <h2>Your data</h2>
      <p className="small muted">Exports contain books, sessions, readings, feedback, and preferences. They never include tokens.</p>
      <p className="small muted">To edit books in bulk: export the books CSV, change it in a spreadsheet (keep the id column), and upload it here. You'll see every change before anything is saved. Covers for new or changed ISBNs are fetched afterwards.</p>
      <div className="row">
        <button className="btn" onClick={() => void exportJson()}>Export everything (JSON)</button>
        <button className="btn" onClick={() => void exportCsv()}>Export books (CSV)</button>
        <label className="btn">
          {busy ? "Reading…" : "Upload JSON or books CSV…"}
          <input ref={fileRef} type="file" accept=".json,.csv,application/json,text/csv" className="sr-only" onChange={(e) => void pickFile(e.target.files?.[0])} />
        </label>
      </div>
      {covers && <p className="small muted" style={{ marginTop: "0.5rem" }}>Finding covers… {covers.done}/{covers.total} ({covers.found} found)</p>}

      <Modal open={pending?.kind === "json"} title="Import preview" onClose={() => setPending(null)}
        footer={<><button className="btn" onClick={() => setPending(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void commit()}>Import</button></>}>
        {pending?.kind === "json" && (
          <div className="stack small">
            <div>Books: create {pending.report.books.create}, skip {pending.report.books.skipDuplicate} duplicates, {pending.report.books.skipExistingId} already present</div>
            <div>Reading sessions: create {pending.report.reading_sessions.create}, skip {pending.report.reading_sessions.skipExistingId + pending.report.reading_sessions.skipMissingBook}</div>
            <div>Readings: create {pending.report.readings.create}, skip {pending.report.readings.skipDuplicate} duplicates, {pending.report.readings.skipExistingId} already present</div>
            <div>Feedback: create {pending.report.feedback.create}, skip {pending.report.feedback.skipExistingId}</div>
            <div>Preferences: {pending.report.preferences}</div>
            {pending.report.problems.length > 0 && <div className="notice">{pending.report.problems.slice(0, 10).join("; ")}{pending.report.problems.length > 10 ? "…" : ""}</div>}
            <p className="muted">Nothing existing is overwritten. Duplicate imports do not multiply records.</p>
          </div>
        )}
      </Modal>

      <Modal open={csvReport !== null} title={csvReport?.applied ? "Upload results" : `Changes in ${pending?.kind === "csv" ? pending.name : "file"}`} onClose={() => setPending(null)}
        footer={<>
          <button className="btn" onClick={() => setPending(null)}>{csvReport?.applied ? "Close" : "Cancel"}</button>
          {!csvReport?.applied && <button className="btn primary" disabled={busy || csvChanges === 0} onClick={() => void commit()}>{busy ? "Applying…" : `Apply ${csvChanges} change${csvChanges === 1 ? "" : "s"}`}</button>}
        </>}>
        {csvReport && (
          <div className="stack small">
            <div>{csvReport.rows} rows: {csvReport.updates.length} books change, {csvReport.creates.length} new, {csvReport.unchanged} unchanged.</div>
            {csvReport.applied && <div>Applied: {csvReport.applied.updated} updated, {csvReport.applied.created} added, {csvReport.applied.failed} failed.</div>}
            {csvReport.problems.length > 0 && (
              <div className="notice">
                <strong>Needs a look ({csvReport.problems.length})</strong>
                <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem" }}>{csvReport.problems.slice(0, 50).map((p, i) => <li key={i}>{p}</li>)}</ul>
              </div>
            )}
            {csvReport.updates.length > 0 && (
              <div className="table-wrap" style={{ maxHeight: 360, overflow: "auto" }}>
                <table>
                  <thead><tr><th>Book</th><th>Field</th><th>Now</th><th>After upload</th></tr></thead>
                  <tbody>
                    {csvReport.updates.flatMap((u) => u.changes.map((c, i) => (
                      <tr key={`${u.id}-${c.field}`}>
                        <td>{i === 0 ? <>{u.title}{u.staleWarning && <> <Badge tone="amber">edited in the app after export</Badge></>}</> : ""}</td>
                        <td>{FIELD_LABEL[c.field] ?? c.field}</td>
                        <td className="muted">{showValue(c.from)}</td>
                        <td>{showValue(c.to)}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            )}
            {csvReport.creates.length > 0 && <div>New books: {csvReport.creates.map((c) => c.title).join(", ")}</div>}
          </div>
        )}
      </Modal>
    </section>
  );
}

function FeedbackSection() {
  const toast = useToast();
  const list = useQuery(queries.feedback.key, queries.feedback.fetch);
  const sum = useQuery(queries.feedbackSummary.key, queries.feedbackSummary.fetch);
  useEffect(() => { if (list.error) toast.fail(list.error); }, [list.error, toast]);
  const items = list.data?.items ?? null;
  const summary = sum.data ?? null;
  const remove = async (id: string) => {
    try { await api.feedback.remove(id); toast.notify("Feedback removed; it will be excluded from future recommendations."); invalidate("feedback"); } catch (e) { toast.fail(e); }
  };
  return (
    <section className="card">
      <h2>Feedback memory</h2>
      <p className="small muted">{summary?.activeFeedbackCount ?? 0} active feedback events. {summary?.note ?? ""}</p>
      {summary?.derived ? <pre className="block">{JSON.stringify(summary.derived, null, 2)}</pre> : null}
      {items && items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Action</th><th>Scope</th><th>Text</th><th>Source</th><th></th></tr></thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id}>
                  <td className="small">{fmtDateTime(f.created_at)}</td>
                  <td>{f.action.replace(/_/g, " ")}{f.quality_rating !== null ? ` (${f.quality_rating})` : ""}</td>
                  <td className="small">{f.scope}</td>
                  <td className="small">{f.text ?? <span className="muted">—</span>}</td>
                  <td className="small">{f.source}</td>
                  <td><button className="btn sm ghost" onClick={() => void remove(f.id)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function JobsSection() {
  const { data, error } = useQuery(queries.jobs.key, queries.jobs.fetch);
  const jobs = data?.items ?? (error ? [] : null);
  return (
    <section className="card">
      <h2>Generation runs</h2>
      {jobs === null ? <p className="muted small">Loading…</p> : jobs.length === 0 ? <p className="muted small">No runs yet.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Created</th><th>Kind</th><th>Shelf</th><th>Period</th><th>Status</th><th>Stage</th><th>Cost</th><th>Error</th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="small">{fmtDateTime(j.created_at)}</td><td>{j.kind}</td><td>{j.horizon}</td><td className="mono">{j.period_key}</td>
                  <td><Badge tone={j.status === "succeeded" ? "green" : j.status === "failed" ? "red" : j.status === "running" ? "blue" : ""}>{j.status}</Badge></td>
                  <td className="small">{j.stage}</td>
                  <td className="small">{(() => { const c = j.cost as { actualUsd?: number }; return typeof c.actualUsd === "number" ? `$${c.actualUsd.toFixed(3)}` : "—"; })()}</td>
                  <td className="small" style={{ color: "var(--red)" }}>{j.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
