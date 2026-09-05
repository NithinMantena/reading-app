#!/usr/bin/env node
// Thin CLI over the reading app's /v1 API, for the local OpenClaw bot.
// No dependencies. Node 20+.
//
//   node bot/reading.mjs configure --url <api base> --token <rap_...>
//   node bot/reading.mjs books add --title "..." --author "..." [--status reading --started yesterday]
//   node bot/reading.mjs books finish <id> [--on today] [--rating 8.5]
//   node bot/reading.mjs readings add <url|title> [--notes "..."]
//   node bot/reading.mjs recs --horizon weekly
//   node bot/reading.mjs feedback add --action too_superficial --reading <id> [--text "..."]
//   node bot/reading.mjs prefs get | prefs summary
//   node bot/reading.mjs jobs create --kind alternatives --horizon yearly
//
// Output is JSON (one object) so the agent can parse it. Add --pretty for humans.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const CONFIG_DIR = process.env.READING_APP_CONFIG_DIR || join(homedir(), ".config", "reading-app");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

function loadConfig() {
  const fromEnv = { url: process.env.READING_APP_URL, token: process.env.READING_APP_TOKEN };
  if (fromEnv.url && fromEnv.token) return fromEnv;
  if (existsSync(CONFIG_PATH)) {
    const c = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { url: fromEnv.url || c.url, token: fromEnv.token || c.token };
  }
  return fromEnv;
}

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) opts[key] = true;
      else {
        // Repeated flags accumulate (e.g. --author A --author B).
        if (key in opts) opts[key] = [].concat(opts[key], next);
        else opts[key] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { pos, opts };
}

function out(obj, opts) {
  process.stdout.write(opts.pretty ? JSON.stringify(obj, null, 2) + "\n" : JSON.stringify(obj) + "\n");
}

function fail(message, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...extra }) + "\n");
  process.exit(1);
}

async function request(cfg, method, path, body, { idempotent = false, key } = {}) {
  if (!cfg.url || !cfg.token) fail("Not configured. Run: reading configure --url <api base> --token <token>");
  const headers = { authorization: `Bearer ${cfg.token}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotent) headers["idempotency-key"] = key || randomUUID();
  const res = await fetch(`${cfg.url.replace(/\/$/, "")}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const e = json?.error || {};
    fail(e.message || `HTTP ${res.status}`, { status: res.status, code: e.code, details: e.details });
  }
  return json;
}

const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "" && v !== true) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

const list = (v) => (v === undefined ? undefined : [].concat(v).flatMap((x) => String(x).split(",")).map((s) => s.trim()).filter(Boolean));

