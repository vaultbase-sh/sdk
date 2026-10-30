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

  it("auth collection injects email and the account flags as the server returns them", () => {
    const out = generateTypes({
      collections: [{
        name: "users",
        type: "auth",
        fields: JSON.stringify([]),
      }],
    });
    expect(out).toContain("email: string;");
    expect(out).toContain("email_verified: number;");
    expect(out).toContain("is_anonymous: number;");
    expect(out).not.toMatch(/\bverified: boolean/);
  });

  it("doesn't repeat email / verified when a snapshot lists them as implicit fields", () => {
    const out = generateTypes({
      collections: [{
        name: "users",
        type: "auth",
        fields: [
          { name: "email", type: "email", required: true, implicit: true, options: { unique: true } },
          { name: "verified", type: "bool", required: false, implicit: true },
          { name: "name", type: "text" },
        ],
      }],
    } as never);
    const record = out.slice(out.indexOf("interface UsersRecord"), out.indexOf("interface UsersCreate"));
    expect(record.match(/\bverified\b/g)).toBeNull();
    expect(record.match(/\bemail_verified\b/g)).toHaveLength(1);
    expect(record.match(/\bemail\b/g)).toHaveLength(1);
    expect(record).toContain("name?: string | null;");
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

  it("singleton collection: record + update types, no create entry, marked singleton", () => {
    const out = generateTypes({
      collections: [{
        name: "site_settings",
        type: "singleton",
        fields: JSON.stringify([
          { name: "title", type: "text", required: true },
          { name: "maintenance", type: "bool" },
        ]),
      }],
    });
    const record = out.slice(out.indexOf("export interface SiteSettingsRecord"), out.indexOf("export interface SiteSettingsCreate"));
    expect(record).toContain("id: string;");
    // The record is created with its fields empty, so even required fields may be null.
    expect(record).toContain("title?: string | null;");
    expect(record).toContain("maintenance?: boolean | null;");
    expect(out).toContain("export type SiteSettingsUpdate = Partial<SiteSettingsCreate>;");
    expect(out).toContain("site_settings: { record: SiteSettingsRecord; create: never; update: SiteSettingsUpdate; singleton: true };");
  });

  it("base collections carry no singleton marker", () => {
    const out = generateTypes({
      collections: [{ name: "posts", type: "base", fields: "[]" }],
    });
    expect(out).toContain("posts: { record: PostsRecord; create: PostsCreate; update: PostsUpdate };");
    expect(out).not.toContain("singleton");
  });
  it("types group fields as their items, list and single object", () => {
    const out = generateTypes({
      collections: [{
        name: "orders",
        type: "base",
        fields: JSON.stringify([
          { name: "items", type: "group", required: true, options: { fields: [
            { name: "sku", type: "text", required: true },
            { name: "qty", type: "number", required: true },
            { name: "size", type: "select", options: { values: ["S", "M"] } },
            { name: "due", type: "date" },
          ] } },
          { name: "address", type: "group", options: { multiple: false, fields: [
            { name: "city", type: "text", required: true },
            { name: "zip", type: "text" },
          ] } },
        ]),
      }],
    });
    const record = out.slice(out.indexOf("export interface OrdersRecord"), out.indexOf("export interface OrdersCreate"));
    const create = out.slice(out.indexOf("export interface OrdersCreate"));
    expect(record).toContain('items: Array<{ id: string; sku: string; qty: number; size?: "S" | "M"; due?: number }>;');
    expect(record).toContain("address?: { city: string; zip?: string } | null;");
    expect(create).toContain('items: Array<{ id?: string | null; sku: string; qty: number; size?: "S" | "M" | null; due?: string | number | null }>;');
    expect(create).toContain("address?: { city: string; zip?: string | null } | null;");
  });
});
