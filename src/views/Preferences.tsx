import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ImportReport } from "../lib/api";
import type { FeedbackEvent, IntegrationToken, Job, Settings } from "../lib/types";
import { fmtDateTime } from "../lib/format";
import { useAuth } from "../auth/AuthProvider";
import { useToast } from "../components/Toast";
import { Badge, Modal } from "../components/ui";
import { API_BASE } from "../lib/supabase";

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
          <h2>Generation budget</h2>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="p-cap">Monthly spending cap (USD)</label>
              <input id="p-cap" type="number" min={0} step={1} value={draft.budget.monthly_cap_usd} onChange={(e) => set("budget", { ...draft.budget, monthly_cap_usd: Number(e.target.value) })} />
              <span className="hint">Generation stops when the cap is reached; the library and existing lists keep working. Model and search providers are configured server-side (Phase 2).</span>
            </div>
          </div>
        </section>

        <TokensSection />
        <DataSection />
        <FeedbackSection />
        <JobsSection />
      </div>
    </>
  );
}

function TokensSection() {
  const toast = useToast();
  const [items, setItems] = useState<IntegrationToken[]>([]);
  const [created, setCreated] = useState<IntegrationToken | null>(null);
  const [name, setName] = useState("OpenClaw");
  const load = useCallback(async () => { try { setItems((await api.tokens.list()).items); } catch (e) { toast.fail(e); } }, [toast]);
  useEffect(() => { void load(); }, [load]);
  const create = async () => {
    try {
      const t = await api.tokens.create({ name });
      setCreated(t);
      await load();
    } catch (e) { toast.fail(e); }
  };
  const revoke = async (id: string) => {
    if (!window.confirm("Revoke this token? The bot will lose access immediately.")) return;
    try { await api.tokens.revoke(id); toast.notify("Token revoked"); await load(); } catch (e) { toast.fail(e); }
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

function DataSection() {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ data: unknown; report: ImportReport } | null>(null);
  const [busy, setBusy] = useState(false);

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
      const data = JSON.parse(await f.text());
      setPending({ data, report: await api.transfer.importPreview(data) });
    } catch (e) { toast.fail(e, "Could not read that file"); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const commit = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await api.transfer.importCommit(pending.data);
      toast.notify(`Imported ${r.books.create} books, ${r.readings.create} readings, ${r.feedback.create} feedback events`);
      setPending(null);
    } catch (e) { toast.fail(e); } finally { setBusy(false); }
  };
  return (
    <section className="card">
      <h2>Your data</h2>
      <p className="small muted">Exports contain books, sessions, readings, feedback, and preferences. They never include tokens.</p>
      <div className="row">
        <button className="btn" onClick={() => void exportJson()}>Export everything (JSON)</button>
        <button className="btn" onClick={() => void exportCsv()}>Export books (CSV)</button>
        <label className="btn">
          {busy ? "Reading…" : "Import JSON…"}
          <input ref={fileRef} type="file" accept="application/json" className="sr-only" onChange={(e) => void pickFile(e.target.files?.[0])} />
        </label>
      </div>
      <Modal open={pending !== null} title="Import preview" onClose={() => setPending(null)}
        footer={<><button className="btn" onClick={() => setPending(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void commit()}>Import</button></>}>
        {pending && (
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
    </section>
  );
}

function FeedbackSection() {
  const toast = useToast();
  const [items, setItems] = useState<FeedbackEvent[] | null>(null);
  const [summary, setSummary] = useState<{ derived: unknown; activeFeedbackCount: number; note?: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const [f, s] = await Promise.all([api.feedback.list({}), api.preferences.summary()]);
      setItems(f.items);
      setSummary(s);
    } catch (e) { toast.fail(e); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  const remove = async (id: string) => {
    try { await api.feedback.remove(id); toast.notify("Feedback removed; it will be excluded from future recommendations."); await load(); } catch (e) { toast.fail(e); }
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
  const [jobs, setJobs] = useState<Job[] | null>(null);
  useEffect(() => { api.jobs.list().then((r) => setJobs(r.items)).catch(() => setJobs([])); }, []);
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
                  <td className="small">{(j.cost as { actual_usd?: number; estimated_usd?: number }).actual_usd ?? (j.cost as { estimated_usd?: number }).estimated_usd ?? "—"}</td>
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
