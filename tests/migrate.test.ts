import { describe, expect, it } from "bun:test";
import {
  pullSnapshot,
  diffSnapshot,
  applySnapshot,
  type SnapshotEnvelope,
} from "../src/migrate/index.ts";

const sampleSnapshot: SnapshotEnvelope = {
  generated_at: "2026-04-29T00:00:00Z",
  version: 1,
  collections: [{ name: "posts", type: "base", fields: [] }],
};

function mockFetch(handler: (url: string, init?: RequestInit) => Response): typeof globalThis.fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    return Promise.resolve(handler(u, init));
  }) as typeof globalThis.fetch;
}

describe("migrate API", () => {
  it("pullSnapshot returns the server's snapshot envelope", async () => {
    const fetch = mockFetch((url) => {
      expect(url).toBe("https://target.example/api/v1/admin/migrations/snapshot");
      return new Response(JSON.stringify(sampleSnapshot), {
        headers: { "content-type": "application/json" },
      });
    });
    const snap = await pullSnapshot({ url: "https://target.example", adminToken: "t", fetch });
    expect(snap.collections).toHaveLength(1);
  });

  it("pullSnapshot accepts the {data: …} envelope shape", async () => {
    const fetch = mockFetch(() =>
      new Response(JSON.stringify({ data: sampleSnapshot }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const snap = await pullSnapshot({ url: "https://x", adminToken: "t", fetch });
    expect(snap.version).toBe(1);
  });

  it("diffSnapshot POSTs the snapshot and returns parsed entries", async () => {
    let capturedBody: string | undefined;
    const fetch = mockFetch((url, init) => {
      expect(url).toBe("https://x/api/v1/admin/migrations/diff");
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({
        data: [
          { kind: "create", collection: "posts" },
          { kind: "update", collection: "users", changes: ["field added: avatar"] },
          { kind: "unchanged", collection: "settings" },
        ],
      }), { headers: { "content-type": "application/json" } });
    });
    const diff = await diffSnapshot(sampleSnapshot, { url: "https://x", adminToken: "t", fetch });
    expect(diff).toHaveLength(3);
    expect(diff[0]?.kind).toBe("create");
    const sent = JSON.parse(capturedBody!) as { snapshot: SnapshotEnvelope };
    expect(sent.snapshot.version).toBe(1);
  });

  it("diffSnapshot reads the server's { added, modified, unchanged, removed }", async () => {
    const fetch = mockFetch(() => new Response(JSON.stringify({
      data: {
        added: [{ name: "posts", type: "base" }],
        modified: [{ name: "users", type: "auth", changes: ["field added: avatar"] }],
        unchanged: [{ name: "settings" }],
        removed: [{ name: "legacy" }],
      },
    }), { headers: { "content-type": "application/json" } }));
    const diff = await diffSnapshot(sampleSnapshot, { url: "https://x", adminToken: "t", fetch });
    expect(diff).toEqual([
      { kind: "create", collection: "posts" },
      { kind: "update", collection: "users", changes: ["field added: avatar"] },
      { kind: "unchanged", collection: "settings" },
      { kind: "remove", collection: "legacy" },
    ]);
  });

  it("applySnapshot reads the server's error shape", async () => {
    const fetch = mockFetch(() => new Response(JSON.stringify({
      data: { created: [], updated: [], unchanged: ["a"], skipped: ["a"], errors: [{ collection: "b", error: "bad rule" }] },
    }), { headers: { "content-type": "application/json" } }));
    const r = await applySnapshot(sampleSnapshot, { url: "https://x", adminToken: "t", fetch });
    expect(r.errors).toEqual([{ collection: "b", message: "bad rule" }]);
    expect(r.skipped).toEqual(["a"]);
  });

  it("applySnapshot defaults to additive mode", async () => {
    let sentMode: string | undefined;
    const fetch = mockFetch((_url, init) => {
      const body = JSON.parse(init!.body as string) as { mode: string };
      sentMode = body.mode;
      return new Response(JSON.stringify({
        data: { created: ["posts"], updated: [], skipped: [], errors: [] },
      }), { headers: { "content-type": "application/json" } });
    });
    const r = await applySnapshot(sampleSnapshot, { url: "https://x", adminToken: "t", fetch });
    expect(sentMode).toBe("additive");
    expect(r.created).toEqual(["posts"]);
  });

  it("applySnapshot honours sync mode", async () => {
    let sentMode: string | undefined;
    const fetch = mockFetch((_url, init) => {
      sentMode = (JSON.parse(init!.body as string) as { mode: string }).mode;
      return new Response(JSON.stringify({
        data: { created: [], updated: ["posts"], skipped: [], errors: [] },
      }), { headers: { "content-type": "application/json" } });
    });
    await applySnapshot(sampleSnapshot, { url: "https://x", adminToken: "t", fetch, mode: "sync" });
    expect(sentMode).toBe("sync");
  });

  it("throws on non-2xx", async () => {
    const fetch = mockFetch(() => new Response("nope", { status: 401, statusText: "Unauthorized" }));
    await expect(pullSnapshot({ url: "https://x", adminToken: "t", fetch })).rejects.toThrow(/401/);
  });

  it("attaches Authorization: Bearer header on every call", async () => {
    let captured: Record<string, string> | undefined;
    const fetch = mockFetch((_url, init) => {
      captured = init?.headers as Record<string, string>;
      return new Response(JSON.stringify(sampleSnapshot), {
        headers: { "content-type": "application/json" },
      });
    });
    await pullSnapshot({ url: "https://x", adminToken: "abc", fetch });
    expect(captured?.["Authorization"]).toBe("Bearer abc");
  });
});
