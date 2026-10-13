import { describe, expect, it } from "bun:test";
import { HttpClient } from "../src/client.ts";
import { MemoryAuthStore } from "../src/auth/store.ts";
import { VaultbaseError } from "../src/errors.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(handler: (path: string) => Response) {
  const paths: string[] = [];
  const authStore = new MemoryAuthStore();
  authStore.set({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig", record: { id: "u1" } });
  const fetcher = ((url: string | URL | Request) => {
    const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
    paths.push(path);
    return Promise.resolve(handler(path));
  }) as typeof fetch;
  return { client: new HttpClient({ baseUrl: "http://localhost", authStore, fetch: fetcher }), authStore, paths };
}

describe("401 handling", () => {
  it("refreshes once and retries when the token expired", async () => {
    let first = true;
    const { client, authStore, paths } = setup((p) => {
      if (p === "/api/v1/auth/refresh") return json({ data: { token: "header.eyJleHAiOjk5OTk5OTk5OTl9.fresh" } });
      if (first) { first = false; return json({ error: "expired" }, 401); }
      return json({ data: { ok: true } });
    });
    expect(await client.request<{ ok: boolean }>("/api/v1/thing")).toEqual({ ok: true });
    expect(paths).toEqual(["/api/v1/thing", "/api/v1/auth/refresh", "/api/v1/thing"]);
    expect(authStore.get()?.token).toEndWith(".fresh");
  });

  it("doesn't loop or sign out when a fresh token is refused too", async () => {
    const { client, authStore, paths } = setup((p) =>
      p === "/api/v1/auth/refresh"
        ? json({ data: { token: "header.eyJleHAiOjk5OTk5OTk5OTl9.fresh" } })
        : json({ error: "Authentication required" }, 401));
    let err: unknown;
    try { await client.request("/api/v1/custom/members-only"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(VaultbaseError);
    expect((err as VaultbaseError).data).toMatchObject({ kind: "auth", reason: "forbidden" });
    expect(paths.filter((p) => p === "/api/v1/auth/refresh")).toHaveLength(1);
    expect(paths.filter((p) => p === "/api/v1/custom/members-only")).toHaveLength(2);
    expect(authStore.get()?.token).toEndWith(".fresh"); // still signed in
  });

  it("signs out when the refresh itself fails", async () => {
    const { client, authStore } = setup((p) =>
      p === "/api/v1/auth/refresh" ? json({ error: "nope" }, 401) : json({ error: "expired" }, 401));
    let err: unknown;
    try { await client.request("/api/v1/thing"); } catch (e) { err = e; }
    expect((err as VaultbaseError).data).toMatchObject({ kind: "auth", reason: "expired" });
    expect(authStore.get()).toBeNull();
  });
});
