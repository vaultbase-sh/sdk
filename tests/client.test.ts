import { describe, expect, it } from "bun:test";
import { HttpClient, decodeJwtPayload } from "../src/client.ts";
import { MemoryAuthStore } from "../src/auth/store.ts";
import { VaultbaseError } from "../src/errors.ts";

function makeClient(handler: (req: Request) => Response | Promise<Response>): HttpClient {
  return new HttpClient({
    baseUrl: "http://localhost",
    authStore: new MemoryAuthStore(),
    fetch: ((req: Request | string, init?: RequestInit) => {
      const r = typeof req === "string" ? new Request(req, init) : req;
      return Promise.resolve(handler(r));
    }) as typeof fetch,
  });
}

describe("decodeJwtPayload", () => {
  it("returns null for malformed token", () => {
    expect(decodeJwtPayload("not.a.jwt-really")).toEqual(null);
    expect(decodeJwtPayload("")).toBeNull();
  });

  it("decodes a real-looking JWT payload", () => {
    // Crafted: header.payload.sig (no signature verify)
    const payload = btoa(JSON.stringify({ exp: 1234, id: "u1" })).replace(/=/g, "");
    const token = `aaa.${payload}.bbb`;
    const claims = decodeJwtPayload(token);
    expect(claims?.exp).toBe(1234);
  });
});

describe("HttpClient.request", () => {
  it("unwraps the standard `{ data: ... }` envelope", async () => {
    const c = makeClient(() => new Response(JSON.stringify({ data: { id: "x" } }), {
      headers: { "content-type": "application/json" },
    }));
    const r = await c.request<{ id: string }>("/api/v1/posts");
    expect(r.id).toBe("x");
  });

  it("translates 422 into a VaultbaseError of kind=validation", async () => {
    const c = makeClient(() => new Response(
      JSON.stringify({ error: "bad", details: { email: "required" } }),
      { status: 422, headers: { "content-type": "application/json" } },
    ));
    try {
      await c.request("/api/v1/posts", { method: "POST", body: {} });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e instanceof VaultbaseError).toBe(true);
      const err = e as VaultbaseError;
      expect(err.kind).toBe("validation");
      if (err.data.kind === "validation") {
        expect(err.data.details["email"]).toBe("required");
      }
    }
  });

  it("translates 429 into rate_limit with retryAfterMs", async () => {
    const c = makeClient(() => new Response("", {
      status: 429,
      headers: { "retry-after": "2", "content-type": "application/json" },
    }));
    try {
      await c.request("/api/v1/x");
    } catch (e) {
      expect(e instanceof VaultbaseError).toBe(true);
      const err = e as VaultbaseError;
      expect(err.kind).toBe("rate_limit");
      if (err.data.kind === "rate_limit") {
        expect(err.data.retryAfterMs).toBe(2000);
      }
    }
  });

  it("attaches Authorization header when the auth store has a token", async () => {
    let captured = "";
    const c = new HttpClient({
      baseUrl: "http://localhost",
      authStore: (() => { const s = new MemoryAuthStore(); s.set({ token: "tok-123" }); return s; })(),
      fetch: ((req: Request | string, init?: RequestInit) => {
        const r = typeof req === "string" ? new Request(req, init) : req;
        captured = r.headers.get("authorization") ?? "";
        return Promise.resolve(new Response(JSON.stringify({ data: 1 }), {
          headers: { "content-type": "application/json" },
        }));
      }) as typeof fetch,
    });
    await c.request("/api/v1/x");
    expect(captured).toBe("Bearer tok-123");
  });

  it("auto-cancels the prior request with the same requestKey", async () => {
    let aborts = 0;
    const c = makeClient((req) => new Promise<Response>((resolve) => {
      req.signal?.addEventListener("abort", () => { aborts++; resolve(new Response("", { status: 499 })); });
      // never resolve unless aborted
    }));
    const p1 = c.request("/api/v1/x", { requestKey: "k" }).catch(() => "aborted");
    const p2 = c.request("/api/v1/x", { requestKey: "k" }).catch(() => "aborted");
    void p1;
    void p2;
    // give the scheduler a tick so the second acquire fires the abort
    await new Promise((r) => setTimeout(r, 10));
    expect(aborts).toBeGreaterThanOrEqual(1);
  });
});

