/**
 * Changes for Vaultbase server 0.17:
 *  - proactive refresh no longer waits on itself (it hung every request
 *    once the token was within a minute of expiry);
 *  - recoveryRegenerate() sends the current TOTP code the server now requires;
 *  - OAuth: authorize returns `state` + `state_secret`, exchange must send both
 *    (the SDK remembers the secret per state), and exchange / merge-confirm
 *    can answer with an MFA challenge;
 *  - realtime re-sends auth when the token changes and refreshes on
 *    `auth_expired`.
 */
import { describe, expect, it, afterEach } from "bun:test";
import { HttpClient } from "../src/client.ts";
import { MemoryAuthStore } from "../src/auth/store.ts";
import { CollectionAuth } from "../src/auth/flows.ts";
import { RealtimeManager } from "../src/realtime/manager.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function jwt(expInSeconds: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expInSeconds, id: "u1" })).replace(/=/g, "");
  return `aaa.${payload}.bbb`;
}

function client(handler: (req: Request) => Response | Promise<Response>, store = new MemoryAuthStore()) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const c = new HttpClient({
    baseUrl: "http://localhost",
    authStore: store,
    fetch: (async (input: Request | string, init?: RequestInit) => {
      const req = typeof input === "string" ? new Request(input, init) : input;
      const text = init?.body ? String(init.body) : "";
      calls.push({ path: new URL(req.url).pathname + new URL(req.url).search, method: req.method, body: text ? JSON.parse(text) : undefined });
      return await handler(req);
    }) as typeof fetch,
  });
  return { c, calls, store };
}

describe("proactive refresh", () => {
  it("refreshes a nearly expired token without hanging", async () => {
    const fresh = jwt(3600);
    const { c, calls, store } = client((req) =>
      new URL(req.url).pathname === "/api/v1/auth/refresh" ? json({ data: { token: fresh } }) : json({ data: { ok: true } }));
    store.set({ token: jwt(30) });
    const result = await Promise.race([
      c.request("/api/v1/posts"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("request hung")), 1000)),
    ]);
    expect(result).toEqual({ ok: true });
    expect(store.get()?.token).toBe(fresh);
    expect(calls.filter((x) => x.path === "/api/v1/auth/refresh")).toHaveLength(1);
  });
});

describe("recovery codes", () => {
  it("regenerating sends the current TOTP code", async () => {
    const { c, calls } = client(() => json({ data: { codes: ["a"] } }));
    await new CollectionAuth(c, "users").recoveryRegenerate("123456");
    expect(calls[0]!.body).toEqual({ code: "123456" });
  });
});

describe("OAuth state_secret", () => {
  const storage = new Map<string, string>();
  const g = globalThis as unknown as { sessionStorage?: unknown };
  const saved = g.sessionStorage;
  afterEach(() => { storage.clear(); g.sessionStorage = saved; });
  const fakeSession = () => {
    g.sessionStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    };
  };

  it("authorize returns state + state_secret, and exchange sends them back", async () => {
    fakeSession();
    const { c, calls } = client((req) => new URL(req.url).pathname.endsWith("/authorize")
      ? json({ data: { authorize_url: "https://idp/x", state: "st1", state_secret: "sec1", pkce: "server" } })
      : json({ data: { token: jwt(3600), record: { id: "u1" } } }));
    const auth = new CollectionAuth(c, "users");
    const a = await auth.oauth2Authorize({ provider: "google", redirectUri: "https://app/cb" });
    expect(a.state).toBe("st1");
    expect(a.state_secret).toBe("sec1");
    // After the redirect the app only has `state` (and the code) from the URL.
    await auth.oauth2Exchange({ provider: "google", code: "c", redirectUri: "https://app/cb", state: "st1" });
    expect(calls[1]!.body).toMatchObject({ state: "st1", state_secret: "sec1" });
    expect(storage.size).toBe(0); // used once
  });

  it("an explicit state_secret wins (server-side / other-tab flows)", async () => {
    const { c, calls } = client(() => json({ data: { token: jwt(3600), record: { id: "u1" } } }));
    await new CollectionAuth(c, "users").oauth2Exchange({ provider: "google", code: "c", redirectUri: "https://app/cb", state: "st1", state_secret: "given" });
    expect(calls[0]!.body).toMatchObject({ state_secret: "given" });
  });

  it("an MFA challenge from exchange is returned, not stored as a session", async () => {
    const { c, store } = client(() => json({ data: { mfa_required: true, mfa_token: "t1" } }));
    const r = await new CollectionAuth(c, "users").oauth2Exchange({ provider: "google", code: "c", redirectUri: "https://app/cb", state: "s", state_secret: "x" });
    expect(r).toEqual({ mfa_required: true, mfa_token: "t1" });
    expect(store.get()).toBeNull();
  });
});

