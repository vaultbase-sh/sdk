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
