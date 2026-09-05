import { describe, expect, it } from "vitest";
import { allWindows, localMidnightUtc, publicationFits, windowFor } from "@shared/periods";

const NY = "America/New_York";

describe("publication windows (PRD §5 example: September 5, 2026)", () => {
  const now = new Date("2026-09-05T12:00:00-04:00");
  const w = allWindows(now, NY);

  it("daily = previous local calendar day", () => {
    expect(w.daily.periodKey).toBe("2026-09-04");
    expect(w.daily.label).toBe("September 4, 2026");
    expect(w.daily.startUtc.toISOString()).toBe("2026-09-04T04:00:00.000Z");
    expect(w.daily.endUtc.toISOString()).toBe("2026-09-05T04:00:00.000Z");
  });
  it("weekly = previous Monday through Sunday", () => {
    expect(w.weekly.startDate).toEqual({ year: 2026, month: 8, day: 24 });
    expect(w.weekly.endDate).toEqual({ year: 2026, month: 8, day: 31 });
    expect(w.weekly.label).toBe("August 24 – 30, 2026");
    expect(w.weekly.periodKey).toBe("2026-W35");
  });
  it("monthly = previous calendar month", () => {
    expect(w.monthly.periodKey).toBe("2026-08");
    expect(w.monthly.label).toBe("August 2026");
  });
  it("yearly = previous calendar year", () => {
    expect(w.yearly.periodKey).toBe("2025");
  });
  it("decade = previous completed calendar decade", () => {
    expect(w.decade.periodKey).toBe("2010s");
    expect(w.decade.label).toBe("2010–2019");
    expect(w.decade.startDate.year).toBe(2010);
    expect(w.decade.endDate.year).toBe(2020);
  });
});

describe("boundaries", () => {
  it("on a Monday the weekly window is the week that just ended", () => {
    const monday = new Date("2026-09-07T08:00:00-04:00");
    const w = windowFor("weekly", monday, NY);
    expect(w.startDate).toEqual({ year: 2026, month: 8, day: 31 });
    expect(w.endDate).toEqual({ year: 2026, month: 9, day: 7 });
  });
  it("on a Sunday the weekly window is still the previous full week", () => {
    const sunday = new Date("2026-09-06T08:00:00-04:00");
    expect(windowFor("weekly", sunday, NY).startDate).toEqual({ year: 2026, month: 8, day: 24 });
  });
  it("January 1 rolls the yearly and monthly windows", () => {
    const jan1 = new Date("2027-01-01T07:30:00-05:00");
    expect(windowFor("yearly", jan1, NY).periodKey).toBe("2026");
    expect(windowFor("monthly", jan1, NY).periodKey).toBe("2026-12");
    expect(windowFor("daily", jan1, NY).periodKey).toBe("2026-12-31");
  });
  it("the decade shelf stays on the 2010s until January 1, 2030", () => {
    expect(windowFor("decade", new Date("2029-12-31T23:00:00-05:00"), NY).periodKey).toBe("2010s");
    expect(windowFor("decade", new Date("2030-01-01T07:00:00-05:00"), NY).periodKey).toBe("2020s");
  });
  it("local time zone decides the day (late evening UTC is still 'today' in New York)", () => {
    const lateUtc = new Date("2026-09-05T02:30:00Z"); // 22:30 on Sep 4 in New York
    expect(windowFor("daily", lateUtc, NY).periodKey).toBe("2026-09-03");
    expect(windowFor("daily", lateUtc, "UTC").periodKey).toBe("2026-09-04");
  });
  it("leap day is a real window", () => {
    const w = windowFor("daily", new Date("2028-03-01T12:00:00Z"), "UTC");
    expect(w.periodKey).toBe("2028-02-29");
  });
  it("DST change: the window spans 23 hours but boundaries are local midnights", () => {
    // US DST starts 2026-03-08 in New York.
    const start = localMidnightUtc({ year: 2026, month: 3, day: 8 }, NY);
    const end = localMidnightUtc({ year: 2026, month: 3, day: 9 }, NY);
    expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect((end.getTime() - start.getTime()) / 3600000).toBe(23);
  });
  it("ISO week numbering around the new year", () => {
    // Jan 4, 2027 is a Monday; the week before (Dec 28 – Jan 3) is 2026-W53.
    expect(windowFor("weekly", new Date("2027-01-04T12:00:00Z"), "UTC").periodKey).toBe("2026-W53");
  });
});

describe("publicationFits (PRD A4: ambiguous dates must fit entirely)", () => {
  const now = new Date("2026-09-05T12:00:00Z");
  it("a day-precise date inside the window fits", () => {
    expect(publicationFits({ year: 2026, month: 9, day: 4 }, "day", windowFor("daily", now, "UTC"))).toBe(true);
    expect(publicationFits({ year: 2026, month: 9, day: 5 }, "day", windowFor("daily", now, "UTC"))).toBe(false);
  });
  it("a month-only date never fits a daily window but fits the matching monthly window", () => {
    expect(publicationFits({ year: 2026, month: 8, day: 1 }, "month", windowFor("daily", now, "UTC"))).toBe(false);
    expect(publicationFits({ year: 2026, month: 8, day: 1 }, "month", windowFor("monthly", now, "UTC"))).toBe(true);
    expect(publicationFits({ year: 2026, month: 8, day: 1 }, "month", windowFor("weekly", now, "UTC"))).toBe(false);
  });
  it("a year-only date fits yearly and decade windows only when the whole year is inside", () => {
    expect(publicationFits({ year: 2025, month: 1, day: 1 }, "year", windowFor("yearly", now, "UTC"))).toBe(true);
    expect(publicationFits({ year: 2026, month: 1, day: 1 }, "year", windowFor("yearly", now, "UTC"))).toBe(false);
    expect(publicationFits({ year: 2019, month: 1, day: 1 }, "year", windowFor("decade", now, "UTC"))).toBe(true);
    expect(publicationFits({ year: 2020, month: 1, day: 1 }, "year", windowFor("decade", now, "UTC"))).toBe(false);
    expect(publicationFits({ year: 2025, month: 1, day: 1 }, "year", windowFor("monthly", now, "UTC"))).toBe(false);
  });
  it("unknown precision never qualifies", () => {
    expect(publicationFits({ year: 2026, month: 9, day: 4 }, "unknown", windowFor("daily", now, "UTC"))).toBe(false);
  });
});
