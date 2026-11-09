/**
 * Server 0.42 contract: a refused pre-request refresh, 403 reasons, error
 * kinds for 400/404/409, and server warnings (header + realtime frame).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { HttpClient, type VaultbaseWarning } from "../src/client.ts";
import { MemoryAuthStore } from "../src/auth/store.ts";
import { VaultbaseError } from "../src/errors.ts";
import { RealtimeManager } from "../src/realtime/manager.ts";
import { CollectionAuth } from "../src/auth/flows.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const jwt = (exp: number) => `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.sig`;
const LONG = jwt(9_999_999_999);

function setup(
  handler: (path: string, init?: RequestInit) => Response,
  opts: { token?: string; warnings?: "dev" | "always" | "off"; onWarning?: (w: VaultbaseWarning) => void } = {},
) {
  const calls: Array<{ path: string; auth: string | undefined }> = [];
  const authStore = new MemoryAuthStore();
  if (opts.token) authStore.set({ token: opts.token, record: { id: "u1" } });
  const fetcher = ((url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
    calls.push({ path, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return Promise.resolve(handler(path, init));
  }) as typeof fetch;
  const client = new HttpClient({
    baseUrl: "http://localhost", authStore, fetch: fetcher,
    ...(opts.warnings ? { warnings: opts.warnings } : {}),
    ...(opts.onWarning ? { onWarning: opts.onWarning } : {}),
  });
  return { client, authStore, calls };
}

const caught = async (p: Promise<unknown>) => (await p.catch((e) => e)) as VaultbaseError;

describe("pre-request refresh", () => {
  it("a refused refresh signs out and throws auth/expired without sending the request", async () => {
    const soon = jwt(Math.floor(Date.now() / 1000) + 10);
    const { client, authStore, calls } = setup(
      (p) => p === "/api/v1/auth/refresh" ? json({ error: "Invalid token" }, 401) : json({ data: { ok: true } }),
      { token: soon },
    );
    const err = await caught(client.request("/api/v1/posts", { method: "POST", body: {} }));
    expect(err).toBeInstanceOf(VaultbaseError);
    expect(err.data).toMatchObject({ kind: "auth", reason: "expired" });
    expect(calls.map((c) => c.path)).toEqual(["/api/v1/auth/refresh"]);
    expect(authStore.get()).toBeNull();
  });

  it("a refresh that can't be answered keeps the session and sends the request", async () => {
    const soon = jwt(Math.floor(Date.now() / 1000) + 10);
    const { client, authStore, calls } = setup(
      (p) => p === "/api/v1/auth/refresh" ? json({ error: "boom" }, 500) : json({ data: { ok: true } }),
      { token: soon },
    );
    expect(await client.request<{ ok: boolean }>("/api/v1/posts")).toEqual({ ok: true });
    expect(calls.map((c) => c.path)).toEqual(["/api/v1/auth/refresh", "/api/v1/posts"]);
    expect(calls[1]?.auth).toBe(`Bearer ${soon}`);
    expect(authStore.get()?.token).toBe(soon);
  });
});

describe("403 reasons", () => {
  it("token_invalid maps to expired and ends the session", async () => {
    const { client, authStore } = setup(
      () => json({ error: "Forbidden", code: 403, operation: "create", reason: "token_invalid" }, 403),
      { token: LONG },
    );
    const err = await caught(client.request("/api/v1/posts", { method: "POST", body: {} }));
    expect(err.data).toEqual({ kind: "auth", reason: "expired", message: "Forbidden", operation: "create", serverReason: "token_invalid" });
    expect(err.operation).toBe("create");
    expect(err.serverReason).toBe("token_invalid");
    expect(err.status).toBe(403);
    expect(authStore.get()).toBeNull();
  });

  it("not_signed_in has its own reason", async () => {
    const { client } = setup(() => json({ error: "Forbidden", code: 403, operation: "list", reason: "not_signed_in" }, 403));
    const err = await caught(client.request("/api/v1/posts"));
    expect(err.data).toMatchObject({ kind: "auth", reason: "not_signed_in", operation: "list", serverReason: "not_signed_in" });
  });

  it("rule_denied and an older server's bare 403 stay forbidden, session kept", async () => {
    const { client, authStore } = setup(
      (p) => p.endsWith("/a")
        ? json({ error: "Forbidden", code: 403, operation: "update", reason: "rule_denied" }, 403)
        : json({ error: "Forbidden" }, 403),
      { token: LONG },
    );
    expect((await caught(client.request("/api/v1/x/a"))).data).toMatchObject({ kind: "auth", reason: "forbidden", operation: "update", serverReason: "rule_denied" });
    expect((await caught(client.request("/api/v1/x/b"))).data).toEqual({ kind: "auth", reason: "forbidden", message: "Forbidden" });
    expect(authStore.get()?.token).toBe(LONG);
  });
});

describe("error kinds", () => {
  it("400 is validation, 404 is not_found, both with status", async () => {
    const { client } = setup((p) => p.endsWith("/bad")
      ? json({ error: "Invalid filter: unknown field: titel", code: 400 }, 400)
      : json({ error: "Collection not found", code: 404 }, 404));
    const bad = await caught(client.request("/api/v1/bad"));
    expect(bad.data).toEqual({ kind: "validation", message: "Invalid filter: unknown field: titel", details: {} });
    expect(bad.status).toBe(400);
    const missing = await caught(client.request("/api/v1/missing"));
    expect(missing.kind).toBe("not_found");
    expect(missing.message).toBe("Collection not found");
    expect(missing.status).toBe(404);
  });

  it("registering an email that's taken is a conflict with the server's message", async () => {
    const { client } = setup(() => json({ error: "Email already registered", code: 409 }, 409));
    const err = await caught(new CollectionAuth(client, "users").register({ email: "a@b.c", password: "longpassword1" }));
    expect(err.data).toEqual({ kind: "conflict", message: "Email already registered", serverCode: 409 });
    expect(err.status).toBe(409);
  });
});

describe("server warnings", () => {
  it("a Vaultbase-Warning header calls onWarning once per message", async () => {
    const seen: VaultbaseWarning[] = [];
    const { client } = setup(
      () => json({ data: [], page: 1 }, 200, { "vaultbase-warning": "unknown sort field 'titel' | unknown expand 'autor'" }),
      { warnings: "off", onWarning: (w) => seen.push(w) },
    );
    await client.request("/api/v1/posts");
    expect(seen).toEqual([
      { source: "http", message: "unknown sort field 'titel'", method: "GET", path: "/api/v1/posts" },
      { source: "http", message: "unknown expand 'autor'", method: "GET", path: "/api/v1/posts" },
    ]);
  });

  it("console.warn follows the warnings option", async () => {
    const logged: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => { logged.push(m); };
    try {
      const res = () => json({ data: {} }, 200, { "vaultbase-warning": "unknown expand 'autor'" });
      await setup(res, { warnings: "always" }).client.request("/api/v1/posts/1");
      await setup(res, { warnings: "off" }).client.request("/api/v1/posts/1");
    } finally { console.warn = warn; }
    expect(logged).toEqual(["[vaultbase] GET /api/v1/posts/1: unknown expand 'autor'"]);
  });

  it("warns in development by default, not in production", async () => {
    const logged: string[] = [];
    const warn = console.warn;
    const env = process.env.NODE_ENV;
    console.warn = (m: string) => { logged.push(m); };
    try {
      const res = () => json({ data: {} }, 200, { "vaultbase-warning": "x" });
      process.env.NODE_ENV = "production";
      await setup(res).client.request("/api/v1/a");
      process.env.NODE_ENV = "development";
      await setup(res).client.request("/api/v1/b");
    } finally { console.warn = warn; if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env; }
    expect(logged).toEqual(["[vaultbase] GET /api/v1/b: x"]);
  });
});

class FakeWs {
  static all: FakeWs[] = [];
  static onOpen: (ws: FakeWs) => void = () => {};
  closed = false;
  private handlers: Record<string, Array<(e: unknown) => void>> = {};
  constructor(public url: string) {
    FakeWs.all.push(this);
    setTimeout(() => { if (!this.closed) { this.emit("open", {}); FakeWs.onOpen(this); } }, 5);
  }
  addEventListener(t: string, fn: (e: unknown) => void) { (this.handlers[t] ??= []).push(fn); }
  send(_s: string) {}
  close() { if (this.closed) return; this.closed = true; this.emit("close", {}); }
  emit(t: string, e: unknown) { for (const fn of this.handlers[t] ?? []) fn(e); }
}

const g = globalThis as unknown as { WebSocket?: unknown };
const savedWs = g.WebSocket;
afterEach(() => { g.WebSocket = savedWs; FakeWs.all = []; FakeWs.onOpen = () => {}; });

describe("realtime warning frame", () => {
  it("calls onWarning and isn't delivered as an event", async () => {
    g.WebSocket = FakeWs;
    FakeWs.onOpen = (ws) => ws.emit("message", {
      data: JSON.stringify({ type: "warning", reason: "unknown_collection", topic: "postz", message: "unknown collection 'postz'" }),
    });
    const seen: VaultbaseWarning[] = [];
    const { client } = setup(() => json({}), { warnings: "off", onWarning: (w) => seen.push(w) });
    const rt = new RealtimeManager(client);
    const events: unknown[] = [];
    rt.subscribe("postz", "*", (e) => events.push(e));
    await Bun.sleep(30);
    rt.closeNow();
    expect(seen).toEqual([{ source: "realtime", message: "unknown collection 'postz'", reason: "unknown_collection", topic: "postz" }]);
    expect(events).toEqual([]);
  });
});
