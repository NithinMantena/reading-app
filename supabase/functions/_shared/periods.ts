// Deterministic publication-window math. Shared by the frontend (via the @shared alias)
// and the Edge Function. No dependencies; time zones are handled with Intl.
//
// Windows are half-open: [start, end). "end" is the first instant of the next period.
// Weeks run Monday–Sunday. Decades are calendar decades (2010–2019, 2020–2029, ...).

export type Horizon = "daily" | "weekly" | "monthly" | "yearly" | "decade";
export const HORIZONS: Horizon[] = ["daily", "weekly", "monthly", "yearly", "decade"];

export const TARGET_COUNTS: Record<Horizon, number> = {
  daily: 5,
  weekly: 5,
  monthly: 2,
  yearly: 5,
  decade: 5,
};

export const HORIZON_LABELS: Record<Horizon, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
  decade: "Decade",
};

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export interface PeriodWindow {
  horizon: Horizon;
  timeZone: string;
  /** Inclusive local start date */
  startDate: LocalDate;
  /** Exclusive local end date (first day of the next period) */
  endDate: LocalDate;
  /** UTC instants for the half-open interval */
  startUtc: Date;
  endUtc: Date;
  /** Stable key such as 2026-09-04, 2026-W35, 2026-08, 2025, 2010s */
  periodKey: string;
  /** Human label such as "September 4, 2026" or "August 24 – 30, 2026" */
  label: string;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

export function formatLocalDate(d: LocalDate): string {
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

export function parseLocalDate(s: string): LocalDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid date: ${s}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Local calendar date of an instant in a given IANA zone. */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Offset (minutes east of UTC) that `timeZone` has at `instant`. */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** UTC instant of local midnight at the start of `date` in `timeZone` (DST-safe). */
export function localMidnightUtc(date: LocalDate, timeZone: string): Date {
  const guess = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0);
  let offset = offsetMinutesAt(new Date(guess), timeZone);
  let instant = guess - offset * 60000;
  // Re-check once in case the guess straddled a DST transition.
  const offset2 = offsetMinutesAt(new Date(instant), timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    instant = guess - offset * 60000;
  }
  return new Date(instant);
}

export function addDays(d: LocalDate, days: number): LocalDate {
  const x = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() };
}

/** ISO weekday 1=Monday..7=Sunday */
export function isoWeekday(d: LocalDate): number {
  const wd = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay(); // 0=Sun
  return wd === 0 ? 7 : wd;
}

export function isoWeekKey(monday: LocalDate): string {
  // ISO week number is defined by the Thursday of the week.
  const thu = addDays(monday, 3);
  const jan4 = { year: thu.year, month: 1, day: 4 };
  const jan4Monday = addDays(jan4, 1 - isoWeekday(jan4));
  const diffDays = Math.round(
    (Date.UTC(thu.year, thu.month - 1, thu.day) - Date.UTC(jan4Monday.year, jan4Monday.month - 1, jan4Monday.day)) /
      86400000,
  );
  const week = Math.floor(diffDays / 7) + 1;
  return `${thu.year}-W${pad(week)}`;
}

function dayLabel(d: LocalDate): string {
  return `${MONTHS[d.month - 1]} ${d.day}, ${d.year}`;
}

/**
 * The eligible window for a horizon "as of" a given instant: the immediately
 * preceding, fully completed period in the user's time zone.
 */
export function windowFor(horizon: Horizon, now: Date, timeZone: string): PeriodWindow {
  const today = localDateOf(now, timeZone);
  let startDate: LocalDate;
  let endDate: LocalDate;
  let periodKey: string;
  let label: string;

  switch (horizon) {
    case "daily": {
      endDate = today;
      startDate = addDays(today, -1);
      periodKey = formatLocalDate(startDate);
      label = dayLabel(startDate);
      break;
    }
    case "weekly": {
      const thisMonday = addDays(today, 1 - isoWeekday(today));
      endDate = thisMonday;
      startDate = addDays(thisMonday, -7);
      periodKey = isoWeekKey(startDate);
      const last = addDays(endDate, -1);
      label =
        startDate.month === last.month
          ? `${MONTHS[startDate.month - 1]} ${startDate.day} – ${last.day}, ${last.year}`
          : `${MONTHS[startDate.month - 1]} ${startDate.day} – ${MONTHS[last.month - 1]} ${last.day}, ${last.year}`;
      break;
    }
    case "monthly": {
      endDate = { year: today.year, month: today.month, day: 1 };
      startDate =
        today.month === 1
          ? { year: today.year - 1, month: 12, day: 1 }
          : { year: today.year, month: today.month - 1, day: 1 };
      periodKey = `${startDate.year}-${pad(startDate.month)}`;
      label = `${MONTHS[startDate.month - 1]} ${startDate.year}`;
      break;
    }
    case "yearly": {
      endDate = { year: today.year, month: 1, day: 1 };
      startDate = { year: today.year - 1, month: 1, day: 1 };
      periodKey = String(startDate.year);
      label = String(startDate.year);
      break;
    }
    case "decade": {
      const currentDecadeStart = Math.floor(today.year / 10) * 10;
      endDate = { year: currentDecadeStart, month: 1, day: 1 };
      startDate = { year: currentDecadeStart - 10, month: 1, day: 1 };
      periodKey = `${startDate.year}s`;
      label = `${startDate.year}–${currentDecadeStart - 1}`;
      break;
    }
  }

  return {
    horizon,
    timeZone,
    startDate,
    endDate,
    startUtc: localMidnightUtc(startDate, timeZone),
    endUtc: localMidnightUtc(endDate, timeZone),
    periodKey,
    label,
  };
}

export function allWindows(now: Date, timeZone: string): Record<Horizon, PeriodWindow> {
  return Object.fromEntries(HORIZONS.map((h) => [h, windowFor(h, now, timeZone)])) as Record<Horizon, PeriodWindow>;
}

export type DatePrecision = "day" | "month" | "year" | "unknown";

export function compareLocal(a: LocalDate, b: LocalDate): number {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

/**
 * Whether a work whose publication date is known only to `precision` fits
 * entirely inside the window. Ambiguous dates are admitted only when the whole
 * possible interval fits; a year-only record never qualifies for a daily shelf.
 */
export function publicationFits(published: LocalDate, precision: DatePrecision, w: PeriodWindow): boolean {
  if (precision === "unknown") return false;
  let lo: LocalDate;
  let hiExclusive: LocalDate;
  if (precision === "day") {
    lo = published;
    hiExclusive = addDays(published, 1);
  } else if (precision === "month") {
    lo = { year: published.year, month: published.month, day: 1 };
    hiExclusive =
      published.month === 12
        ? { year: published.year + 1, month: 1, day: 1 }
        : { year: published.year, month: published.month + 1, day: 1 };
  } else {
    lo = { year: published.year, month: 1, day: 1 };
    hiExclusive = { year: published.year + 1, month: 1, day: 1 };
  }
  return compareLocal(lo, w.startDate) >= 0 && compareLocal(hiExclusive, w.endDate) <= 0;
}

/** Validate an IANA zone name using Intl. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
