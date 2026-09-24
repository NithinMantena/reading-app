import { describe, expect, it } from "vitest";
import { pickCover } from "../src/lib/openlibrary";

describe("pickCover", () => {
  const book = { title: "The Origin of Species", authors: ["Charles Darwin"] };

  it("matches title (ignoring articles and subtitles) and author surname", () => {
    expect(pickCover(book, [
      { title: "Origin of Species", author_name: ["Someone Else"], cover_i: 1 },
      { title: "On the Origin of Species", author_name: ["Charles Darwin"], cover_i: 2 },
      { title: "The Origin of Species: By Means of Natural Selection", author_name: ["Charles Darwin"], cover_i: 3 },
    ])).toBe(3);
  });

  it("skips results without a cover and refuses unrelated titles", () => {
    expect(pickCover(book, [{ title: "The Origin of Species", author_name: ["Charles Darwin"] }])).toBeNull();
    expect(pickCover({ title: "Dune", authors: ["Frank Herbert"] }, [{ title: "Dune Messiah", author_name: ["Frank Herbert"], cover_i: 9 }])).toBeNull();
  });

  it("accepts a title-only match when the author is unknown", () => {
    expect(pickCover({ title: "Meditations", authors: [] }, [{ title: "Meditations", author_name: ["Marcus Aurelius"], cover_i: 5 }])).toBe(5);
  });
});

describe("pickCover author tolerance", () => {
  it("accepts small surname typos and run-together names", () => {
    expect(pickCover({ title: "Thinking Fast and Slow", authors: ["Daniel Khaneman"] }, [{ title: "Thinking, Fast and Slow", author_name: ["Daniel Kahneman"], cover_i: 7 }])).toBe(7);
    expect(pickCover({ title: "The Snowball", authors: ["AliceSchroeder"] }, [{ title: "The Snowball", author_name: ["Alice Schroeder"], cover_i: 8 }])).toBe(8);
  });
  it("still rejects a different author", () => {
    expect(pickCover({ title: "The Snowball", authors: ["Alice Schroeder"] }, [{ title: "The Snowball", author_name: ["Mary Brown"], cover_i: 8 }])).toBeNull();
  });
});
