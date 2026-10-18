/**
 * Live-server roundtrip. Spins a real Vaultbase, exercises the SDK end-to-end.
 *
 * Skipped automatically when the sibling vaultbase server source is not
 * resolvable (e.g., on a standalone clone of the SDK repo).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Vaultbase, VaultbaseError, isVaultbaseError } from "../../src/index.ts";
import { generateTypes, type SnapshotShape } from "../../src/codegen/generate.ts";
import { MemoryAuthStore } from "../../src/auth/store.ts";
import { startTestServer, serverAvailable } from "./server.ts";

const RUN = serverAvailable();
const d = RUN ? describe : describe.skip;

let server: Awaited<ReturnType<typeof startTestServer>>;
let vb: Vaultbase;

interface PostRecord { id: string; title: string; body?: string; cover?: string }

d("integration — SDK ↔ live Vaultbase", () => {
  beforeAll(async () => {
    server = await startTestServer();
    vb = new Vaultbase({
      baseUrl: server.baseUrl,
      authStore: new MemoryAuthStore(),
      withCredentials: false,
    });
    vb.client.authStore.set({ token: server.adminToken });

    // Seed a `posts` collection used by every test below.
    await vb.client.request("/api/v1/collections", {
      method: "POST",
      body: {
        name: "posts",
        type: "base",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "body",  type: "editor" },
          { name: "cover", type: "file" },
        ],
      },
    });
  });

  afterAll(() => {
    vb.closeRealtime();
    server?.cleanup();
  });

  it("admin /me returns the seeded admin", async () => {
    const me = await vb.auth.admin.me();
    expect(me.email).toBe(server.adminEmail);
    expect(me.aud).toBe("admin");
  });

  it("CRUDs a record through the typed Collection accessor", async () => {
    const created = await vb.collection<PostRecord>("posts").create({ title: "hello", body: "<p>hi</p>" });
    expect(created.id).toBeTruthy();

    const fetched = await vb.collection<PostRecord>("posts").get(created.id);
    expect(fetched.title).toBe("hello");

    const updated = await vb.collection<PostRecord>("posts").update(created.id, { title: "renamed" });
    expect(updated.title).toBe("renamed");

    const list = await vb.collection<PostRecord>("posts").list({ filter: 'title = "renamed"' });
    expect(list.data.length).toBeGreaterThanOrEqual(1);

    await vb.collection("posts").delete(created.id);
  });

  it("paginates via iterate() generator", async () => {
    for (let i = 0; i < 25; i++) {
      await vb.collection<PostRecord>("posts").create({ title: `gen-${i}` });
    }
    let count = 0;
    for await (const _r of vb.collection<PostRecord>("posts").iterate({
      filter: 'title ~ "gen-"',
      perPage: 10,
    })) {
      void _r;
      count++;
    }
    expect(count).toBeGreaterThanOrEqual(25);
  });

  it("batch endpoint executes mixed ops", async () => {
    const r = await vb.batch()
      .create("posts", { title: "b1" })
      .create("posts", { title: "b2" })
      .list("posts", { filter: 'title ~ "b"', perPage: 5 })
      .run();
    expect(r.length).toBe(3);
    expect(r[0]?.status).toBeGreaterThanOrEqual(200);
    expect(r[2]?.status).toBeGreaterThanOrEqual(200);
  });

  it("file upload + URL builder + delete", async () => {
    const post = await vb.collection<PostRecord>("posts").create({ title: "with-file" });
    const blob = new File([new Uint8Array([1, 2, 3, 4])], "tiny.bin", { type: "application/octet-stream" });
    const meta = await vb.files.upload("posts", post.id, "cover", blob);
    const m = Array.isArray(meta) ? meta[0]! : meta;
    expect(m.filename).toBeTruthy();
    expect(vb.files.url(m.filename)).toContain("/api/v1/files/");
    await vb.files.delete("posts", post.id, "cover", m.filename);
  });

  it("realtime: WS subscribes and receives a create event", async () => {
    const seen: string[] = [];
    const off = vb.subscribe<PostRecord>("posts", "*", (e) => {
      if (e.type === "create" && e.record?.title) seen.push(e.record.title);
    });

    await new Promise((r) => setTimeout(r, 250));
    await vb.collection<PostRecord>("posts").create({ title: "rt-event" });

    let waited = 0;
    while (seen.length === 0 && waited < 3000) {
      await new Promise((r) => setTimeout(r, 50));
      waited += 50;
    }
    off();
    expect(seen).toContain("rt-event");
  });

  it("codegen: generates compilable types from the live snapshot", async () => {
    const snap = await vb.client.request<SnapshotShape>("/api/v1/admin/migrations/snapshot");
    const ts = generateTypes(snap);
    expect(ts).toContain("export type Schema = {");
    expect(ts).toContain("PostsRecord");
    expect(ts).toContain("PostsCreate");
    expect(ts).toContain("title: string");
  });

  // The four SDK contract bugs from the 0.23.1 review, against the real server
  // (0.6.3 fixed them; the unit tests used mocks).
  it("iterate() with skipTotal pages past the first page", async () => {
    for (let i = 0; i < 12; i++) await vb.collection<PostRecord>("posts").create({ title: `skip-${i}` });
    let n = 0;
    for await (const _r of vb.collection<PostRecord>("posts").iterate({ filter: 'title ~ "skip-"', perPage: 5, skipTotal: true })) { void _r; n++; }
    expect(n).toBe(12);
  });

  it("iterate() with perPage above the server's cap of 500 gets everything", async () => {
    // 520 records in batches of 100 (the batch limit).
    for (let b = 0; b < 6; b++) {
      let batch = vb.batch();
      for (let i = 0; i < (b < 5 ? 100 : 20); i++) batch = batch.create("posts", { title: `cap-${b}-${i}` });
      await batch.run();
    }
    let n = 0;
    for await (const _r of vb.collection<PostRecord>("posts").iterate({ filter: 'title ~ "cap-"', perPage: 1000 })) { void _r; n++; }
    expect(n).toBe(520);
  });

  it('ifMatch: "auto" uses the cached ETag, not the literal "auto"', async () => {
    const posts = vb.collection<PostRecord>("posts");
    const p = await posts.create({ title: "etag" });
    await posts.get(p.id); // caches the ETag
    const updated = await posts.update(p.id, { title: "etag-2" }, { ifMatch: "auto" });
    expect(updated.title).toBe("etag-2");
  });

  it("singleton: get returns the one record with empty fields, update persists", async () => {
    await vb.client.request("/api/v1/collections", {
      method: "POST",
      body: {
        name: "site_settings",
        type: "singleton",
        fields: [
          { name: "title", type: "text" },
          { name: "maintenance", type: "bool" },
        ],
      },
    });
    interface Settings { id: string; title?: string | null; maintenance?: boolean | null }
    const settings = vb.singleton<Settings>("site_settings");

    const first = await settings.get();
    expect(first.id).toBeTruthy();
    expect(first.title ?? null).toBeNull();
    expect(first.maintenance ?? null).toBeNull();

    // Default ifMatch is "auto": the ETag from the get above rides along.
    const updated = await settings.update({ title: "My site", maintenance: true });
    expect(updated.id).toBe(first.id);
    expect(updated.title).toBe("My site");

    const again = await vb.singleton<Settings>("site_settings").get();
    expect(again.id).toBe(first.id);
    expect(again.title).toBe("My site");
    expect(again.maintenance).toBe(true);
  });

  it("singleton: a stale explicit ifMatch gives precondition_failed", async () => {
    const settings = vb.singleton<{ id: string; title?: string | null }>("site_settings");
    await settings.get();
    try {
      await settings.update({ title: "stale" }, { ifMatch: `W/"0"` });
      throw new Error("should have rejected");
    } catch (e) {
      expect(isVaultbaseError(e)).toBe(true);
      expect((e as VaultbaseError).kind).toBe("precondition_failed");
    }
    expect((await settings.get()).title).toBe("My site");
  });

  it("a one-time file token is not reused for a second URL", async () => {
    await vb.client.request("/api/v1/collections", {
      method: "POST",
      body: { name: "vault", type: "base", view_rule: null, list_rule: null, create_rule: null,
        fields: [{ name: "doc", type: "file", options: { protected: true, oneTimeToken: true } }] },
    });
    const rec = await vb.collection<{ id: string }>("vault").create({});
    const meta = await vb.files.upload("vault", rec.id, "doc", new File([new Uint8Array([5, 6, 7])], "secret.bin"));
    const filename = (Array.isArray(meta) ? meta[0]! : meta).filename;
    const first = await vb.files.urlWithToken("vault", rec.id, "doc", filename);
    const second = await vb.files.urlWithToken("vault", rec.id, "doc", filename);
    expect(second).not.toBe(first);
    expect((await fetch(first)).status).toBe(200);
    expect((await fetch(second)).status).toBe(200);
  });

  it("error model: 401 → kind=auth", async () => {
    const anon = new Vaultbase({
      baseUrl: server.baseUrl,
      authStore: new MemoryAuthStore(),
      withCredentials: false,
    });
    try {
      await anon.client.request("/api/v1/admin/auth/me");
      throw new Error("should have rejected");
    } catch (e) {
      const err = e as { kind?: string };
      expect(err.kind).toBe("auth");
    }
  });
});
