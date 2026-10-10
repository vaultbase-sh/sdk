import { HttpClient, type ClientOptions } from "./client.ts";
import { Collection, type CollectionFor } from "./collection.ts";
import { Files } from "./files.ts";
import { Batch } from "./batch.ts";
import { Custom } from "./custom.ts";
import { RealtimeManager } from "./realtime/manager.ts";
import { FlagsClient } from "./flags/manager.ts";
import { AdminAuth, CollectionAuth, SharedAuth } from "./auth/flows.ts";
import { defaultAuthStore, type AuthStore } from "./auth/store.ts";
import { q, field, rawFilter, type Filter } from "./filter.ts";
import type {
  AnyRecord,
  CollectionTypes,
  DefaultSchema,
  ListOptions,
  ListResponse,
  RealtimeEvent,
  SubscribeCallback,
  SubscribeFilter,
} from "./types.ts";

export interface VaultbaseOptions extends Partial<Omit<ClientOptions, "baseUrl">> {
  baseUrl: string;
}

/**
 * Top-level SDK entry. Generic param `S` is a `Schema` map emitted by
 * `vb-types`; defaults to a permissive shape so apps can opt out of
 * codegen and still compile.
 *
 *   const vb = new Vaultbase<Schema>({ baseUrl: "https://api.example.com" });
 *   const post = await vb.collection("posts").create({ title: "hi" });
 */
export class Vaultbase<S extends DefaultSchema = DefaultSchema> {
  readonly client: HttpClient;
  readonly auth: AuthInterface<S>;
  readonly files: Files;
  readonly custom: Custom;
  readonly realtime: RealtimeManager;
  readonly flags: FlagsClient;

  constructor(opts: VaultbaseOptions) {
    const authStore: AuthStore = opts.authStore ?? defaultAuthStore();
    const clientOpts: ClientOptions = { baseUrl: opts.baseUrl, authStore };
    if (opts.fetch) clientOpts.fetch = opts.fetch;
    if (opts.defaultAutoCancel !== undefined) clientOpts.defaultAutoCancel = opts.defaultAutoCancel;
    if (opts.authTransport) clientOpts.authTransport = opts.authTransport;
    if (opts.withCredentials !== undefined) clientOpts.withCredentials = opts.withCredentials;
    this.client = new HttpClient(clientOpts);

    this.auth = createAuth<S>(this.client);
    this.files = new Files(this.client);
    this.custom = new Custom(this.client);
    this.realtime = new RealtimeManager(this.client);
    this.flags = new FlagsClient(this.client);
  }

  /** Fetch a typed collection accessor. */
  collection<K extends keyof S & string>(name: K): CollectionFor<S[K]>;
  collection<R = AnyRecord, C = AnyRecord, U = AnyRecord>(
    name: string,
  ): Collection<R, C, U>;
  collection(name: string): Collection {
    return new Collection(this.client, name);
  }

  /** Build a fresh batch (max 100 ops, server-enforced). Per-op result types
   * are inferred from chained calls when a `Schema` generic is supplied. */
  batch(): Batch<S> { return new Batch<S>(this.client); }

  /**
   * Tagged-template filter builder. Interpolated values are escaped + quoted
   * per the server's filter expression grammar. See `./filter.ts` for the
   * encoding rules and the {@link field} escape hatch.
   *
   *   const filter = vb.q\`title ~ \${term} && status = \${"published"}\`;
   *   posts.list({ filter });
   */
  readonly q = q;
  /** Re-export for ergonomic access via the `vb.field("status")` form. */
  readonly field = field;

  /** Subscribe to a collection's realtime events. Returns an unsubscribe function. */
  subscribe<K extends keyof S & string>(
    collection: K,
    filter: SubscribeFilter,
    cb: SubscribeCallback<S[K]["record"]>,
  ): () => void;
  subscribe<R = AnyRecord>(
    collection: string,
    filter: SubscribeFilter,
    cb: SubscribeCallback<R>,
  ): () => void;
  subscribe(collection: string, filter: SubscribeFilter, cb: SubscribeCallback): () => void {
    return this.realtime.subscribe(collection, filter, cb);
  }

  /** Drop the realtime connection. Auth state untouched; call `auth.shared.logout()` for that. */
  closeRealtime(): void { this.realtime.closeNow(); }
}

// ── Auth surface ────────────────────────────────────────────────────────────
//
// `vb.auth` exposes:
//   - `vb.auth.<collection>.login(...)`      — per-auth-collection flows
//   - `vb.auth.admin.login(...)`              — admin flows
//   - `vb.auth.shared.refresh()/.logout()`    — shared flows
//
// On the JS side this is a Proxy so `vb.auth.users.login(...)` works without
// codegen knowing the collection names ahead of time. With codegen, the
// generic `S` narrows the keys.

type AuthInterface<S extends DefaultSchema> = {
  admin: AdminAuth;
  shared: SharedAuth;
} & {
  [K in keyof S]: CollectionAuth<S[K]["record"]>;
};

function createAuth<S extends DefaultSchema>(client: HttpClient): AuthInterface<S> {
  const admin = new AdminAuth(client);
  const shared = new SharedAuth(client);
  const cache = new Map<string, CollectionAuth>();
  const target: Record<string, unknown> = { admin, shared };
  return new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (typeof prop !== "string") return undefined;
      let c = cache.get(prop);
      if (!c) {
        c = new CollectionAuth(client, prop);
        cache.set(prop, c);
      }
      return c;
    },
  }) as AuthInterface<S>;
}

// ── Public re-exports ───────────────────────────────────────────────────────

export { HttpClient, EtagCache } from "./client.ts";
export { Collection } from "./collection.ts";
export { Files, type FileUrlParams } from "./files.ts";
export { Batch, type BatchOpResult, type BatchDeleteResult, type BatchResult } from "./batch.ts";
export { Custom } from "./custom.ts";
export { q, field, rawFilter, type Filter } from "./filter.ts";
export { RealtimeManager } from "./realtime/manager.ts";
export { FlagsClient } from "./flags/manager.ts";
export type { FlagsConnectOptions, FlagsChangeListener, FlagValue } from "./flags/manager.ts";
export {
  AdminAuth,
  CollectionAuth,
  SharedAuth,
} from "./auth/flows.ts";
export {
  MemoryAuthStore,
  SessionStorageAuthStore,
  LocalStorageAuthStore,
  CookieAuthStore,
  defaultAuthStore,
  type AuthStore,
  type StoredAuth,
} from "./auth/store.ts";
export {
  VaultbaseError,
  isVaultbaseError,
  type VaultbaseErrorData,
  type ErrorKind,
} from "./errors.ts";
export type {
  AnyRecord,
  CollectionTypes,
  DefaultSchema,
  ListOptions,
  ListResponse,
  RealtimeEvent,
  SubscribeCallback,
  SubscribeFilter,
};
