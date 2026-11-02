import { describe, expect, it } from "bun:test";
import { Vaultbase } from "../src/index.ts";
import { MemoryAuthStore } from "../src/auth/store.ts";
import { generateTypes } from "../src/codegen/generate.ts";
import type { CollectionTypes } from "../src/types.ts";

interface RevenueRecord { id: string; total: number }
type RevenueParams = { since?: string | Date | number; status: string };
type Schema = {
  revenue: CollectionTypes<RevenueRecord, never, never> & { params: RevenueParams };
};

function client(seen: string[]): Vaultbase<Schema> {
  return new Vaultbase<Schema>({
    baseUrl: "http://localhost",
    authStore: new MemoryAuthStore(),
    fetch: ((req: Request | string, init?: RequestInit) => {
      const r = typeof req === "string" ? new Request(req, init) : req;
      seen.push(decodeURIComponent(new URL(r.url).search));
      const body = r.url.includes("/_aggregate") ? { data: [] } : r.url.includes("/revenue/") ? { data: { id: "u1", total: 1 } }
        : { data: [{ id: "u1", total: 1 }], page: 1, perPage: 30, totalItems: 1, totalPages: 1 };
      return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
    }) as typeof fetch,
  });
}

describe("view parameters", () => {
  it("are sent as params[name] on list, get, iterate and aggregate", async () => {
    const seen: string[] = [];
    const vb = client(seen);
    const since = new Date(Date.UTC(2026, 9, 1));
    await vb.collection("revenue").list({ params: { since, status: "paid" }, sort: "-total" });
    await vb.collection("revenue").get("u1", { params: { status: "void" } });
    for await (const _ of vb.collection("revenue").iterate({ params: { status: "paid", since: 1767225600 } })) { /* one page */ }
    await vb.collection("revenue").aggregate({ agg: "sum(total)", params: { status: "paid" } });
    expect(seen[0]).toContain("params[since]=2026-10-01T00:00:00.000Z");
    expect(seen[0]).toContain("params[status]=paid");
    expect(seen[1]).toBe("?params[status]=void");
    expect(seen[2]).toContain("params[since]=1767225600");
    expect(seen[3]).toContain("params[status]=paid");
  });

  it("are typed from the schema", () => {
    const vb = client([]);
    // @ts-expect-error status is required
    void vb.collection("revenue").list({ params: { since: "2026-01-01" } });
    // @ts-expect-error status is text
    void vb.collection("revenue").list({ params: { status: 5 } });
    void vb.collection("revenue").list({ params: { status: "paid" } });
    // An untyped collection takes any.
    void vb.collection("other").list({ params: { anything: true } });
  });
});

describe("vb-types", () => {
  it("emits a params type for a view's settable parameters", () => {
    const out = generateTypes({
      collections: [{
        name: "revenue", type: "view", fields: JSON.stringify([{ name: "total", type: "number" }]),
        view_params: JSON.stringify([
          { name: "since", type: "date", default: 0 },
          { name: "status", type: "text", required: true },
          { name: "min", type: "number" },
          { name: "paid", type: "bool" },
          { name: "me", type: "text", from: "auth.id" },
        ]),
      }],
    });
    expect(out).toContain("export type RevenueParams = {\n  since?: string | Date | number;\n  status: string;\n  min?: number;\n  paid?: boolean;\n};");
    expect(out).not.toContain(" me");
    expect(out).toContain("revenue: { record: RevenueRecord; create: never; update: never; params: RevenueParams };");
  });

  it("takes the list form a snapshot has, and none for a view without", () => {
    const out = generateTypes({
      collections: [
        { name: "a", type: "view", fields: "[]", view_params: [{ name: "x", type: "text" }] },
        { name: "b", type: "view", fields: "[]" },
      ],
    });
    expect(out).toContain("export type AParams = {\n  x?: string;\n};");
    expect(out).toContain("b: { record: BRecord; create: never; update: never };");
  });
});
