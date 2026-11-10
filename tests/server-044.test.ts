/**
 * Server 0.44 contract: the records, files and batch APIs answer 401 for a
 * token they don't accept (`reason: "token_invalid"`) and for an API token
 * without the scope (`reason: "insufficient_scope"`), and 400 with `details`
 * for an unknown sort, expand, fields or body key.
 */
import { describe, expect, it } from "bun:test";
import { HttpClient, isApiToken } from "../src/client.ts";
import { Collection } from "../src/collection.ts";
import { Singleton } from "../src/singleton.ts";
import { Batch } from "../src/batch.ts";
import { MemoryAuthStore } from "../src/auth/store.ts";
import { VaultbaseError } from "../src/errors.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const jwt = (claims: Record<string, unknown>, sig = "sig") => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.${sig}`;
const SESSION = jwt({ exp: 9_999_999_999, aud: "user" });
const FRESH = jwt({ exp: 9_999_999_999, aud: "user" }, "fresh");
const API_TOKEN = `vbat_${jwt({ exp: 9_999_999_999, aud: "api", scopes: ["read"] })}`;

const INVALID = { error: "Token expired or invalid", code: 401, reason: "token_invalid" };
const NO_SCOPE = { error: "This API token doesn't have the scope for this request", code: 401, reason: "insufficient_scope" };
const REFRESH = "/api/v1/auth/refresh";
/** What a dead token's 401 becomes. */
const EXPIRED = { kind: "auth", reason: "expired", message: "Token expired or invalid", serverReason: "token_invalid" } as const;

interface Call { method: string; path: string; search: string; auth: string | undefined; body: unknown }

function setup(handler: (call: Call) => Response | Promise<Response>, token?: string) {
  const calls: Call[] = [];
  const authStore = new MemoryAuthStore();
  if (token) authStore.set({ token, record: { id: "u1" } });
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    const call: Call = {
      method: init?.method ?? "GET",
      path: u.pathname,
      search: u.search,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return await handler(call);
  }) as typeof fetch;
  const client = new HttpClient({ baseUrl: "http://localhost", authStore, fetch: fetcher });
  return { client, authStore, calls, paths: () => calls.map((c) => c.path) };
}

const caught = async (p: Promise<unknown>) => (await p.catch((e) => e)) as VaultbaseError;

describe("401 token_invalid with a session", () => {
  it("refreshes once and retries with the new token", async () => {
    const { client, authStore, calls, paths } = setup((c) => {
      if (c.path === REFRESH) return json({ data: { token: FRESH } });
      return c.auth === `Bearer ${FRESH}` ? json({ data: [], page: 1 }) : json(INVALID, 401);
    }, SESSION);
    expect(await client.request<unknown>("/api/v1/posts")).toEqual({ data: [], page: 1 });
    expect(paths()).toEqual(["/api/v1/posts", REFRESH, "/api/v1/posts"]);
    expect(calls[2]?.auth).toBe(`Bearer ${FRESH}`);
    expect(authStore.get()?.token).toBe(FRESH);
  });

  it("doesn't loop when the refreshed token is refused too: the session ends", async () => {
    const { client, authStore, paths } = setup(
      (c) => c.path === REFRESH ? json({ data: { token: FRESH } }) : json(INVALID, 401),
      SESSION,
    );
    const err = await caught(client.request("/api/v1/posts"));
    expect(err.data).toEqual(EXPIRED);
    expect(err.status).toBe(401);
    expect(paths()).toEqual(["/api/v1/posts", REFRESH, "/api/v1/posts"]);
    expect(authStore.get()).toBeNull();
  });

  it("a refused refresh ends the session with the server's message", async () => {
    const { client, authStore, paths } = setup(
      (c) => c.path === REFRESH ? json({ error: "Token expired or invalid", code: 401 }, 401) : json(INVALID, 401),
      SESSION,
    );
    const err = await caught(new Collection(client, "posts").list());
    expect(err.data).toEqual(EXPIRED);
    expect(paths()).toEqual(["/api/v1/posts", REFRESH]);
    expect(authStore.get()).toBeNull();
  });

  it("requests in flight together share one refused refresh", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { client, authStore, paths } = setup(async (c) => {
      if (c.path === REFRESH) return json({ error: "Token expired or invalid", code: 401 }, 401);
      if (c.path.endsWith("/late")) await gate; // answered after the session has ended
      return json(INVALID, 401);
    }, SESSION);
    const late = caught(client.request("/api/v1/posts/late"));
    const errs = await Promise.all([caught(client.request("/api/v1/posts/a")), caught(client.request("/api/v1/posts/b"))]);
    release();
    for (const err of [...errs, await late]) expect(err.data).toEqual(EXPIRED);
    expect(paths().filter((p) => p === REFRESH)).toHaveLength(1);
    expect(authStore.get()).toBeNull();
  });

  it("a session refreshed while the request was out is used without a second refresh", async () => {
    const { client, authStore, paths } = setup((c) => {
      if (c.path === REFRESH) return json({ data: { token: "unexpected" } });
      if (c.auth === `Bearer ${FRESH}`) return json({ data: { ok: true } });
      // Another request rotated the token before this 401 arrived.
      authStore.set({ token: FRESH });
      return json(INVALID, 401);
    }, SESSION);
    expect(await client.request<{ ok: boolean }>("/api/v1/posts/1")).toEqual({ ok: true });
    expect(paths()).toEqual(["/api/v1/posts/1", "/api/v1/posts/1"]);
    expect(authStore.get()?.token).toBe(FRESH);
  });

  it("signing in again while the refresh is refused keeps the new session", async () => {
    const { client, authStore } = setup((c) => {
      if (c.path !== REFRESH) return json(INVALID, 401);
      authStore.set({ token: FRESH });
      return json({ error: "Token expired or invalid", code: 401 }, 401);
    }, SESSION);
    const err = await caught(client.request("/api/v1/posts"));
    expect(err.data).toMatchObject({ kind: "auth", reason: "expired" });
    expect(authStore.get()?.token).toBe(FRESH);
  });
});

