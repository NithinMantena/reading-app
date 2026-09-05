import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { api } from "../lib/api";
import { useToast } from "../components/Toast";
import { ChipsInput } from "../components/ui";

const SUGGESTED = [
  "Investing", "Economics", "Business history", "Technology", "Science", "Mathematics", "History", "Philosophy",
  "Biography", "Literature", "Energy", "Medicine", "Policy", "Design", "Psychology",
];

export function Onboarding() {
  const { settings, setSettings } = useAuth();
  const toast = useToast();
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [tz, setTz] = useState(settings?.time_zone && settings.time_zone !== "UTC" ? settings.time_zone : browserTz);
  const [interests, setInterests] = useState<string[]>(settings?.interests.map((i) => i.topic) ?? []);
  const [saving, setSaving] = useState(false);

  const finish = async () => {
    setSaving(true);
    try {
      const s = await api.preferences.patch({
        time_zone: tz,
        interests: interests.map((topic) => ({ topic, weight: 1 })),
        onboarding_complete: true,
      });
      setSettings(s);
    } catch (e) {
      toast.fail(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="content" style={{ maxWidth: 680 }}>
      <h1>Welcome</h1>
      <p className="muted">Two settings shape everything else. Both can be changed later in Preferences.</p>
      <div className="card stack" style={{ gap: "1.25rem" }}>
        <div className="field">
          <label htmlFor="tz">Time zone</label>
          <input id="tz" type="text" value={tz} onChange={(e) => setTz(e.target.value)} list="tz-list" />
          <datalist id="tz-list">
            {(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [browserTz]).map((z) => <option key={z} value={z} />)}
          </datalist>
          <span className="hint">Your browser suggests <b>{browserTz}</b>. Publication windows (yesterday, last week, last month…) are computed in this zone.</span>
        </div>
        <div className="field">
          <span className="label">Broad interests</span>
          <ChipsInput values={interests} onChange={setInterests} placeholder="Add a topic and press Enter" />
          <div className="chips" style={{ marginTop: "0.4rem" }}>
            {SUGGESTED.filter((s) => !interests.includes(s)).map((s) => (
              <button key={s} type="button" className="chip" onClick={() => setInterests([...interests, s])}>+ {s}</button>
            ))}
          </div>
          <span className="hint">These seed discovery. One slot in every batch is deliberately outside your usual reading.</span>
        </div>
        <div className="spread">
          <span className="small muted">NYT subscriber access and the surprise slot are already on.</span>
          <button className="btn primary" disabled={saving || !tz} onClick={() => void finish()}>Continue</button>
        </div>
      </div>
    </main>
  );
}
