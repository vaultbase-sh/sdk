import { describe, expect, it } from "bun:test";
import { HttpClient, EtagCache } from "../src/client.ts";
import { Collection } from "../src/collection.ts";
import { MemoryAuthStore } from "../src/auth/store.ts";
import { VaultbaseError } from "../src/errors.ts";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function makeClient(handler: (cap: Captured) => Response): { client: HttpClient; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetcher = ((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const cap: Captured = {
      url: u,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    };
    calls.push(cap);
    return Promise.resolve(handler(cap));
  }) as typeof fetch;

  return {
    client: new HttpClient({
      baseUrl: "http://localhost",
      authStore: new MemoryAuthStore(),
      fetch: fetcher,
    }),
    calls,
  };
}

describe("EtagCache", () => {
  it("stores and retrieves per-record entries", () => {
    const c = new EtagCache();
    c.set("posts", "p1", `W/"123"`);
    expect(c.get("posts", "p1")).toBe(`W/"123"`);
    c.delete("posts", "p1");
    expect(c.get("posts", "p1")).toBeUndefined();
  });

  it("clear() removes everything", () => {
    const c = new EtagCache();
    c.set("a", "1", "x"); c.set("b", "2", "y");
    c.clear();
    expect(c.get("a", "1")).toBeUndefined();
    expect(c.get("b", "2")).toBeUndefined();
  });
});

describe("HttpClient ETag capture", () => {
  it("captures ETag from /api/<col>/<id> responses", async () => {
    const { client } = makeClient(() => new Response(JSON.stringify({ data: { id: "p1" } }), {
      headers: { "content-type": "application/json", etag: `W/"42"` },
    }));
    await client.request("/api/v1/posts/p1");
    expect(client.etags.get("posts", "p1")).toBe(`W/"42"`);
  });

  it("does NOT capture from list endpoints", async () => {
    const { client } = makeClient(() => new Response(JSON.stringify({ data: [] }), {
      headers: { "content-type": "application/json", etag: `W/"99"` },
    }));
    await client.request("/api/v1/posts");
    expect(client.etags.get("posts", "")).toBeUndefined();
  });

  it("does NOT capture from sub-resource paths", async () => {
    const { client } = makeClient(() => new Response(JSON.stringify({ data: [] }), {
      headers: { "content-type": "application/json", etag: `W/"99"` },
    }));
    await client.request("/api/v1/posts/p1/history");
    expect(client.etags.get("posts", "p1")).toBeUndefined();
  });
});

describe("Collection auto-attaches If-Match", () => {
  it("update auto-attaches the cached ETag", async () => {
    const { client, calls } = makeClient((cap) => {
      if (cap.method === "PATCH") {
        return new Response(JSON.stringify({ data: { id: "p1", title: "v2" } }), {
          headers: { "content-type": "application/json", etag: `W/"43"` },
        });
      }
      return new Response(JSON.stringify({ data: { id: "p1", title: "v1" } }), {
        headers: { "content-type": "application/json", etag: `W/"42"` },
      });
    });
    const col = new Collection(client, "posts");
    await col.get("p1");
    await col.update("p1", { title: "v2" });
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.headers["If-Match"]).toBe(`W/"42"`);
    // After successful update, cache picks up the new tag.
    expect(client.etags.get("posts", "p1")).toBe(`W/"43"`);
  });

  it("ifMatch=false skips the precondition", async () => {
    const { client, calls } = makeClient(() => new Response(JSON.stringify({ data: {} }), {
      headers: { "content-type": "application/json" },
    }));
    client.etags.set("posts", "p1", `W/"7"`);
    const col = new Collection(client, "posts");
    await col.update("p1", { title: "x" }, { ifMatch: false });
    expect(calls[0]?.headers["If-Match"]).toBeUndefined();
  });

  it("explicit ifMatch string overrides the cache", async () => {
    const { client, calls } = makeClient(() => new Response(JSON.stringify({ data: {} }), {
      headers: { "content-type": "application/json" },
    }));
    client.etags.set("posts", "p1", `W/"cached"`);
    const col = new Collection(client, "posts");
    await col.update("p1", { title: "x" }, { ifMatch: `W/"explicit"` });
    expect(calls[0]?.headers["If-Match"]).toBe(`W/"explicit"`);
  });

  it("ifMatch \"auto\" resolves from the cache, never as a literal ETag", async () => {
    const { client, calls } = makeClient(() => new Response(JSON.stringify({ data: {} }), {
      headers: { "content-type": "application/json" },
    }));
    const col = new Collection(client, "posts");
    await col.update("p1", { title: "x" }, { ifMatch: "auto" });
    expect(calls[0]?.headers["If-Match"]).toBeUndefined();
    client.etags.set("posts", "p1", `W/"42"`);
    await col.update("p1", { title: "y" }, { ifMatch: "auto" });
    await col.delete("p1", { ifMatch: "auto" });
    expect(calls[1]?.headers["If-Match"]).toBe(`W/"42"`);
    expect(calls[2]?.headers["If-Match"]).toBe(`W/"42"`);
  });

  it("delete auto-attaches and invalidates the cache on success", async () => {
    const { client, calls } = makeClient(() => new Response(JSON.stringify({ data: null }), {
      headers: { "content-type": "application/json" },
    }));
    client.etags.set("posts", "p1", `W/"42"`);
    const col = new Collection(client, "posts");
    await col.delete("p1");
    expect(calls[0]?.headers["If-Match"]).toBe(`W/"42"`);
    expect(client.etags.get("posts", "p1")).toBeUndefined();
  });

  it("412 response surfaces as VaultbaseError(precondition_failed) with currentEtag", async () => {
    const { client } = makeClient(() => new Response(JSON.stringify({ error: "Precondition Failed", code: 412 }), {
      status: 412,
      headers: { "content-type": "application/json", etag: `W/"99"` },
    }));
    client.etags.set("posts", "p1", `W/"42"`);
    const col = new Collection(client, "posts");
    try {
      await col.update("p1", { title: "x" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VaultbaseError);
      expect((e as VaultbaseError).kind).toBe("precondition_failed");
      const data = (e as VaultbaseError).data as { kind: "precondition_failed"; currentEtag?: string };
      expect(data.currentEtag).toBe(`W/"99"`);
    }
  });
});
