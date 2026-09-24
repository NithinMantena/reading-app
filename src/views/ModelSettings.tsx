import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { invalidate, useQuery } from "../lib/cache";
import { fmtDateTime } from "../lib/format";
import { queries } from "../lib/queries";
import type { Horizon, JobDetail, KeyName, ModelProvider, ModelSettings } from "../lib/types";
import { Badge } from "../components/ui";
import { useToast } from "../components/Toast";

const PROVIDER_LABEL: Record<ModelProvider, string> = { google: "Google (Gemini)", anthropic: "Claude (Anthropic)" };
const KEY_LABEL: Record<KeyName, string> = { google: "Google API key", anthropic: "Claude API key", typesafe: "Jev (TypeSafe) API key" };

function KeyField({ name, status, value, onChange, onRemove }: {
  name: KeyName; status: ModelSettings["keys"][KeyName]; value: string; onChange: (v: string) => void; onRemove: () => void;
}) {
  const id = `key-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{KEY_LABEL[name]}</label>
      <input id={id} type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={status.set ? `Saved · ends in ${status.last4} (paste to replace)` : "Paste API key"} />
      <span className="hint">
        {status.set
          ? <>{status.source === "server" ? "Using the key set on the server." : "Saved in this app."}{" "}
              {status.source === "settings" && <button type="button" className="btn ghost sm" onClick={onRemove}>Remove</button>}</>
          : "Not set."}
      </span>
    </div>
  );
}

/** Provider, models and API keys for discovery. Saved on its own; keys are write-only. */
export function ModelsSection() {
  const toast = useToast();
  const { data, error } = useQuery(queries.modelSettings.key, queries.modelSettings.fetch);
  const [provider, setProvider] = useState<ModelProvider>("anthropic");
  const [main, setMain] = useState("");
  const [helper, setHelper] = useState("");
  const [compare, setCompare] = useState("");
  const [keys, setKeys] = useState<Record<KeyName, string>>({ google: "", anthropic: "", typesafe: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    setProvider(data.config.provider);
    setMain(data.config.main);
    setHelper(data.config.helper);
    setCompare(data.config.compare.join(", "));
  }, [data]);

  if (error && !data) return <section className="card"><h2>AI models</h2><p className="small" style={{ color: "var(--red)" }}>{error.message}</p></section>;
  if (!data) return <section className="card"><h2>AI models</h2><p className="small muted">Loading…</p></section>;

  const switchProvider = (p: ModelProvider) => {
    const from = data.defaults.providers[provider];
    const to = data.defaults.providers[p];
    // Swap in the new provider's defaults unless the model names were customised.
    if (!main || main === from.main) setMain(to.main);
    if (!helper || helper === from.helper) setHelper(to.helper);
    setProvider(p);
  };

  const save = async (removeKey?: KeyName) => {
    setSaving(true);
    try {
      const keyUpdates: Partial<Record<KeyName, string | null>> = {};
      for (const k of Object.keys(keys) as KeyName[]) if (keys[k].trim()) keyUpdates[k] = keys[k].trim();
      if (removeKey) keyUpdates[removeKey] = null;
      await api.models.put({
        provider, main: main.trim(), helper: helper.trim(),
        compare: compare.split(",").map((s) => s.trim()).filter(Boolean),
        keys: keyUpdates,
      });
      setKeys({ google: "", anthropic: "", typesafe: "" });
      invalidate("generation");
      toast.notify(removeKey ? "Key removed" : "AI model settings saved");
    } catch (e) { toast.fail(e); } finally { setSaving(false); }
  };

  const mainKey = data.keys[provider];
  return (
    <section className="card">
      <h2>AI models</h2>
      <p className="small muted">The main model picks your articles. The helper writes search queries and settles access checks Jev isn't sure about. Jev checks whether borderline articles are free to read in full. Keys are stored encrypted in your Supabase project, never shown again, and can only be changed from this signed-in page.</p>
      <div className="form-grid">
        <div className="field wide">
          <span className="label">Provider</span>
          <div className="row">
            {(["google", "anthropic"] as ModelProvider[]).map((p) => (
              <label key={p} className="check"><input type="radio" name="provider" checked={provider === p} onChange={() => switchProvider(p)} /> {PROVIDER_LABEL[p]}</label>
            ))}
          </div>
          {!mainKey.set && !keys[provider].trim() && <span className="hint" style={{ color: "var(--red)" }}>Add a {provider === "google" ? "Google" : "Claude"} key below or discovery can't run.</span>}
        </div>
        <div className="field">
          <label htmlFor="m-main">Main model</label>
          <input id="m-main" type="text" className="mono" value={main} onChange={(e) => setMain(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="m-helper">Helper model</label>
          <input id="m-helper" type="text" className="mono" value={helper} onChange={(e) => setHelper(e.target.value)} />
        </div>
        <KeyField name={provider} status={mainKey} value={keys[provider]} onChange={(v) => setKeys({ ...keys, [provider]: v })} onRemove={() => void save(provider)} />
        <KeyField name="typesafe" status={data.keys.typesafe} value={keys.typesafe} onChange={(v) => setKeys({ ...keys, typesafe: v })} onRemove={() => void save("typesafe")} />
        {(() => {
          const other: ModelProvider = provider === "google" ? "anthropic" : "google";
          return <KeyField name={other} status={data.keys[other]} value={keys[other]} onChange={(v) => setKeys({ ...keys, [other]: v })} onRemove={() => void save(other)} />;
        })()}
        <div className="field">
          <label htmlFor="m-compare">Models to compare</label>
          <input id="m-compare" type="text" className="mono" value={compare} onChange={(e) => setCompare(e.target.value)} />
          <span className="hint">Up to four, as provider:model. Used only by "Compare ranking models" below.</span>
        </div>
      </div>
      <div className="row" style={{ marginTop: "0.75rem" }}>
        <button className="btn primary" disabled={saving || !main.trim() || !helper.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Save AI models"}</button>
        <span className="small muted">Access check: {data.access === "jev" ? "Jev, with the helper model for unsure cases" : "helper model (no Jev key)"}</span>
      </div>
    </section>
  );
}

function ComparisonTable({ job }: { job: JobDetail }) {
  const runs = job.checkpoint?.comparison ?? [];
  const cands = new Map((job.checkpoint?.candidates ?? []).map((c) => [c.id, c]));
  if (!runs.length) return <p className="small muted">No rankings recorded{job.error ? `: ${job.error}` : "."}</p>;
  return (
    <div className="compare-grid" style={{ display: "grid", gap: "1rem", gridTemplateColumns: `repeat(auto-fit, minmax(240px, 1fr))` }}>
      {runs.map((r) => (
        <div key={`${r.provider}:${r.model}`} className="stack" style={{ gap: "0.5rem" }}>
          <div><strong className="mono">{r.model}</strong> <span className="small muted">${r.costUsd.toFixed(3)}</span></div>
          <ol className="small" style={{ paddingLeft: "1.2rem", margin: 0 }}>
            {r.selections.slice(0, 7).map((s) => {
              const c = cands.get(s.candidateId);
              return (
                <li key={s.candidateId} style={{ marginBottom: "0.5rem" }}>
                  {c ? <a href={c.url} target="_blank" rel="noreferrer">{c.title ?? c.url}</a> : s.candidateId}
                  {c?.publisher && <span className="muted"> · {c.publisher}</span>}
                  <span className="muted"> · {s.score}{s.isSurprise ? " · surprise" : ""}</span>
                  <div className="muted">{s.whyMatters}</div>
                </li>
              );
            })}
          </ol>
          {r.batchNote && <div className="small muted">{r.batchNote}</div>}
        </div>
      ))}
    </div>
  );
}

/** Rank one shelf's candidates with several models side by side; nothing is published. */
export function ComparisonSection() {
  const toast = useToast();
  const { data, refresh } = useQuery(queries.jobs.key, queries.jobs.fetch);
  const { data: models } = useQuery(queries.modelSettings.key, queries.modelSettings.fetch);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<JobDetail | null>(null);
  const jobs = (data?.items ?? []).filter((j) => j.kind === "model_comparison").slice(0, 8);

  const run = async (horizon: Horizon) => {
    setBusy(true);
    try {
      const res = await api.jobs.create({ kind: "model_comparison", horizon });
      res.warnings.forEach((w) => toast.notify(w));
      toast.notify(res.jobs.some((j) => (j as { existing?: boolean }).existing) ? "A run for this shelf is already in progress." : "Comparison started; it takes a few minutes.");
      await refresh();
      for (let i = 0; i < 12; i++) {
        const r = await api.generation.step().catch(() => null);
        await refresh();
        if (!r || !r.processed.length || r.processed.every((p) => p.status === "succeeded" || p.status === "failed")) break;
      }
      invalidate("jobs", "generation");
    } catch (e) { toast.fail(e); } finally { setBusy(false); }
  };
  const view = async (id: string) => {
    try { setOpen(await api.jobs.get(id)); } catch (e) { toast.fail(e); }
  };

  return (
    <section className="card">
      <h2>Compare ranking models</h2>
      <p className="small muted">Finds one shelf's candidates once, then asks each model in "Models to compare" to pick from the same list. Nothing is published, so your shelves don't change. Costs roughly one run per model{models ? ` (${models.config.compare.join(", ")})` : ""}; models without a saved key are skipped.</p>
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => void run("daily")}>Compare on the daily shelf</button>
        <button className="btn" disabled={busy} onClick={() => void run("weekly")}>Compare on the weekly shelf</button>
      </div>
      {jobs.length > 0 && (
        <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
          <table>
            <thead><tr><th>Started</th><th>Shelf</th><th>Period</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="small">{fmtDateTime(j.created_at)}</td><td>{j.horizon}</td><td className="mono">{j.period_key}</td>
                  <td><Badge tone={j.status === "succeeded" ? "green" : j.status === "failed" ? "red" : "blue"}>{j.status}</Badge></td>
                  <td>{j.status === "succeeded" && <button className="btn sm ghost" onClick={() => void view(j.id)}>View</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <div style={{ marginTop: "1rem" }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>{open.horizon} · {open.period_key}</h3>
            <button className="btn sm ghost" onClick={() => setOpen(null)}>Close</button>
          </div>
          <ComparisonTable job={open} />
        </div>
      )}
    </section>
  );
}
