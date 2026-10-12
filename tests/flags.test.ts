import { describe, expect, it } from "bun:test";
import { HttpClient } from "../src/client.ts";
import { MemoryAuthStore } from "../src/auth/store.ts";
import { FlagsClient } from "../src/flags/manager.ts";

function makeFlags(responses: Array<Record<string, unknown>>): { flags: FlagsClient; bodies: unknown[] } {
  const bodies: unknown[] = [];
  let i = 0;
  const fetcher = ((_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
    const data = responses[Math.min(i++, responses.length - 1)];
    return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  const client = new HttpClient({ baseUrl: "http://localhost", authStore: new MemoryAuthStore(), fetch: fetcher });
  return { flags: new FlagsClient(client), bodies };
}

describe("FlagsClient", () => {
  it("reads values from the server's { data } envelope", async () => {
    const { flags } = makeFlags([{ beta: true, plan: "pro", limit: 5, cfg: { a: 1 } }]);
    await flags.refresh();
    expect(flags.isEnabled("beta")).toBe(true);
    expect(flags.getString("plan", "free")).toBe("pro");
    expect(flags.getNumber("limit", 0)).toBe(5);
    expect(flags.getJson("cfg", {})).toEqual({ a: 1 });
    expect(flags.all()).toEqual({ beta: true, plan: "pro", limit: 5, cfg: { a: 1 } });
  });

  it("falls back for missing keys", async () => {
    const { flags } = makeFlags([{}]);
    await flags.refresh();
    expect(flags.isEnabled("nope", true)).toBe(true);
    expect(flags.getString("nope", "x")).toBe("x");
  });

  it("emits the keys that changed between refreshes", async () => {
    const { flags } = makeFlags([{ beta: true, other: 1 }, { beta: false, other: 1 }]);
    const seen: string[][] = [];
    flags.on("change", (keys) => seen.push(keys));
    await flags.refresh();
    await flags.refresh();
    expect(seen[0]?.sort()).toEqual(["beta", "other"]);
    expect(seen[1]).toEqual(["beta"]);
    expect(flags.isEnabled("beta", true)).toBe(false);
  });

  it("sends the context", async () => {
    const { flags, bodies } = makeFlags([{}]);
    await flags.setContext({ user: { plan: "pro" } });
    expect(bodies[0]).toEqual({ context: { user: { plan: "pro" } } });
  });
});
