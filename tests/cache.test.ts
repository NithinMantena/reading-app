import { beforeEach, describe, expect, it } from "vitest";
import { clearCache, getCached, invalidate, mutate, prefetch, revalidate, setCached } from "../src/lib/cache";

describe("cache", () => {
  beforeEach(() => clearCache());

  it("stores and returns values synchronously", () => {
    setCached("k", { a: 1 });
    expect(getCached("k")).toEqual({ a: 1 });
    expect(getCached("missing")).toBeUndefined();
  });

  it("deduplicates concurrent revalidations", async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return calls; };
    const [a, b] = await Promise.all([revalidate("dedupe", fetcher), revalidate("dedupe", fetcher)]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
    expect(getCached("dedupe")).toBe(1);
  });

  it("mutates in place and is a no-op when nothing is cached", () => {
    mutate<number>("none", (n) => n + 1);
    expect(getCached("none")).toBeUndefined();
    setCached("n", 1);
    mutate<number>("n", (n) => n + 1);
    expect(getCached("n")).toBe(2);
  });

  it("prefetch only fetches when the key is empty", async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return "v"; };
    prefetch("p", fetcher);
    await new Promise((r) => setTimeout(r, 0));
    prefetch("p", fetcher);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    expect(getCached("p")).toBe("v");
  });

  it("invalidate drops unwatched keys by prefix, including nested ones", async () => {
    await revalidate("books:all", async () => 1);
    await revalidate("books:one:x", async () => 2);
    await revalidate("readings:all", async () => 3);
    invalidate("books");
    expect(getCached("books:all")).toBeUndefined();
    expect(getCached("books:one:x")).toBeUndefined();
    expect(getCached("readings:all")).toBe(3);
    // A prefix must match a whole segment: "book" does not touch "books:*".
    await revalidate("books:all", async () => 1);
    invalidate("book");
    expect(getCached("books:all")).toBe(1);
  });
});