describe("Collection.list search", () => {
  it("sends ?search= and omits it when unset", async () => {
    const { Collection } = await import("../src/collection.ts");
    const urls: string[] = [];
    const c = makeClient((req) => {
      urls.push(req.url);
      return new Response(JSON.stringify({ data: [], page: 1, perPage: 30, totalItems: 0, totalPages: 0 }), {
        headers: { "content-type": "application/json" },
      });
    });
    const posts = new Collection(c, "posts");
    await posts.list({ search: "hello wor" });
    await posts.list();
    expect(new URL(urls[0]!).searchParams.get("search")).toBe("hello wor");
    expect(new URL(urls[1]!).searchParams.has("search")).toBe(false);
  });
});

describe("Files.url", () => {
  it("puts fit into the thumb value and adds format / quality", async () => {
    const { Files } = await import("../src/files.ts");
    const f = new Files(makeClient(() => new Response("")));
    const u = new URL(f.url("a.png", { thumb: "200x200", fit: "cover", format: "webp", quality: 70 }));
    expect(u.searchParams.get("thumb")).toBe("200x200_cover");
    expect(u.searchParams.has("fit")).toBe(false);
    expect(u.searchParams.get("format")).toBe("webp");
    expect(u.searchParams.get("quality")).toBe("70");
    expect(new URL(f.url("a.png", { thumb: "400x0" })).search).toBe("?thumb=400x0");
    expect(new URL(f.url("a.png", { format: "auto" })).search).toBe("?format=auto");
  });
});

describe("Collection.aggregate", () => {
  it("joins array options and unwraps the rows", async () => {
    const { Collection } = await import("../src/collection.ts");
    const urls: string[] = [];
    const c = makeClient((req) => {
      urls.push(req.url);
      return new Response(JSON.stringify({ data: [{ status: "open", count: 2 }] }), {
        headers: { "content-type": "application/json" },
      });
    });
    const rows = await new Collection(c, "orders").aggregate({ agg: ["count", "sum(amount)"], groupBy: "status", sort: "-count", limit: 5 });
    expect(rows).toEqual([{ status: "open", count: 2 }]);
    const u = new URL(urls[0]!);
    expect(u.pathname).toBe("/api/v1/orders/_aggregate");
    expect(u.searchParams.get("agg")).toBe("count,sum(amount)");
    expect(u.searchParams.get("groupBy")).toBe("status");
    expect(u.searchParams.get("limit")).toBe("5");
  });
});

describe("account flows", () => {
  it("hits the email change, invite and accept endpoints", async () => {
    const { CollectionAuth, AdminAuth } = await import("../src/auth/flows.ts");
    const calls: Array<{ url: string; body: unknown }> = [];
    const c = makeClient(async (req) => {
      calls.push({ url: new URL(req.url).pathname, body: await req.json().catch(() => null) });
      return new Response(JSON.stringify({ data: { ok: true } }), { headers: { "content-type": "application/json" } });
    });
    c.authStore.set({ token: "aaa.eyJleHAiOjk5OTk5OTk5OTl9.bbb" });
    const users = new CollectionAuth(c, "users");
    await users.requestEmailChange("new@x.com");
    await users.confirmEmailChange("tok", "pw");
    expect(c.authStore.get()).toBeNull();
    await users.acceptInvite("tok2", "pw2");
    await new AdminAuth(c).invite("users", "a@x.com", { name: "A" });
    expect(calls.map((x) => x.url)).toEqual([
      "/api/v1/auth/users/request-email-change",
      "/api/v1/auth/users/confirm-email-change",
      "/api/v1/auth/users/accept-invite",
      "/api/v1/admin/users/users/invite",
    ]);
    expect(calls[3]!.body).toEqual({ email: "a@x.com", data: { name: "A" } });
  });
});

