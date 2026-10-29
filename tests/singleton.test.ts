import { describe, expect, it } from "bun:test";
import { Vaultbase } from "../src/index.ts";
import { Singleton } from "../src/singleton.ts";
import { MemoryAuthStore } from "../src/auth/store.ts";
import { VaultbaseError } from "../src/errors.ts";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface SettingsRecord { id: string; created: number; updated: number; theme?: string | null; beta?: boolean | null }
interface SettingsCreate { theme?: string | null; beta?: boolean | null }
type SettingsUpdate = Partial<SettingsCreate>;
interface PostRecord { id: string; title: string }

type TestSchema = {
  settings: { record: SettingsRecord; create: never; update: SettingsUpdate; singleton: true };
  posts: { record: PostRecord; create: { title: string }; update: { title?: string } };
};

function json(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.etag) headers.etag = init.etag;
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function makeVb(handler: (cap: Captured) => Response): { vb: Vaultbase<TestSchema>; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetcher = ((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const cap: Captured = {
      url: u,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(cap);
    return Promise.resolve(handler(cap));
  }) as typeof fetch;
  const vb = new Vaultbase<TestSchema>({ baseUrl: "http://localhost", authStore: new MemoryAuthStore(), fetch: fetcher });
  return { vb, calls };
}

const RECORD: SettingsRecord = { id: "s1", created: 1, updated: 1, theme: null, beta: null };

describe("vb.singleton()", () => {
  it("returns a Singleton accessor", () => {
    const { vb } = makeVb(() => json({ data: RECORD }));
    expect(vb.singleton("settings")).toBeInstanceOf(Singleton);
  });

  it("get() reads the collection path and unwraps the record", async () => {
    const { vb, calls } = makeVb(() => json({ data: RECORD }, { etag: `W/"1"` }));
    const r = await vb.singleton("settings").get();
    expect(r.id).toBe("s1");
    expect(r.theme).toBeNull();
    expect(calls[0]?.method).toBe("GET");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/settings");
  });

  it("get() passes expand and fields through", async () => {
    const { vb, calls } = makeVb(() => json({ data: RECORD }));
    await vb.singleton("settings").get({ expand: "owner", fields: "id,theme" });
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("expand")).toBe("owner");
    expect(u.searchParams.get("fields")).toBe("id,theme");
  });

  it("update() PATCHes the collection path with the body", async () => {
    const { vb, calls } = makeVb(() => json({ data: { ...RECORD, theme: "dark" } }, { etag: `W/"2"` }));
    const r = await vb.singleton("settings").update({ theme: "dark" });
    expect(r.theme).toBe("dark");
    expect(calls[0]?.method).toBe("PATCH");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/settings");
    expect(calls[0]?.body).toEqual({ theme: "dark" });
  });

  it("update() auto-attaches the ETag from the last get, then from the last update", async () => {
    let n = 0;
    const { vb, calls } = makeVb((cap) => {
      n++;
      return json({ data: RECORD }, { etag: cap.method === "GET" ? `W/"get"` : `W/"upd-${n}"` });
    });
    const s = vb.singleton("settings");
    await s.update({ beta: true });
    expect(calls[0]?.headers["If-Match"]).toBeUndefined(); // nothing cached yet
    await s.get();
    await s.update({ beta: false });
    expect(calls[2]?.headers["If-Match"]).toBe(`W/"get"`);
    await s.update({ beta: true }, { ifMatch: "auto" });
    expect(calls[3]?.headers["If-Match"]).toBe(`W/"upd-3"`);
    // A fresh accessor for the same name shares the client's cache.
    await vb.singleton("settings").update({ beta: true });
    expect(calls[4]?.headers["If-Match"]).toBe(`W/"upd-4"`);
  });

  it("explicit ifMatch overrides the cache; false sends none", async () => {
    const { vb, calls } = makeVb(() => json({ data: RECORD }, { etag: `W/"cached"` }));
    const s = vb.singleton("settings");
    await s.get();
    await s.update({ theme: "x" }, { ifMatch: `W/"explicit"` });
    expect(calls[1]?.headers["If-Match"]).toBe(`W/"explicit"`);
    await s.update({ theme: "y" }, { ifMatch: false });
    expect(calls[2]?.headers["If-Match"]).toBeUndefined();
  });

  it("412 surfaces as VaultbaseError(precondition_failed) with currentEtag", async () => {
    const { vb } = makeVb(() => json({ error: "Precondition Failed", code: 412 }, { status: 412, etag: `W/"99"` }));
    try {
      await vb.singleton("settings").update({ theme: "x" }, { ifMatch: `W/"stale"` });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VaultbaseError);
      expect((e as VaultbaseError).kind).toBe("precondition_failed");
      const data = (e as VaultbaseError).data as { kind: "precondition_failed"; currentEtag?: string };
      expect(data.currentEtag).toBe(`W/"99"`);
    }
  });

  it("is typed from the Schema", async () => {
    const { vb } = makeVb(() => json({ data: RECORD }));
    const s = vb.singleton("settings");
    const r: SettingsRecord = await s.get();
    void r;
    // @ts-expect-error theme is a string
    await s.update({ theme: 1 });
    // Untyped names fall back to an any-record accessor, as collection() does.
    await vb.singleton<{ id: string; n: number }>("other").get();
  });
});

describe("collection.get() options", () => {
  it("sends expand and fields as query params", async () => {
    const { vb, calls } = makeVb(() => json({ data: { id: "p1", title: "t" } }));
    await vb.collection("posts").get("p1", { expand: "author", fields: "id,title" });
    expect(calls[0]!.url).toBe("http://localhost/api/v1/posts/p1?expand=author&fields=id%2Ctitle");
  });

  it("sends exclude on get, list and singleton get", async () => {
    const { vb, calls } = makeVb((cap) => json(cap.url.includes("/posts?") ? { data: [], page: 1, perPage: 30, totalItems: 0, totalPages: 0 } : { data: { id: "p1" } }));
    await vb.collection("posts").get("p1", { exclude: "body,meta" });
    await vb.collection("posts").list({ fields: "id,title,body", exclude: "body" });
    await vb.singleton("settings").get({ exclude: "theme" });
    expect(calls[0]!.url).toBe("http://localhost/api/v1/posts/p1?exclude=body%2Cmeta");
    const list = new URL(calls[1]!.url);
    expect(list.searchParams.get("fields")).toBe("id,title,body");
    expect(list.searchParams.get("exclude")).toBe("body");
    expect(new URL(calls[2]!.url).searchParams.get("exclude")).toBe("theme");
  });

  it("sends no query without them", async () => {
    const { vb, calls } = makeVb(() => json({ data: { id: "p1", title: "t" } }));
    await vb.collection("posts").get("p1");
    expect(calls[0]!.url).toBe("http://localhost/api/v1/posts/p1");
  });
});
