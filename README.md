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

This continues the server's [quick start](https://docs.vaultbase.dev/getting-started/quick-start/):
it uses its `posts` collection (`title`, `body`) and the `users` account you
signed up there.

```ts
import { Vaultbase } from "@vaultbase/sdk";

const vb = new Vaultbase({ baseUrl: "http://localhost:8091" });

// Sign in as the user from the quick start
const session = await vb.auth.users.login({
  email: "alice@example.com",
  password: "correct-horse-battery",
});
if ("mfa_required" in session) throw new Error("this account has MFA on");

// Create a post. The create rule is "Auth only", so this needs the sign-in
const post = await vb.collection("posts").create({ title: "hello from the SDK", body: "world" });
console.log("created", post.id);

// List the posts whose title contains "hello", newest first
const list = await vb.collection("posts").list({ filter: 'title ~ "hello"', sort: "-created" });
console.log(list.totalItems, list.data.map((p) => p.title));

// Print every change to posts as it happens. Create or edit a post in the
// admin to see one. Call off() to stop.
const off = vb.subscribe("posts", "*", (ev) => console.log(ev.type, ev.record));
```

For typed records, generate a `Schema` with [`vb-types`](#codegen--vb-types)
and pass it as `new Vaultbase<Schema>(...)`.

## Files

Needs a file field on the collection. See the [Files docs](https://docs.vaultbase.dev/sdk/files/).

```ts
const meta = await vb.files.upload("posts", post.id, "cover", file, {
  onProgress: ({ loaded, total }) => console.log(loaded / total),
});
const url = vb.files.url(meta.filename);
```

## Batch

```ts
// ≤ 100 ops, atomic, per-op tuple result
const [created, fetched] = await vb.batch()
  .create("posts", { title: "x" })
  .get("users", "u1")
  .run();
created.body.title;          // typed as PostRecord
fetched.body.email;          // typed as UserRecord

// Lists go in a batch of reads (a batch that writes can't list).
const [listed] = await vb.batch().list("posts", { perPage: 10 }).run();
listed.body.data[0].title;   // typed as ListResponse<PostRecord>
```

## Custom routes

Routes you add in the admin under **Hooks → Custom routes**
([docs](https://docs.vaultbase.dev/api/custom-routes/)) are called with
`vb.custom.get(path, query?)` and `vb.custom.post(path, body?)`.

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
| `Array<…>` | **throws** — the filter language has no list value; join comparisons with `\|\|` |
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

## View parameters (server 0.35+)

A view collection whose query uses `:name` placeholders takes their values as
`params`, on `list`, `get`, `iterate` and `aggregate`:

```ts
const top = await vb.collection("customer_revenue").list({
  params: { since: new Date("2026-10-01"), status: "paid" },
  sort: "-revenue",
});
```

A `Date` is sent as ISO 8601. `vb-types` emits a params type per view
(`CustomerRevenueParams`), so a missing required parameter or a wrong type is
a compile error. A parameter the view fills from the signed-in user isn't
settable and isn't in the type.

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
import { isVaultbaseError, type VaultbaseError } from "@vaultbase/sdk";

try {
  await vb.collection("posts").create({});
} catch (e) {
  if (!isVaultbaseError(e)) throw e;
  switch (e.kind) {
    case "validation":          showFieldErrors(e.data.details); break;
    case "auth":                handleAuth(e); break;
    case "not_found":           show404(); break;
    case "rate_limit":          await sleep(e.data.retryAfterMs); break;
    case "network":             toast("offline"); break;
    case "conflict":            showMessage(e.message); break;
    case "precondition_failed": reloadAndMerge(e.data.currentEtag); break;
    case "maintenance":         showDownPage(e.data.message, e.data.until); break;
    case "server":              report(e.data.status); break;
    case "aborted":             /* intentional, ignore */ break;
  }
}
```

| `kind` | When |
|---|---|
| `validation` | 422, or 400 (a bad filter, sort or body). `data.details` maps fields to messages. On server 0.44+ that includes a `sort`, `expand` or `fields` name, or a body key, that the collection doesn't have: see [Unknown names](#unknown-names-server-044). |
| `auth` | 401 and 403. See `reason` below. |
| `not_found` | 404: the record, collection or route doesn't exist, or the caller can't see it. |
| `conflict` | 409, e.g. registering an email that's already taken (`message` is the server's). |
| `precondition_failed` | 412: the `If-Match` ETag no longer matches. |
| `rate_limit` | 429. `data.retryAfterMs`. |
| `maintenance` | 503 from a server in maintenance mode. |
| `server` | Any other non-2xx (5xx and the rest). `data.status`, `data.body`. |
| `network`, `aborted` | No response, or the request was cancelled. |

Every error from a response also has `e.status` (the HTTP status).

`auth` errors carry `data.reason`:

| `reason` | Meaning | What to do |
|---|---|---|
| `expired` | The session ended: the token expired and couldn't be refreshed, or the server refused it (`token_invalid`). The SDK has cleared it, and a request it couldn't refresh for isn't sent. | Show sign-in. |
| `not_signed_in` | The request had no session and the collection's rule needs one. | Show sign-in. |
| `forbidden` | A rule or an admin-only endpoint refused the caller, or an API token doesn't have the scope for the request (`insufficient_scope`, server 0.44+). | Show "not allowed". |
| `invalid` | Wrong credentials. | Show the form error. |

On server 0.42+, a 403 also tells you which operation was refused and why:
`e.operation` (`create`, `update`, `delete`, `view`, `list`) and
`e.serverReason` (`not_signed_in`, `rule_denied`, `admin_only`). Both are
`undefined` on older servers.

```ts
function handleAuth(e: VaultbaseError) {
  if (e.data.kind !== "auth") return;
  if (e.data.reason === "expired" || e.data.reason === "not_signed_in") redirectToLogin();
  else toast(`You can't ${e.operation ?? "do"} this`);
}
```

### A token the server doesn't accept (server 0.44+)

From server 0.44 the records, files and batch APIs answer 401 when the
request's token is expired, revoked or malformed, even for public data. The
error has `e.status === 401` and `e.serverReason === "token_invalid"`.
(Servers 0.42 and 0.43 ran such a request as anonymous and put
`token_invalid` on the 403 of a refused one, which the SDK also reports as
`expired`.) An API token without the scope for the request answers 401 too,
with `e.serverReason === "insufficient_scope"`. What the SDK does depends on
the token:

- **A session** (a token from `login`): the SDK refreshes it once and sends
  the request again. If the server refuses the refresh, or refuses the new
  token too, the session is cleared and the call rejects with `expired`.
  Requests after that go out without a token.
- **An API token** (`vbat_…`, set with `vb.client.authStore.set({ token })`)
  is configuration, not a session: the SDK never refreshes or clears it. An
  expired or revoked one rejects with `expired` on every call, until you set
  a new one. One without the scope for the request (a `read` token that
  writes) rejects with `forbidden` and the server reason
  `insufficient_scope`: signing in again can't fix it, so nothing is
  refreshed or cleared, and `e.message` is the server's ("This API token
  doesn't have the scope for this request").

### Unknown names (server 0.44+)

From server 0.44, a `list` with a `sort`, `expand` or `fields` name the
collection doesn't have, and a `create` or `update` with a body key that
isn't a field, reject with `validation` (a 400) instead of being ignored.
`data.details` is keyed by the query parameter or the body key:

```ts
try {
  await vb.collection("posts").list({ sort: "-titel" });
} catch (e) {
  if (isVaultbaseError(e) && e.data.kind === "validation") {
    e.data.details; // { sort: "unknown sort field 'titel'" }
  }
}
// create({ title: "x", colour: "red" })
//   → details: { colour: "unknown field 'colour' in body" }
```

A record can still be saved back as it was fetched: `id`, `created`,
`updated`, `collectionId`, `collectionName` and `expand` are accepted and
ignored, and so are `email_verified`, `totp_enabled` and `is_anonymous` on an
auth collection. View collections aren't checked. The SDK adds no keys of its
own to a query or a body.

## Server warnings

The server (0.42+) warns about a request that works but probably doesn't do
what you meant. Today that is a realtime subscription to a collection that
doesn't exist (`source: "realtime"`). The SDK logs warnings with
`console.warn("[vaultbase] ...")` in development (unless
`process.env.NODE_ENV` is `"production"`), and hands each one to `onWarning`:

```ts
const vb = new Vaultbase({
  baseUrl,
  warnings: "dev",             // "dev" (default) | "always" | "off": console only
  onWarning: (w) => {          // always called, whatever `warnings` says
    // w.source: "http" | "realtime"; w.message
    // http: w.method, w.path; realtime: w.reason, w.topic
    reportToSentry(w);
  },
});
```

The `Vaultbase-Warning` response header (`source: "http"`) is reserved for
future deprecation notices. Servers 0.42 and 0.43 sent it for an unknown
sort, expand, fields or body key; server 0.44 answers those with a 400
([Unknown names](#unknown-names-server-044)) and sends no header. The SDK
still reads it, so warnings from those two versions keep arriving.

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