describe("401 with an API token", () => {
  it("recognises the vbat_ form and the bare JWT", () => {
    expect(isApiToken(API_TOKEN)).toBe(true);
    expect(isApiToken(API_TOKEN.slice(5))).toBe(true);
    expect(isApiToken(jwt({ aud: ["api"] }))).toBe(true);
    expect(isApiToken(SESSION)).toBe(false);
    expect(isApiToken("not-a-jwt")).toBe(false);
  });

  it("without the scope: forbidden with the server's message, token kept, no refresh", async () => {
    const { client, authStore, paths } = setup(
      (c) => c.method === "GET" ? json({ data: [], page: 1 }) : json(NO_SCOPE, 401),
      API_TOKEN,
    );
    const posts = new Collection(client, "posts");
    const err = await caught(posts.create({ title: "x" }));
    expect(err.data).toEqual({
      kind: "auth", reason: "forbidden",
      message: "This API token doesn't have the scope for this request",
      serverReason: "insufficient_scope",
    });
    expect(err.serverReason).toBe("insufficient_scope");
    expect(err.status).toBe(401);
    expect(paths()).toEqual(["/api/v1/posts"]);
    expect(authStore.get()?.token).toBe(API_TOKEN);
    // What the token does cover still goes out with it.
    await posts.list();
    expect(authStore.get()?.token).toBe(API_TOKEN);
  });

  it("insufficient_scope goes by the reason, not the message or the kind of token", async () => {
    // Reworded, and on a session token: still no refresh, nothing cleared.
    const { client, authStore, paths } = setup(
      () => json({ error: "Not allowed for this token", code: 401, reason: "insufficient_scope" }, 401),
      SESSION,
    );
    const err = await caught(client.request("/api/v1/posts", { method: "POST", body: {} }));
    expect(err.data).toEqual({ kind: "auth", reason: "forbidden", message: "Not allowed for this token", serverReason: "insufficient_scope" });
    expect(paths()).toEqual(["/api/v1/posts"]);
    expect(authStore.get()?.token).toBe(SESSION);
  });

  it("token_invalid with a message about scopes is still a dead token", async () => {
    const { client } = setup(() => json({ error: "Token scope expired or invalid", code: 401, reason: "token_invalid" }, 401), API_TOKEN);
    expect((await caught(client.request("/api/v1/posts"))).data).toMatchObject({ reason: "expired", serverReason: "token_invalid" });
  });

  it("expired or revoked: expired with the server's message, never refreshed or cleared", async () => {
    const { client, authStore, calls } = setup(() => json(INVALID, 401), API_TOKEN);
    for (let i = 0; i < 2; i++) {
      const err = await caught(client.request("/api/v1/posts"));
      expect(err.data).toEqual(EXPIRED);
    }
    expect(calls.map((c) => [c.path, c.auth])).toEqual([
      ["/api/v1/posts", `Bearer ${API_TOKEN}`],
      ["/api/v1/posts", `Bearer ${API_TOKEN}`],
    ]);
    expect(authStore.get()?.token).toBe(API_TOKEN);
  });

  it("a 401 without a reason (another API, an older server) isn't refreshed either", async () => {
    const { client, authStore, paths } = setup(() => json({ error: "Unauthorized", code: 401 }, 401), API_TOKEN);
    const err = await caught(client.request("/api/v1/admin/auth/me"));
    expect(err.data).toEqual({ kind: "auth", reason: "expired", message: "Unauthorized" });
    expect(paths()).toEqual(["/api/v1/admin/auth/me"]);
    expect(authStore.get()?.token).toBe(API_TOKEN);
  });

  it("servers 0.42 and 0.43 (403 token_invalid): reported, token kept", async () => {
    const { client, authStore } = setup(
      () => json({ error: "Forbidden", code: 403, operation: "create", reason: "token_invalid" }, 403),
      API_TOKEN,
    );
    const err = await caught(client.request("/api/v1/posts", { method: "POST", body: {} }));
    expect(err.data).toMatchObject({ kind: "auth", reason: "expired", serverReason: "token_invalid" });
    expect(authStore.get()?.token).toBe(API_TOKEN);
  });

  it("isn't refreshed ahead of its expiry", async () => {
    const soon = Math.floor(Date.now() / 1000) + 10;
    for (const token of [`vbat_${jwt({ exp: soon, aud: "api" })}`, jwt({ exp: soon, aud: "api" })]) {
      const { client, authStore, calls } = setup(() => json({ data: { ok: true } }), token);
      expect(await client.request<{ ok: boolean }>("/api/v1/posts/1")).toEqual({ ok: true });
      expect(calls.map((c) => [c.path, c.auth])).toEqual([["/api/v1/posts/1", `Bearer ${token}`]]);
      expect(authStore.get()?.token).toBe(token);
    }
  });
});