/** Resolve "today" / "yesterday" / "unknown" / YYYY-MM-DD in the app's configured time zone. */
async function resolveDate(cfg, v, meCache) {
  if (v === undefined) return undefined;
  const s = String(v).toLowerCase();
  if (s === "unknown" || s === "none" || s === "null") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const me = meCache.me || (meCache.me = await request(cfg, "GET", "/me"));
  const tz = me.timeZone || "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  let d = new Date(Date.UTC(Number(g("year")), Number(g("month")) - 1, Number(g("day"))));
  const m = /^(\d+) days? ago$/.exec(s);
  if (s === "yesterday") d.setUTCDate(d.getUTCDate() - 1);
  else if (m) d.setUTCDate(d.getUTCDate() - Number(m[1]));
  else if (s !== "today") fail(`Unrecognised date: ${v}. Use YYYY-MM-DD, today, yesterday, "N days ago", or unknown.`);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const { pos, opts } = parseArgs(process.argv.slice(2));
  const [group, action, ...rest] = pos;
  const cfg = loadConfig();
  const meCache = {};
  const idem = { idempotent: true, key: opts["idempotency-key"] };

  if (!group || group === "help" || opts.help) {
    out({ usage: readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 14).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") }, { pretty: true });
    return;
  }

  if (group === "configure") {
    if (!opts.url || !opts.token) fail("configure needs --url and --token");
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ url: opts.url, token: opts.token }, null, 2), { mode: 0o600 });
    const me = await request({ url: opts.url, token: opts.token }, "GET", "/me");
    return out({ ok: true, configPath: CONFIG_PATH, timeZone: me.timeZone, scopes: me.scopes }, opts);
  }

  if (group === "me") return out(await request(cfg, "GET", "/me"), opts);

  if (group === "books") {
    switch (action) {
      case "list":
      case "search":
        return out(await request(cfg, "GET", `/books${qs({ q: opts.q ?? rest[0], status: opts.status, topic: opts.topic, limit: opts.limit ?? 50, sort: opts.sort, archived: opts.archived })}`), opts);
      case "get":
        return out(await request(cfg, "GET", `/books/${rest[0]}`), opts);
      case "add": {
        const body = {
          title: opts.title ?? rest[0], authors: list(opts.author ?? opts.authors), author_unknown: opts["author-unknown"] === true,
          library_status: opts.status, topics: list(opts.topics), isbn: opts.isbn, why_read: opts.why, recommended_by: opts["recommended-by"], notes: opts.notes,
          started_on: await resolveDate(cfg, opts.started, meCache), finished_on: await resolveDate(cfg, opts.finished, meCache),
          rating: opts.rating !== undefined ? Number(opts.rating) : undefined, allow_duplicate: opts["allow-duplicate"] === true,
        };
        if (!body.title) fail("books add needs --title");
        return out(await request(cfg, "POST", "/books", body, idem), opts);
      }
      case "update": {
        const id = rest[0];
        if (!id) fail("books update needs an id");
        const current = await request(cfg, "GET", `/books/${id}`);
        const body = {
          version: current.version, title: opts.title, authors: list(opts.author ?? opts.authors), library_status: opts.status, topics: list(opts.topics),
          notes: opts.notes, why_read: opts.why, isbn: opts.isbn, archived: opts.archive === true ? true : opts.restore === true ? false : undefined,
          started_on: await resolveDate(cfg, opts.started, meCache), finished_on: await resolveDate(cfg, opts.finished, meCache),
          rating: opts.rating !== undefined ? (opts.rating === "none" ? null : Number(opts.rating)) : undefined, session_notes: opts["session-notes"],
        };
        return out(await request(cfg, "PATCH", `/books/${id}`, body), opts);
      }
      case "start": {
        const id = rest[0];
        const current = await request(cfg, "GET", `/books/${id}`);
        const started_on = await resolveDate(cfg, opts.on ?? "today", meCache);
        return out(await request(cfg, "PATCH", `/books/${id}`, { version: current.version, library_status: "reading", started_on }), opts);
      }
      case "finish": {
        const id = rest[0];
        const current = await request(cfg, "GET", `/books/${id}`);
        const finished_on = await resolveDate(cfg, opts.on ?? "today", meCache);
        const body = { version: current.version, library_status: "finished", finished_on, session_notes: opts["session-notes"] };
        if (opts.rating !== undefined) body.rating = Number(opts.rating);
        return out(await request(cfg, "PATCH", `/books/${id}`, body), opts);
      }
      case "stop": {
        const id = rest[0];
        const current = await request(cfg, "GET", `/books/${id}`);
        return out(await request(cfg, "PATCH", `/books/${id}`, { version: current.version, library_status: "stopped", rating: opts.rating !== undefined ? Number(opts.rating) : undefined }), opts);
      }
      case "reread":
        return out(await request(cfg, "POST", `/books/${rest[0]}/sessions`, { started_on: await resolveDate(cfg, opts.on ?? "today", meCache) }, idem), opts);
      case "session": {
        // books session <sessionId> --started ... --finished ... --rating ... --status ...
        const id = rest[0];
        const body = { started_on: await resolveDate(cfg, opts.started, meCache), finished_on: await resolveDate(cfg, opts.finished, meCache), status: opts.status, notes: opts.notes, rating: opts.rating !== undefined ? Number(opts.rating) : undefined };
        return out(await request(cfg, "PATCH", `/reading-sessions/${id}`, body), opts);
      }
      default:
        fail("books: list|get|add|update|start|finish|stop|reread|session");
    }
  }

  if (group === "readings") {
    switch (action) {
      case "list":
      case "search":
        return out(await request(cfg, "GET", `/readings${qs({ q: opts.q ?? rest[0], status: opts.status, topic: opts.topic, limit: opts.limit ?? 50, include_archived: opts["include-archived"] })}`), opts);
      case "get":
        return out(await request(cfg, "GET", `/readings/${rest[0]}`), opts);
      case "add": {
        const target = opts.url ?? opts.title ?? rest[0];
        if (!target) fail("readings add needs a URL or --title");
        const isUrl = /^(https?:\/\/)?[^\s]+\.[a-z]{2,}(\/\S*)?$/i.test(String(target)) && !opts.title;
        const body = { ...(isUrl ? { url: target } : { title: target }), notes: opts.notes, topics: list(opts.topics), authors: list(opts.author), publisher: opts.publisher, published_on: opts.published };
        return out(await request(cfg, "POST", "/readings", body, idem), opts);
      }
      case "update": {
        const id = rest[0];
        const current = await request(cfg, "GET", `/readings/${id}`);
        const body = { version: current.version, queue_status: opts.status, notes: opts.notes, title: opts.title, topics: list(opts.topics), archived: opts.archive === true ? true : opts.restore === true ? false : undefined, access_class: opts.access };
        return out(await request(cfg, "PATCH", `/readings/${id}`, body), opts);
      }
      default:
        fail("readings: list|get|add|update");
    }
  }

  if (group === "recs" || group === "recommendations") {
    if (action === "archive") return out(await request(cfg, "GET", `/recommendations/archive${qs({ horizon: opts.horizon })}`), opts);
    if (action === "entry") return out(await request(cfg, "PATCH", `/recommendation-entries/${rest[0]}`, { state: opts.state }), opts);
    return out(await request(cfg, "GET", `/recommendations${qs({ horizon: opts.horizon ?? action, period: opts.period, version: opts.version })}`), opts);
  }

  if (group === "feedback") {
    switch (action) {
      case "list":
        return out(await request(cfg, "GET", `/feedback${qs({ reading_id: opts.reading, book_id: opts.book, limit: opts.limit ?? 50 })}`), opts);
      case "add": {
        if (!opts.action) fail("feedback add needs --action (more_like_this, less_like_this, already_know, too_superficial, too_technical, too_long, wrong_topic, unreliable_source, cannot_access, note, quality_rating)");
        const body = { action: opts.action, scope: opts.scope, text: opts.text, reading_id: opts.reading, book_id: opts.book, recommendation_entry_id: opts.entry, quality_rating: opts.rating !== undefined ? Number(opts.rating) : undefined, topics: list(opts.topics) };
        return out(await request(cfg, "POST", "/feedback", body, idem), opts);
      }
      case "remove":
        return out(await request(cfg, "DELETE", `/feedback/${rest[0]}`), opts);
      default:
        fail("feedback: list|add|remove");
    }
  }

  if (group === "prefs" || group === "preferences") {
    if (action === "summary") return out(await request(cfg, "GET", "/preference-summary"), opts);
    if (action === "set") {
      const current = await request(cfg, "GET", "/preferences");
      const body = { version: current.version };
      if (opts.tz) body.time_zone = opts.tz;
      if (opts.interests) body.interests = list(opts.interests);
      if (opts.exclude) body.exclusions = list(opts.exclude).map((v) => ({ kind: opts["exclude-kind"] ?? "topic", value: v }));
      if (opts.cap !== undefined) body.budget = { monthly_cap_usd: Number(opts.cap) };
      return out(await request(cfg, "PATCH", "/preferences", body), opts);
    }
    return out(await request(cfg, "GET", "/preferences"), opts);
  }

  if (group === "jobs") {
    if (action === "create") return out(await request(cfg, "POST", "/recommendation-jobs", { kind: opts.kind ?? "alternatives", horizon: opts.horizon }, idem), opts);
    if (action === "get") return out(await request(cfg, "GET", `/jobs/${rest[0]}`), opts);
    return out(await request(cfg, "GET", "/jobs"), opts);
  }

  if (group === "export") {
    const data = await request(cfg, "GET", "/export");
    if (opts.out) {
      writeFileSync(String(opts.out), JSON.stringify(data, null, 2));
      return out({ ok: true, wrote: opts.out, books: data.books.length, readings: data.readings.length }, opts);
    }
    return out(data, opts);
  }

  fail(`Unknown command '${group}'. Groups: configure, me, books, readings, recs, feedback, prefs, jobs, export`);
}

main().catch((e) => fail(e?.message || String(e)));
