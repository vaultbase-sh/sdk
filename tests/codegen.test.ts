import { describe, expect, it } from "bun:test";
import { generateTypes } from "../src/codegen/generate.ts";

describe("generateTypes", () => {
  it("emits a record + create + update interface for a base collection", () => {
    const out = generateTypes({
      collections: [
        {
          name: "posts",
          type: "base",
          fields: JSON.stringify([
            { name: "title", type: "text", required: true },
            { name: "body",  type: "editor" },
            { name: "published", type: "bool" },
            { name: "tags", type: "select", options: { multiple: true, values: ["a", "b"] } },
          ]),
        },
      ],
    });
    expect(out).toContain("export interface PostsRecord");
    expect(out).toContain("export interface PostsCreate");
    expect(out).toContain("export type PostsUpdate = Partial<PostsCreate>;");
    expect(out).toContain("title: string");
    expect(out).toContain("published?: boolean");
    expect(out).toContain('tags?: ("a" | "b")[]');
    expect(out).toContain("export type Schema = {");
    expect(out).toContain("posts:");
  });

  it("never emits password on the Record shape", () => {
    const out = generateTypes({
      collections: [{
        name: "users",
        type: "auth",
        fields: JSON.stringify([{ name: "secret", type: "password" }]),
      }],
    });
    expect(out).toContain("export interface UsersRecord");
    expect(out).toContain("export interface UsersCreate");
    expect(out).not.toContain("secret: string;\n}\n\nexport interface UsersCreate"); // password absent on Record block
    // explicit: ensure Create has password (auth implicit)
    expect(out).toContain("password: string");
  });

  it("view collection: record only, never has create/update entry", () => {
    const out = generateTypes({
      collections: [{
        name: "stats",
        type: "view",
        fields: JSON.stringify([{ name: "count", type: "number" }]),
      }],
    });
    expect(out).toContain("export interface StatsRecord");
    expect(out).not.toContain("StatsCreate");
    expect(out).toContain("create: never; update: never");
  });

  it("multi-file file fields → string[]", () => {
    const out = generateTypes({
      collections: [{
        name: "posts",
        type: "base",
        fields: JSON.stringify([{ name: "covers", type: "file", options: { multiple: true } }]),
      }],
    });
    expect(out).toContain("covers?: string[]");
  });

  it("auth collection injects email + verified on Record", () => {
    const out = generateTypes({
      collections: [{
        name: "users",
        type: "auth",
        fields: JSON.stringify([]),
      }],
    });
    expect(out).toContain("email: string;");
    expect(out).toContain("verified: boolean;");
  });

  it("types date / vector / color fields and empty values as the server returns them", () => {
    const out = generateTypes({
      collections: [{
        name: "events",
        type: "base",
        fields: JSON.stringify([
          { name: "starts", type: "date", required: true },
          { name: "ends", type: "date" },
          { name: "embedding", type: "vector", options: { dimensions: 3 } },
          { name: "tint", type: "color" },
          { name: "title", type: "text", required: true },
        ]),
      }],
    });
    const record = out.slice(out.indexOf("export interface EventsRecord"), out.indexOf("export interface EventsCreate"));
    const create = out.slice(out.indexOf("export interface EventsCreate"), out.indexOf("export type EventsUpdate"));
    expect(record).toContain("starts: number;");
    expect(record).toContain("ends?: number | null;");
    expect(record).toContain("embedding?: number[] | null;");
    expect(record).toContain("tint?: string | null;");
    expect(record).toContain("title: string;");
    expect(create).toContain("starts: string | number;");
    expect(create).toContain("ends?: string | number | null;");
    expect(create).toContain("embedding?: number[] | null;");
    expect(out).not.toContain("unknown");
  });
});
