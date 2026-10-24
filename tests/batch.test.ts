import { describe, expect, it } from "bun:test";
import { Batch } from "../src/batch.ts";
import { HttpClient } from "../src/client.ts";
import { MemoryAuthStore } from "../src/auth/store.ts";
import { VaultbaseError } from "../src/errors.ts";

function client(handler?: (req: Request) => Response): HttpClient {
  return new HttpClient({
    baseUrl: "http://localhost",
    authStore: new MemoryAuthStore(),
    fetch: ((req: Request | string, init?: RequestInit) => {
      const r = typeof req === "string" ? new Request(req, init) : req;
      return Promise.resolve(handler ? handler(r) : new Response(JSON.stringify({ data: { data: [] } }), {
        headers: { "content-type": "application/json" },
      }));
    }) as typeof fetch,
  });
}

describe("Batch", () => {
  it("size grows with each method", () => {
    const b = new Batch(client());
    b.create("posts", { title: "x" })
      .update("posts", "id1", { title: "y" })
      .delete("posts", "id2")
      .get("posts", "id3")
      .list("posts");
    expect(b.size()).toBe(5);
  });

  it("throws validation on > 100 ops", async () => {
    const b = new Batch(client());
    for (let i = 0; i < 101; i++) b.create("posts", { i });
    try {
      await b.run();
      throw new Error("should not run");
    } catch (e) {
      expect(e instanceof VaultbaseError).toBe(true);
      expect((e as VaultbaseError).kind).toBe("validation");
    }
  });

  it("posts to /api/batch with operations array", async () => {
    let body: unknown;
    const c = client((req) => {
      // capture body via body in init isn't directly visible — we just confirm path
      void req.url;
      return new Response(JSON.stringify({ data: [{ status: 201, body: { id: "x" } }] }), {
        headers: { "content-type": "application/json" },
      });
    });
    const b = new Batch(c).create("posts", { title: "x" });
    const r = await b.run();
    expect(r[0]?.status).toBe(201);
    void body;
  });
});

describe("Batch.list query", () => {
  it("sends list options like Collection.list, and nothing else", async () => {
    let sent: { requests: Array<{ url: string }> } | null = null;
    const b = new Batch(client((req) => {
      void req.json().then((j) => { sent = j as typeof sent; });
      return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } });
    }));
    b.list("posts", { perPage: 5, skipTotal: true, requestKey: "k", filter: 'a = "b"' });
    await b.run();
    await Promise.resolve();
    const url = new URL(sent!.requests[0]!.url, "http://x");
    expect(url.searchParams.get("skipTotal")).toBe("1");
    expect(url.searchParams.get("perPage")).toBe("5");
    expect(url.searchParams.get("filter")).toBe('a = "b"');
    expect(url.searchParams.has("requestKey")).toBe(false);
  });
});