describe("400 for unknown keys", () => {
  it("an unknown sort, expand or fields name is a validation error with details", async () => {
    const body = {
      error: "Unknown sort field 'titel'; unknown expand 'autor' (not a relation field); unknown field 'titel' in fields",
      code: 400,
      details: {
        sort: "unknown sort field 'titel'",
        expand: "unknown expand 'autor' (not a relation field)",
        fields: "unknown field 'titel' in fields",
      },
    };
    const { client, calls } = setup(() => json(body, 400));
    const err = await caught(new Collection(client, "posts").list({ sort: "-titel", expand: "autor", fields: "id,titel" }));
    expect(err.data).toEqual({ kind: "validation", message: body.error, details: body.details });
    expect(err.status).toBe(400);
    expect(calls[0]?.search).toBe("?sort=-titel&expand=autor&fields=id%2Ctitel");
  });

  it("an unknown body key is a validation error keyed by that key", async () => {
    const body = { error: "Unknown field 'colour' in body", code: 400, details: { colour: "unknown field 'colour' in body" } };
    const { client } = setup(() => json(body, 400));
    const posts = new Collection(client, "posts");
    for (const p of [posts.create({ title: "x", colour: "red" }), posts.update("p1", { colour: "red" })]) {
      const err = await caught(p);
      expect(err.data).toEqual({ kind: "validation", message: "Unknown field 'colour' in body", details: { colour: "unknown field 'colour' in body" } });
    }
  });
});

describe("the SDK adds no keys of its own", () => {
  const ok = () => json({ data: { id: "p1" } });

  it("list, iterate and get send only the options given", async () => {
    const { client, calls } = setup((c) => c.path === "/api/v1/posts" ? json({ data: [], page: 1, perPage: 100, totalItems: 0, totalPages: 0 }) : ok());
    const posts = new Collection(client, "posts");
    await posts.list();
    for await (const _ of posts.iterate()) void _;
    await posts.get("p1");
    await new Singleton(client, "settings").get();
    expect(calls.map((c) => c.search)).toEqual(["", "?page=1&perPage=100", "", ""]);
  });

  it("create, update and batch send the body as given", async () => {
    const { client, calls } = setup((c) => c.path === "/api/v1/batch" ? json({ data: [] }) : ok());
    const posts = new Collection(client, "posts");
    await posts.create({ title: "x" });
    await posts.update("p1", { title: "y" });
    await new Singleton(client, "settings").update({ theme: "dark" });
    await new Batch(client).create("posts", { title: "b" }).update("posts", "p1", { title: "c" }).list("posts").get("posts", "p1").run();
    expect(calls.map((c) => c.body)).toEqual([
      { title: "x" },
      { title: "y" },
      { theme: "dark" },
      { requests: [
        { method: "POST", url: "/api/v1/posts", body: { title: "b" } },
        { method: "PATCH", url: "/api/v1/posts/p1", body: { title: "c" } },
        { method: "GET", url: "/api/v1/posts" },
        { method: "GET", url: "/api/v1/posts/p1" },
      ] },
    ]);
  });
});
