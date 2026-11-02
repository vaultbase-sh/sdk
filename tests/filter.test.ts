import { describe, expect, it } from "bun:test";
import { q, field, rawFilter, type Filter } from "../src/filter.ts";

const s = (f: Filter): string => f as string;

describe("q (tagged-template filter)", () => {
  it("escapes string values with double quotes", () => {
    expect(s(q`title = ${"hello"}`)).toBe(`title = "hello"`);
  });

  it("escapes embedded backslashes and quotes", () => {
    expect(s(q`name = ${'a"b\\c'}`)).toBe(`name = "a\\"b\\\\c"`);
  });

  it("inlines numbers bare", () => {
    expect(s(q`age >= ${30}`)).toBe("age >= 30");
    expect(s(q`pi = ${3.14}`)).toBe("pi = 3.14");
  });

  it("rejects non-finite numbers", () => {
    expect(() => q`x = ${NaN}`).toThrow();
    expect(() => q`x = ${Infinity}`).toThrow();
  });

  it("encodes booleans + null", () => {
    expect(s(q`done = ${true}`)).toBe("done = true");
    expect(s(q`done = ${false}`)).toBe("done = false");
    expect(s(q`x = ${null}`)).toBe("x = null");
  });

  it("rejects undefined", () => {
    expect(() => q`x = ${undefined}`).toThrow();
  });

  it("encodes Date as ISO string", () => {
    const d = new Date("2026-01-15T00:00:00Z");
    expect(s(q`created > ${d}`)).toBe(`created > "2026-01-15T00:00:00.000Z"`);
  });

  it("refuses arrays: the server has no list value (it answered 400)", () => {
    expect(() => q`status ?= ${["draft", "published"]}`).toThrow();
  });

  it("writes numbers the server can read, without exponents", () => {
    expect(s(q`n > ${1e21}`)).toBe(`n > 1000000000000000000000`);
    expect(s(q`n > ${1e-7}`)).toBe(`n > 0.0000001`);
    expect(s(q`n > ${-2.5}`)).toBe(`n > -2.5`);
    expect(s(q`n > ${42}`)).toBe(`n > 42`);
  });

  it("field() inserts a bare identifier", () => {
    expect(s(q`${field("status")} = ${"published"}`)).toBe(`status = "published"`);
    expect(s(q`${field("author.id")} = ${"u1"}`)).toBe(`author.id = "u1"`);
  });

  it("field() rejects invalid identifiers", () => {
    expect(() => field("bad name")).toThrow();
    expect(() => field("1abc")).toThrow();
    expect(() => field('"; DROP TABLE x; --')).toThrow();
  });

  it("rejects unsupported types (functions, symbols)", () => {
    expect(() => q`x = ${(() => 0) as unknown}`).toThrow();
    expect(() => q`x = ${Symbol("s") as unknown}`).toThrow();
  });

  it("composes parts with literal text in between", () => {
    const term = "foo";
    const status = "published";
    expect(s(q`title ~ ${term} && status = ${status} && deleted = ${false}`))
      .toBe(`title ~ "foo" && status = "published" && deleted = false`);
  });

  it("rawFilter passes through unmodified", () => {
    expect(rawFilter("a = 1") as string).toBe("a = 1");
  });
});
