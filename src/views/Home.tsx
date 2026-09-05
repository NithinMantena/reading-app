import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Book, RecommendationEntry, Shelf } from "../lib/types";
import { authorsText, fmtDate, fmtMinutes, hostOf } from "../lib/format";
import { useRealtime } from "../lib/useRealtime";
import { useAuth } from "../auth/AuthProvider";
import { AccessBadge, Badge, Empty } from "../components/ui";

export function Home() {
  const { settings } = useAuth();
  const [reading, setReading] = useState<Book[] | null>(null);
  const [shelves, setShelves] = useState<Shelf[] | null>(null);
  const [queueCount, setQueueCount] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [books, recs, queue] = await Promise.allSettled([
      api.books.list({ status: "reading", sort: "updated", limit: 6 }),
      api.recommendations.all(),
      api.readings.list({ status: "saved", limit: 1 }),
    ]);
    if (books.status === "fulfilled") setReading(books.value.items);
    if (recs.status === "fulfilled") setShelves(recs.value.shelves);
    if (queue.status === "fulfilled") setQueueCount(queue.value.total);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const tables = useMemo(() => ["books", "reading_sessions", "recommendation_batches", "reading_items"], []);
  useRealtime(tables, load, 30000);

  const daily = shelves?.find((s) => s.horizon === "daily");
  const dailyEntries = daily?.entries.filter((e) => e.state !== "dismissed") ?? [];
  // The deeper read references an existing recommendation; it never consumes an extra slot.
  const deeper: RecommendationEntry | undefined =
    shelves?.find((s) => s.horizon === "monthly")?.entries.find((e) => e.state === "active") ??
    shelves?.find((s) => s.horizon === "weekly")?.entries.find((e) => e.state === "active");

  const greeting = (() => {
    const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: settings?.time_zone }).format(new Date()));
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  })();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{greeting}</h1>
          <p>{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", timeZone: settings?.time_zone })}</p>
        </div>
        <div className="row">
          <Link className="btn" to="/library">+ Book</Link>
          <Link className="btn" to="/queue">+ Reading</Link>
        </div>
      </div>

      <div className="hero">
        <section className="section">
          <div className="section-head">
            <h2>Today's readings</h2>
            {daily && <span className="small muted">Published {daily.window.label}</span>}
          </div>
          {shelves === null ? <p className="muted">Loading…</p> : dailyEntries.length === 0 ? (
            <Empty title={daily?.activeJob ? "Today's edition is being prepared" : "No daily edition yet"}>
              <Link to="/discover">Open Discover</Link> to generate editions or review earlier ones.
            </Empty>
          ) : (
            <div className="stack">
              {dailyEntries.map((e) => (
                <article key={e.id} className="card rec-card" style={{ padding: "0.8rem 1rem" }}>
                  <div className="spread" style={{ alignItems: "flex-start" }}>
                    <div>
                      <div className="title" style={{ fontSize: "1rem" }}>
                        {e.reading.canonical_url ? <a href={e.reading.canonical_url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>{e.reading.title}</a> : e.reading.title}
                      </div>
                      <div className="meta">
                        <span>{e.reading.publisher ?? hostOf(e.reading.canonical_url)}</span>
                        {e.reading.duration_minutes ? <span>{fmtMinutes(e.reading.duration_minutes)}</span> : null}
                        {e.is_surprise && <Badge tone="accent">Outside your usual reading</Badge>}
                      </div>
                    </div>
                    <AccessBadge access={e.reading.access_class} />
                  </div>
                  {e.why_matters && <div className="small muted">{e.why_matters}</div>}
                </article>
              ))}
              <Link to="/discover" className="small">All shelves →</Link>
            </div>
          )}
        </section>

        <aside className="stack">
          <section className="card">
            <h3>Continue reading</h3>
            {reading === null ? <p className="muted small">Loading…</p> : reading.length === 0 ? (
              <p className="muted small">Nothing in progress. <Link to="/library">Pick something from your wishlist.</Link></p>
            ) : reading.map((b) => (
              <Link key={b.id} to={`/library/${b.id}`} className="continue-item" style={{ color: "inherit" }}>
                {b.cover_url ? <img className="cover-sm" src={b.cover_url} alt="" /> : <div className="cover-sm" />}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, lineHeight: 1.25 }}>{b.title}</div>
                  <div className="small muted">{authorsText(b.authors, b.author_unknown)}{b.started_on ? ` · since ${fmtDate(b.started_on)}` : ""}</div>
                </div>
              </Link>
            ))}
          </section>

          {deeper && (
            <section className="card">
              <h3>A deeper read</h3>
              <div className="rec-card">
                <div className="title" style={{ fontSize: "1rem" }}>
                  <a href={deeper.reading.canonical_url ?? "#"} target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>{deeper.reading.title}</a>
                </div>
                <div className="meta"><span>{deeper.reading.publisher ?? hostOf(deeper.reading.canonical_url)}</span>{deeper.reading.duration_minutes ? <span>{fmtMinutes(deeper.reading.duration_minutes)}</span> : null}</div>
                {deeper.why_matters && <div className="small muted">{deeper.why_matters}</div>}
              </div>
            </section>
          )}

          <section className="card">
            <h3>Queue</h3>
            <p className="small muted" style={{ margin: 0 }}>{queueCount === null ? "…" : `${queueCount} saved ${queueCount === 1 ? "reading" : "readings"} waiting.`} <Link to="/queue">Open queue</Link></p>
          </section>
        </aside>
      </div>
    </>
  );
}
