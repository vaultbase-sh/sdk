<p align="center">
  <a href="https://vaultbase.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vaultbase-sh/vaultbase/main/assets/vaultbase-wordmark.svg">
      <img src="https://raw.githubusercontent.com/vaultbase-sh/vaultbase/main/assets/vaultbase-wordmark-light.svg" alt="Vaultbase" width="300">
    </picture>
  </a>
</p>

<h3 align="center"><code>@vaultbase/sdk</code></h3>

<p align="center">Typed REST + realtime client: browsers, Node, Bun, Deno</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@vaultbase/sdk"><img alt="npm version" src="https://img.shields.io/npm/v/%40vaultbase%2Fsdk?style=flat-square&color=e85a4f"></a>
  <a href="https://www.npmjs.com/package/@vaultbase/sdk"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40vaultbase%2Fsdk?style=flat-square&color=1b1a1a"></a>
  <img alt="TypeScript types included" src="https://img.shields.io/npm/types/@vaultbase/sdk?style=flat-square&color=1b1a1a">
  <img alt="Node 18+" src="https://img.shields.io/node/v/%40vaultbase%2Fsdk?style=flat-square&color=1b1a1a">
  <a href="https://github.com/vaultbase-sh/sdk/blob/master/LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/%40vaultbase%2Fsdk?style=flat-square&color=1b1a1a"></a>
</p>

<p align="center">
  <a href="https://vaultbase.dev">Vaultbase</a> ·
  <a href="https://docs.vaultbase.dev/sdk/quick-start/">Docs</a> ·
  <a href="https://github.com/vaultbase-sh/vaultbase">Server</a> ·
  <a href="https://www.npmjs.com/package/@vaultbase/sdk">npm</a>
</p>