// ── Realtime ─────────────────────────────────────────────────────────────────

class FakeWs {
  static last: FakeWs | null = null;
  sent: unknown[] = [];
  private handlers: Record<string, Array<(e: unknown) => void>> = {};
  constructor(public url: string) { FakeWs.last = this; setTimeout(() => this.emit("open", {}), 0); }
  addEventListener(t: string, fn: (e: unknown) => void) { (this.handlers[t] ??= []).push(fn); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.emit("close", {}); }
  emit(t: string, e: unknown) { for (const fn of this.handlers[t] ?? []) fn(e); }
}

describe("realtime auth", () => {
  const g = globalThis as unknown as { WebSocket?: unknown };
  const saved = g.WebSocket;
  afterEach(() => { g.WebSocket = saved; FakeWs.last = null; });

  it("re-sends auth over an open socket when the token changes", async () => {
    g.WebSocket = FakeWs;
    const { c, store } = client(() => json({ data: {} }));
    store.set({ token: jwt(3600) });
    const rt = new RealtimeManager(c);
    rt.subscribe("posts", "*", () => {});
    await new Promise((r) => setTimeout(r, 10));
    const ws = FakeWs.last!;
    const next = jwt(7200);
    store.set({ token: next });
    expect(ws.sent.filter((m) => (m as { type: string }).type === "auth").map((m) => (m as { token: string }).token)).toContain(next);
    rt.closeNow();
  });

  it("refreshes and re-authenticates on auth_expired", async () => {
    g.WebSocket = FakeWs;
    const fresh = jwt(7200);
    const { c, store } = client((req) =>
      new URL(req.url).pathname === "/api/v1/auth/refresh" ? json({ data: { token: fresh } }) : json({ data: {} }));
    store.set({ token: jwt(3600) });
    const rt = new RealtimeManager(c);
    rt.subscribe("posts", "*", () => {});
    await new Promise((r) => setTimeout(r, 10));
    const ws = FakeWs.last!;
    ws.emit("message", { data: JSON.stringify({ type: "auth_expired" }) });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.get()?.token).toBe(fresh);
    expect(ws.sent.some((m) => (m as { type: string; token?: string }).type === "auth" && (m as { token: string }).token === fresh)).toBe(true);
    rt.closeNow();
  });
});

describe("realtime delivery", () => {
  const g = globalThis as unknown as { WebSocket?: unknown };
  const saved = g.WebSocket;
  afterEach(() => { g.WebSocket = saved; FakeWs.last = null; });

  const open = async () => {
    g.WebSocket = FakeWs;
    const { c } = client(() => json({ data: {} }));
    const rt = new RealtimeManager(c);
    return { rt, ws: async () => { await new Promise((r) => setTimeout(r, 10)); return FakeWs.last!; } };
  };
  const event = (collection: string, id: string, type = "update", title = "") =>
    ({ data: JSON.stringify({ type, collection, record: { id, title } }) });
  const topics = (ws: FakeWs, type: string) =>
    ws.sent.filter((m) => (m as { type: string }).type === type).flatMap((m) => (m as { topics: string[] }).topics);

  it("subscribe(name, '*') asks for that collection only, not every collection", async () => {
    const { rt, ws: get } = await open();
    rt.subscribe("posts", "*", () => {});
    const ws = await get();
    expect([...new Set(topics(ws, "subscribe"))]).toEqual(["posts"]);
    rt.closeNow();
  });

  it("hands each subscription only its own collection's events", async () => {
    const { rt, ws: get } = await open();
    const posts: string[] = [], site: string[] = [], all: string[] = [];
    rt.subscribe("posts", "*", (e) => posts.push(e.collection));
    rt.subscribe("site", "*", (e) => site.push(e.collection));
    rt.subscribe("*", "*", (e) => all.push(e.collection));
    const ws = await get();
    ws.emit("message", event("posts", "p1"));
    ws.emit("message", event("site", "s1"));
    expect(posts).toEqual(["posts"]);
    expect(site).toEqual(["site"]);
    expect(all).toEqual(["posts", "site"]);
    rt.closeNow();
  });

  it("delivers every update, however close together", async () => {
    const { rt, ws: get } = await open();
    const titles: string[] = [];
    rt.subscribe("posts", "p1", (e) => titles.push(String(e.record?.["title"])));
    const ws = await get();
    for (const t of ["one", "two", "three"]) ws.emit("message", event("posts", "p1", "update", t));
    expect(titles).toEqual(["one", "two", "three"]);
    rt.closeNow();
  });

  it("keeps a topic while another subscription still holds it", async () => {
    const { rt, ws: get } = await open();
    const seen: string[] = [];
    const stop = rt.subscribe("posts", "p1", () => seen.push("a"));
    rt.subscribe("posts", "p1", () => seen.push("b"));
    const ws = await get();
    stop();
    expect(topics(ws, "unsubscribe")).toEqual([]);
    ws.emit("message", event("posts", "p1"));
    expect(seen).toEqual(["b"]);
    rt.closeNow();
  });
});

