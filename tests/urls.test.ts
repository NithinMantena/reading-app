import { describe, expect, it } from "vitest";
import { canonicalizeUrl, isNytUrl } from "@shared/urls";

describe("canonicalizeUrl", () => {
  it("strips tracking parameters, fragments, and www", () => {
    expect(canonicalizeUrl("https://www.Example.com/a/b/?utm_source=x&fbclid=y&id=2#top")).toBe("https://example.com/a/b?id=2");
  });
  it("sorts remaining query parameters so equivalent links collide", () => {
    expect(canonicalizeUrl("https://example.com/p?b=2&a=1")).toBe(canonicalizeUrl("https://example.com/p?a=1&b=2"));
  });
  it("adds https when the scheme is missing", () => {
    expect(canonicalizeUrl("example.com/article")).toBe("https://example.com/article");
  });
  it("rejects non-http schemes", () => {
    expect(() => canonicalizeUrl("javascript:alert(1)")).toThrow();
    expect(() => canonicalizeUrl("file:///etc/passwd")).toThrow();
  });
  it("recognises NYT hosts", () => {
    expect(isNytUrl("https://www.nytimes.com/2026/09/04/business/x.html")).toBe(true);
    expect(isNytUrl("https://cooking.nytimes.com/recipes/1")).toBe(true);
    expect(isNytUrl("https://notnytimes.com/")).toBe(false);
  });
});