describe("Collection.iterate", () => {
  /** A list endpoint that pages like the server: perPage clamped to 500 and echoed back. */
  function pagedServer(count: number) {
    const records = Array.from({ length: count }, (_, i) => ({ id: `r${i}` }));
    const calls: URLSearchParams[] = [];
    const client = makeClient((req) => {
      const q = new URL(req.url).searchParams;
      calls.push(q);
      const page = Number(q.get("page") ?? 1);
      const perPage = Math.min(Number(q.get("perPage") ?? 30), 500);
      const skip = q.get("skipTotal") === "1";
      const data = records.slice((page - 1) * perPage, page * perPage);
      const totalItems = skip ? -1 : count;
      const totalPages = skip ? -1 : Math.ceil(count / perPage);
      return new Response(JSON.stringify({ data, page, perPage, totalItems, totalPages }), {
        headers: { "content-type": "application/json" },
      });
    });
    return { client, calls };
  }

  async function collect(client: HttpClient, opts: { perPage?: number; skipTotal?: boolean }): Promise<string[]> {
    const { Collection } = await import("../src/collection.ts");
    const out: string[] = [];
    for await (const r of new Collection<{ id: string }>(client, "posts").iterate(opts)) out.push(r.id);
    return out;
  }

  it("keeps paging under skipTotal (totalPages = -1)", async () => {
    const { client, calls } = pagedServer(5);
    const ids = await collect(client, { perPage: 2, skipTotal: true });
    expect(ids).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(calls.length).toBe(3);
  });

  it("measures short pages against the server's clamped perPage", async () => {
    const { client } = pagedServer(1200);
    expect((await collect(client, { perPage: 1000 })).length).toBe(1200);
    expect((await collect(client, { perPage: 1000, skipTotal: true })).length).toBe(1200);
  });

  it("stops on an exact multiple under skipTotal via the empty page", async () => {
    const { client, calls } = pagedServer(4);
    expect((await collect(client, { perPage: 2, skipTotal: true })).length).toBe(4);
    expect(calls.length).toBe(3);
  });
});

describe("Files.token cache", () => {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt = (claims: Record<string, unknown>) => `h.${b64(claims)}.s`;
  const exp = () => Math.floor(Date.now() / 1000) + 3600;

  function tokenServer(mint: (n: number) => Record<string, unknown>) {
    let n = 0;
    const client = makeClient(() => {
      n++;
      return new Response(JSON.stringify({ data: mint(n) }), { headers: { "content-type": "application/json" } });
    });
    return { client, minted: () => n };
  }

  it("caches a reusable token", async () => {
    const { Files } = await import("../src/files.ts");
    const { client, minted } = tokenServer((n) => ({ token: jwt({ filename: "a.png", jti: `j${n}` }), expires_at: exp() }));
    const f = new Files(client);
    await f.urlWithToken("posts", "p1", "img", "a.png");
    await f.urlWithToken("posts", "p1", "img", "a.png");
    expect(minted()).toBe(1);
  });

  it("never caches a one-time token (uses: 1 claim)", async () => {
    const { Files } = await import("../src/files.ts");
    const { client, minted } = tokenServer((n) => ({ token: jwt({ filename: "a.png", uses: 1, jti: `j${n}` }), expires_at: exp() }));
    const f = new Files(client);
    const a = await f.urlWithToken("posts", "p1", "img", "a.png");
    const b = await f.urlWithToken("posts", "p1", "img", "a.png");
    expect(minted()).toBe(2);
    expect(a).not.toBe(b);
  });

  it("honours an explicit one_time flag from the server", async () => {
    const { Files } = await import("../src/files.ts");
    const { client, minted } = tokenServer((n) => ({ token: `opaque-${n}`, expires_at: exp(), one_time: true }));
    const f = new Files(client);
    await f.token("posts", "p1", "img", "a.png");
    await f.token("posts", "p1", "img", "a.png");
    expect(minted()).toBe(2);
  });

  it("drops cached tokens when the signed-in identity changes", async () => {
    const { Files } = await import("../src/files.ts");
    const { client, minted } = tokenServer((n) => ({ token: jwt({ filename: "a.png", jti: `j${n}` }), expires_at: exp() }));
    const f = new Files(client);
    const user = (id: string) => jwt({ id, collection: "users", aud: "user", exp: exp() });
    client.authStore.set({ token: user("u1") });
    await f.token("posts", "p1", "img", "a.png");
    // A refreshed token for the same user keeps the cache.
    client.authStore.set({ token: user("u1") + "x" });
    await f.token("posts", "p1", "img", "a.png");
    expect(minted()).toBe(1);
    client.authStore.set({ token: user("u2") });
    await f.token("posts", "p1", "img", "a.png");
    expect(minted()).toBe(2);
    client.authStore.set(null);
    await f.token("posts", "p1", "img", "a.png");
    expect(minted()).toBe(3);
  });
});
