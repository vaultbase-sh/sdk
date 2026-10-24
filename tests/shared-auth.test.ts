import { describe, expect, it } from "bun:test";
import { HttpClient } from "../src/client.ts";
import { MemoryAuthStore } from "../src/auth/store.ts";
import { SharedAuth } from "../src/auth/flows.ts";

// A manual refresh returned the new token without storing it. The server
// revokes the old token on refresh, so the stored session was dead.

function jwt(expInSeconds: number): string {
  const part = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${part({ alg: "none" })}.${part({ exp: Math.floor(Date.now() / 1000) + expInSeconds })}.sig`;
}

describe("SharedAuth.refresh", () => {
  it("stores the new token and keeps the record", async () => {
    const fresh = jwt(7200);
    const calls: string[] = [];
    const store = new MemoryAuthStore();
    store.set({ token: jwt(3600), record: { id: "u1" } });
    const client = new HttpClient({
      baseUrl: "http://localhost",
      authStore: store,
      fetch: ((req: Request | string, init?: RequestInit) => {
        const r = typeof req === "string" ? new Request(req, init) : req;
        calls.push(new URL(r.url).pathname);
        return Promise.resolve(new Response(JSON.stringify({ data: { token: fresh } }), {
          headers: { "content-type": "application/json" },
        }));
      }) as typeof fetch,
    });
    const res = await new SharedAuth(client).refresh();
    expect(res.token).toBe(fresh);
    expect(store.get()).toEqual({ token: fresh, record: { id: "u1" } });
    expect(calls).toEqual(["/api/v1/auth/refresh"]);
  });

  it("refreshes once even when the token is about to expire", async () => {
    let refreshes = 0;
    const store = new MemoryAuthStore();
    store.set({ token: jwt(10) });
    const client = new HttpClient({
      baseUrl: "http://localhost",
      authStore: store,
      fetch: ((_req: Request | string, _init?: RequestInit) => {
        refreshes++;
        return Promise.resolve(new Response(JSON.stringify({ data: { token: jwt(3600) } }), {
          headers: { "content-type": "application/json" },
        }));
      }) as unknown as typeof fetch,
    });
    await new SharedAuth(client).refresh();
    expect(refreshes).toBe(1);
  });
});