describe("sessions stay per client", () => {
  it("one client's 401 or refresh doesn't touch another client's session", async () => {
    const a = client(() => json({ error: "Unauthorized", code: 401 }, 401));
    const b = client((req) =>
      new URL(req.url).pathname === "/api/v1/auth/refresh" ? json({ data: { token: jwt(7200) } }) : json({ data: {} }));
    a.store.set({ token: jwt(3600) });
    const bToken = jwt(3600);
    b.store.set({ token: bToken });
    await a.c.request("/api/v1/posts").catch(() => {});
    expect(a.store.get()).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(b.store.get()?.token).toBe(bToken);
    await b.c.refresher.refreshOnce();
    expect(a.store.get()).toBeNull();
  });
});

describe("a 401 on a request sent without the session", () => {
  it("keeps the session (vb.flags with public evaluation off used to sign users out)", async () => {
    const { c, store } = client(() => json({ error: "Unauthorized", code: 401 }, 401));
    const token = jwt(3600);
    store.set({ token });
    await expect(c.request("/api/v1/flags/evaluate", { method: "POST", body: {}, skipAuth: true })).rejects.toThrow();
    expect(store.get()?.token).toBe(token);
  });
});

class FakeEs {
  static all: FakeEs[] = [];
  private handlers: Record<string, Array<(e: unknown) => void>> = {};
  closed = false;
  constructor(public url: string) {
    FakeEs.all.push(this);
    setTimeout(() => this.emit("connect", { data: JSON.stringify({ clientId: `c${FakeEs.all.length}` }) }), 0);
  }
  addEventListener(t: string, fn: (e: unknown) => void) { (this.handlers[t] ??= []).push(fn); }
  close() { this.closed = true; }
  emit(t: string, e: unknown) { for (const fn of this.handlers[t] ?? []) fn(e); }
}

describe("realtime reconnects", () => {
  const g = globalThis as unknown as { WebSocket?: unknown; EventSource?: unknown };
  const saved = { ws: g.WebSocket, es: g.EventSource };
  afterEach(() => { g.WebSocket = saved.ws; g.EventSource = saved.es; FakeEs.all = []; FakeWs.last = null; });

  it("opens a new SSE stream after the stream drops", async () => {
    g.WebSocket = undefined;
    g.EventSource = FakeEs;
    const { c } = client(() => json({ data: {} }));
    const rt = new RealtimeManager(c);
    rt.subscribe("posts", "*", () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeEs.all).toHaveLength(1);
    FakeEs.all[0]!.emit("error", {});
    await new Promise((r) => setTimeout(r, 450));
    expect(FakeEs.all).toHaveLength(2);
    expect(FakeEs.all[0]!.closed).toBe(true);
    rt.closeNow();
  });

  it("opens a new WebSocket after the socket drops", async () => {
    g.WebSocket = FakeWs;
    const { c } = client(() => json({ data: {} }));
    const rt = new RealtimeManager(c);
    rt.subscribe("posts", "*", () => {});
    await new Promise((r) => setTimeout(r, 20));
    const first = FakeWs.last!;
    first.emit("close", {});
    await new Promise((r) => setTimeout(r, 450));
    expect(FakeWs.last).not.toBe(first);
    rt.closeNow();
  });
});
