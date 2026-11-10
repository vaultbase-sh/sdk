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

  it("get(id) takes fields and expand", async () => {
    const created = await vb.collection<PostRecord>("posts").create({ title: "shaped", body: "<p>long</p>" });
    const slim = await vb.collection<PostRecord>("posts").get(created.id, { fields: "title" });
    expect(slim).toEqual({ id: created.id, title: "shaped" } as PostRecord);
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
    // A batch that writes can't also list (the server answers 422); lists go
    // in a batch of reads.
    const r = await vb.batch()
      .create("posts", { title: "b1" })
      .create("posts", { title: "b2" })
      .run();
    expect(r.length).toBe(2);
    expect(r[0]?.status).toBeGreaterThanOrEqual(200);
    const reads = await vb.batch().list("posts", { filter: 'title ~ "b"', perPage: 5 }).run();
    expect(reads[0]?.status).toBe(200);
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

  // ── Server 0.44: 401 for a token that isn't accepted, 400 for unknown keys ──

  /** A client of its own (its own session), recording the requests it makes. */
  function client(token?: string): { vb: Vaultbase; calls: string[] } {
    const calls: string[] = [];
    const recording = ((url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      calls.push(`${init?.method ?? "GET"} ${new URL(href).pathname}`);
      return fetch(url, init);
    }) as typeof fetch;
    const c = new Vaultbase({ baseUrl: server.baseUrl, authStore: new MemoryAuthStore(), withCredentials: false, fetch: recording });
    if (token) c.client.authStore.set({ token });
    return { vb: c, calls };
  }
  const caught = async (p: Promise<unknown>) => (await p.catch((e) => e)) as VaultbaseError;
  interface NoteRecord { id: string; title?: string | null; author?: string | null; [k: string]: unknown }
  const open = { list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null };
  const INVALID = { kind: "auth", reason: "expired", message: "Token expired or invalid", serverReason: "token_invalid" } as const;

  it("0.44 setup: an auth collection and a collection open to everyone", async () => {
    await vb.client.request("/api/v1/collections", {
      method: "POST",
      body: { name: "members", type: "auth", ...open, fields: [{ name: "nick", type: "text" }] },
    });
    await vb.client.request("/api/v1/collections", {
      method: "POST",
      body: {
        name: "notes", type: "base", ...open,
        fields: [
          { name: "title", type: "text" },
          { name: "author", type: "relation", collection: "members" },
          { name: "cover", type: "file" },
        ],
      },
    });
    await vb.auth.members.register({ email: "member@test.local", password: "long-password-123" });
  });

  it("a token the server doesn't accept: 401 on a public read, the session ends, then the read works", async () => {
    const { vb: stale, calls } = client("not-a-real-token");
    const err = await caught(stale.collection("notes").list());
    expect(err).toBeInstanceOf(VaultbaseError);
    expect(err.data).toEqual(INVALID);
    expect(err.status).toBe(401);
    // One request, one refresh the server refused, no retry.
    expect(calls).toEqual(["GET /api/v1/notes", "POST /api/v1/auth/refresh"]);
    expect(stale.client.authStore.get()).toBeNull();
    expect((await stale.collection("notes").list()).data).toBeArray();
  });

  it("the batch and files APIs answer the same 401", async () => {
    expect((await caught(client("not-a-real-token").vb.batch().list("notes").run())).data).toEqual(INVALID);
    expect((await caught(client("not-a-real-token").vb.files.delete("notes", "some-id", "cover"))).data).toEqual(INVALID);
    const file = new File([new Uint8Array([1])], "a.bin");
    expect((await caught(client("not-a-real-token").vb.files.upload("notes", "some-id", "cover", file))).data).toEqual(INVALID);
  });

  it("a token another client already refreshed: 401, one refresh, the request goes through", async () => {
    const { vb: first } = client();
    await first.auth.members.login({ email: "member@test.local", password: "long-password-123" });
    const original = first.client.authStore.get()!.token;
    const { vb: second, calls } = client(original);
    await first.auth.shared.refresh(); // ends `original`
    expect((await second.collection("notes").list()).data).toBeArray();
    expect(calls).toEqual(["GET /api/v1/notes", "POST /api/v1/auth/refresh", "GET /api/v1/notes"]);
    expect(second.client.authStore.get()?.token).not.toBe(original);
    expect(second.client.authStore.get()?.token).toBe(first.client.authStore.get()!.token);
  });

  it("an API token without the scope is refused, kept, and still reads; revoked, it is reported and kept", async () => {
    const minted = await vb.client.request<{ id: string; token: string }>("/api/v1/admin/api-tokens", {
      method: "POST",
      body: { name: "read-only", scopes: ["read"] },
    });
    expect(minted.token).toStartWith("vbat_");
    const { vb: bot, calls } = client(minted.token);
    expect((await bot.collection("notes").list()).data).toBeArray();

    const refused = await caught(bot.collection("notes").create({ title: "x" }));
    expect(refused.data).toEqual({
      kind: "auth", reason: "forbidden",
      message: "This API token doesn't have the scope for this request",
      serverReason: "insufficient_scope",
    });
    expect(refused.status).toBe(401);
    expect(bot.client.authStore.get()?.token).toBe(minted.token);
    expect((await bot.collection("notes").list()).data).toBeArray();

    await vb.client.request(`/api/v1/admin/api-tokens/${minted.id}`, { method: "DELETE" });
    expect((await caught(bot.collection("notes").list())).data).toEqual(INVALID);
    expect(bot.client.authStore.get()?.token).toBe(minted.token);
    // Never refreshed: the server refuses that for an API token.
    expect(calls).not.toContain("POST /api/v1/auth/refresh");
  });

  it("an unknown sort, expand or fields name is a validation error with details", async () => {
    const err = await caught(vb.collection("notes").list({ sort: "-titel", expand: "autor", fields: "id,titel" }));
    expect(err.kind).toBe("validation");
    expect(err.status).toBe(400);
    expect(err.message).toContain("unknown expand 'autor'");
    expect(err.data).toMatchObject({
      details: {
        sort: "unknown sort field 'titel'",
        expand: "unknown expand 'autor' (not a relation field)",
        fields: "unknown field 'titel' in fields",
      },
    });
    // The names the README uses, and the ones a record comes back with.
    const ok = await vb.collection<NoteRecord>("notes").list({ sort: "-created,title", expand: "author", fields: "id,title,expand" });
    expect(ok.data).toBeArray();
  });

  it("a body key that isn't a field is a validation error keyed by that key", async () => {
    const notes = vb.collection<NoteRecord>("notes");
    const create = await caught(notes.create({ title: "x", colour: "red" }));
    expect(create.data).toEqual({ kind: "validation", message: "Unknown field 'colour' in body", details: { colour: "unknown field 'colour' in body" } });
    const note = await notes.create({ title: "x" });
    const update = await caught(notes.update(note.id, { titel: "y" }));
    expect(update.data).toMatchObject({ kind: "validation", details: { titel: "unknown field 'titel' in body" } });
    expect((await notes.get(note.id)).title).toBe("x");
  });

  it("a fetched record saves back as it came, expand and auth columns included", async () => {
    const { vb: member } = client();
    const session = await member.auth.members.login({ email: "member@test.local", password: "long-password-123" });
    if ("mfa_required" in session) throw new Error("unexpected MFA");
    const me = session.record as { id: string };

    const notes = vb.collection<NoteRecord>("notes");
    const note = await notes.create({ title: "mine", author: me.id });
    const fetched = await notes.get(note.id, { expand: "author" });
    expect(Object.keys(fetched)).toEqual(expect.arrayContaining(["id", "created", "updated", "collectionId", "collectionName", "expand"]));
    expect((await notes.update(note.id, { ...fetched, title: "saved" })).title).toBe("saved");

    const members = member.collection<{ id: string; nick?: string | null; [k: string]: unknown }>("members");
    const user = await members.get(me.id);
    expect(Object.keys(user)).toEqual(expect.arrayContaining(["email", "email_verified", "totp_enabled", "is_anonymous"]));
    expect((await members.update(me.id, { ...user, nick: "kay" })).nick).toBe("kay");
  });

  it("codegen: every key of a generated Create type is a key the server takes", async () => {
    const snap = await vb.client.request<SnapshotShape>("/api/v1/admin/migrations/snapshot");
    const ts = generateTypes(snap);
    const body = /export interface NotesCreate \{([^}]*)\}/.exec(ts)?.[1] ?? "";
    const keys = [...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]!);
    expect(keys).toEqual(["title", "author", "cover"]);
    const all = Object.fromEntries(keys.map((k) => [k, null]));
    const created = await vb.collection<NoteRecord>("notes").create(all);
    expect((await vb.collection<NoteRecord>("notes").update(created.id, all)).id).toBe(created.id);
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