Official TypeScript SDK for [Vaultbase](https://vaultbase.dev) — a typed
REST + WebSocket / SSE client. Zero runtime dependencies, ESM + CJS dual
build, works in browsers, Node 18+, Bun, and Deno.

```bash
npm install @vaultbase/sdk
# or
bun add @vaultbase/sdk
```

## Quick start

```ts
import { Vaultbase } from "@vaultbase/sdk";
import type { Schema } from "./vaultbase-schema.gen";  // optional, from codegen

const vb = new Vaultbase<Schema>({ baseUrl: "https://api.example.com" });

// Auth
const { token, record } = await vb.auth.users.login({
  email: "alice@x.com",
  password: "supersecret",
});

// Records — typed end-to-end
const post = await vb.collection("posts").create({ title: "hi", author: record.id });

// Safe filter via tagged template (escapes + quotes per type)
const list = await vb.collection("posts").list({
  filter: vb.q`status = ${"published"} && title ~ ${userTerm}`,
  sort: '-created',
  perPage: 30,
});

// Realtime — WebSocket with SSE auto-fallback
const off = vb.subscribe("posts", "*", (e) => {
  console.log(e.type, e.record);
});
off();

// Files
const meta = await vb.files.upload("posts", post.id, "cover", file, {
  onProgress: ({ loaded, total }) => console.log(loaded / total),
});
const url = vb.files.url(meta.filename);

// Batch (≤ 100 ops, atomic, per-op tuple result)
const [created, fetched, listed] = await vb.batch()
  .create("posts", { title: "x" })
  .get("users", "u1")
  .list("posts", { perPage: 10 })
  .run();
created.body.title;          // typed as PostRecord
fetched.body.email;          // typed as UserRecord
listed.body.data[0].title;   // typed as ListResponse<PostRecord>
```

## Typed filter builder (`vb.q`)

Tagged-template filter that handles encoding + escaping per JS type. Stops
quote-bug + injection-shaped mistakes at the type system layer.

```ts
import { Vaultbase, field } from "@vaultbase/sdk";

const term = req.query.q;
const filter = vb.q`title ~ ${term} && status = ${"published"} && deleted = ${false}`;
//                  ↓
//   `title ~ "hello" && status = "published" && deleted = false`
```

| Value | Encoded as |
|---|---|
| `string` | quoted with `"…"`, embedded `\` and `"` escaped |
| `number` | bare; rejects `NaN` / `±Infinity` |
| `boolean` | `true` / `false` |
| `null` | `null` |
| `Date` | quoted ISO-8601 string |
| `Array<…>` | `(v1, v2, …)` for use with `?=` / `?~` array-prefix ops |
| `field("name")` | bare identifier (validated against the same regex the server uses) |
| `undefined` | **throws** — use `null` |
| anything else | **throws** |

`field()` is the escape hatch when the *column* is dynamic:

```ts
const col = userPicked === "title" ? "title" : "created_at";
const f = vb.q`${field(col)} != ${null}`;
```

## Search, aggregations, images (server 0.15+)

```ts
// Full-text search over the collection's searchable fields, ranked by relevance.
const hits = await vb.collection("posts").list({ search: "quick bro", perPage: 20 });

// Count / sum / avg / min / max, grouped by fields or time buckets.
const byStatus = await vb.collection("orders").aggregate({
  agg: ["count", "sum(amount)"],
  groupBy: "status",
  sort: "-sum_amount",
});

// Resized, re-encoded image URL.
const src = vb.files.url(post.cover, { thumb: "800x0", format: "auto", quality: 75 });
```

On older servers `search`, `aggregate()`, `format` and `quality` are not
available; everything else in this SDK version still works.

## Singleton collections (`vb.singleton`)

A collection of type `singleton` holds exactly one record (site settings, a
feature config), created with the collection with its fields empty. Read and
update it at the collection's own path — no id needed:

```ts
const settings = await vb.singleton("site_settings").get({ expand: "owner" });
//   → GET /api/v1/site_settings

await vb.singleton("site_settings").update({ maintenance: true });
//   → PATCH /api/v1/site_settings
//     If-Match: <ETag from the last get/update of this singleton>
```

`update` takes the same `ifMatch` option as `collection().update` (`"auto"`
by default, an explicit ETag, or `false`); a stale tag throws
`VaultbaseError(kind: "precondition_failed")`. With codegen, singletons are
marked `singleton: true` in `Schema` and `vb.singleton("name")` is typed;
realtime updates arrive on `vb.subscribe("site_settings", ...)` like any
collection. Creating or deleting the record is refused by the server (405).

## Optimistic concurrency (ETag / `If-Match`)

The SDK auto-caches per-record ETags from `GET /api/v1/<col>/<id>` responses
and auto-attaches `If-Match` on the next `update` / `delete`:

```ts
const post = await vb.collection("posts").get("p1");
//   → vb.client.etags now has W/"<updated_at>" cached for posts:p1

await vb.collection("posts").update("p1", { title: "new" });
//   → PATCH /api/v1/posts/p1
//     If-Match: W/"<cached>"
//
// If the record changed since the get, the server returns 412 and the SDK
// throws VaultbaseError(kind: "precondition_failed", currentEtag).
```

Per-call overrides:

```ts
await coll.update("p1", body, { ifMatch: false });        // skip precondition
await coll.update("p1", body, { ifMatch: storedEtag });   // explicit override
```

Catching the conflict:

```ts
try {
  await coll.update("p1", body);
} catch (e) {
  if (isVaultbaseError(e) && e.kind === "precondition_failed") {
    const fresh = await coll.get("p1");
    // …re-merge edits, retry…
  }
}
```

A successful `delete` clears the cached entry so a subsequent re-create
doesn't carry the stale tag forward.

## Codegen — `vb-types`

Snapshot mode (recommended):

```bash
# One-time: capture the schema
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.example.com/api/v1/admin/migrations/snapshot \
  > vaultbase-schema.json

# Anyone can regen types from the committed JSON, no admin token:
npx vb-types --schema=./vaultbase-schema.json --out=./vaultbase-schema.gen.ts
```

Live mode (dev only):

```bash
npx vb-types --url=https://api.example.com --admin-token=$VB_ADMIN
```

## Schema migrations — `vb-migrate`

Diff and apply schema snapshots between environments. Three subcommands hit
the existing `/api/v1/admin/migrations/{snapshot,diff,apply}` endpoints.

```bash
# Pull a snapshot from prod
npx vb-migrate pull \
  --url=https://prod.example.com --admin-token=$PROD \
  --out=./schema.json

# Diff against staging
npx vb-migrate diff \
  --url=https://staging.example.com --admin-token=$STAGING \
  --schema=./schema.json

# Apply (requires --yes; refuses in non-interactive contexts otherwise)
npx vb-migrate apply \
  --url=https://staging.example.com --admin-token=$STAGING \
  --schema=./schema.json --mode=additive --yes
```

Modes:
- `additive` (default) — only create missing collections / fields. Never updates.
- `sync` — also push updates to existing collections to match the snapshot.

Flags:
- `--yes` / `-y` — required for non-interactive apply
- `--dry-run` — diff + plan, exit before writing

Programmatic API at `@vaultbase/sdk/migrate`:

```ts
import { pullSnapshot, diffSnapshot, applySnapshot } from "@vaultbase/sdk/migrate";

const snap = await pullSnapshot({ url, adminToken });
const diff = await diffSnapshot(snap, { url: targetUrl, adminToken });
if (diff.some((d) => d.kind !== "unchanged")) {
  await applySnapshot(snap, { url: targetUrl, adminToken, mode: "sync" });
}
```

## Auth stores

Default browser store is `SessionStorageAuthStore` (survives F5, dies on
tab close — XSS-safer than `localStorage`). Default off-browser is
`MemoryAuthStore`.

```ts
import { LocalStorageAuthStore, CookieAuthStore } from "@vaultbase/sdk";

const vb = new Vaultbase({
  baseUrl,
  // For cross-tab persistence (XSS exposure caveat applies):
  authStore: new LocalStorageAuthStore(),
});

// SSR / cookie deployments — host writes the HttpOnly cookie:
const vb2 = new Vaultbase({
  baseUrl,
  authStore: new CookieAuthStore(),
  authTransport: "cookie-only",
});
```

## Error handling

Every call rejects with a `VaultbaseError`. Switch on `kind` instead of
string-matching:

```ts
import { isVaultbaseError } from "@vaultbase/sdk";

try {
  await vb.collection("posts").create({});
} catch (e) {
  if (!isVaultbaseError(e)) throw e;
  switch (e.kind) {
    case "validation":          showFieldErrors(e.data.details); break;
    case "auth":                redirectToLogin(); break;
    case "rate_limit":          await sleep(e.data.retryAfterMs); break;
    case "network":             toast("offline"); break;
    case "conflict":            reload(); break;
    case "precondition_failed": reloadAndMerge(e.data.currentEtag); break;
    case "server":              report(e.data.status); break;
    case "aborted":             /* intentional, ignore */ break;
  }
}
```

## Auto-cancel

Off by default. Opt in per call:

```ts
vb.collection("posts").list(
  { filter: vb.q`title ~ ${q}` },
  { requestKey: "search-box" }, // new request with same key aborts the previous
);
```

## Realtime

WebSocket-first. Falls back to SSE when WS is blocked. Reconnects with
exponential backoff + jitter; re-subscribes on every reconnect.

```ts
const off  = vb.subscribe("posts", "*",          (e) => {});
const off2 = vb.subscribe("posts", "abc123",     (e) => {});  // single record
const off3 = vb.subscribe("posts", ["a", "b"],   (e) => {});  // multi-topic
```

The server's `security.allowed_origins` setting must include your page's
origin. SDK surfaces upgrade rejection as `{ kind: "auth", reason: "forbidden" }`.

## Sub-path exports

| Import | Purpose |
|---|---|
| `@vaultbase/sdk` | Main client + auth + records + filter + batch |
| `@vaultbase/sdk/realtime` | Standalone realtime manager (advanced — `vb.subscribe` covers the common case) |
| `@vaultbase/sdk/codegen` | Programmatic schema → TS code generation |
| `@vaultbase/sdk/migrate` | `pullSnapshot` / `diffSnapshot` / `applySnapshot` for env-to-env workflows |

## Versioning

SDK semver is independent of the server. The `vaultbaseServerCompat`
field in `package.json` advertises the supported server range. SDK
patch / minor releases never require a server upgrade.

## License

MIT.
