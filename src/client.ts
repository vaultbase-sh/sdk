import { VaultbaseError, type AuthOperation, type AuthReason } from "./errors.ts";
import { CancelRegistry } from "./cancel.ts";
import type { AuthStore } from "./auth/store.ts";
import { RefreshCoordinator } from "./auth/refresh.ts";

export interface ClientOptions {
  baseUrl: string;
  /** Custom fetch (for SSR / Node 16 polyfill / testing). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  authStore: AuthStore;
  /**
   * If true, calls without an explicit `requestKey` get one derived from
   * (method, path). Default false — opt-in via per-call `requestKey`.
   */
  defaultAutoCancel?: boolean;
  /** Preferred bearer-token transport. `"header"` always; cookies still attach via `credentials`. */
  authTransport?: "header" | "cookie-only";
  /** Send `credentials: "include"` so cookie-mode auth rides along. */
  withCredentials?: boolean;
  /**
   * When to `console.warn` the server's warnings (a realtime `warning` frame,
   * a `Vaultbase-Warning` header). `"dev"` (the default) warns unless
   * `process.env.NODE_ENV` is `"production"`; `onWarning` is called either way.
   */
  warnings?: "dev" | "always" | "off";
  /** Called with each server warning (server 0.42+), whatever `warnings` says. */
  onWarning?: (warning: VaultbaseWarning) => void;
}

/**
 * A warning the server sent: a realtime subscription to a collection that
 * doesn't exist, or a `Vaultbase-Warning` response header. Servers 0.42 and
 * 0.43 sent the header for an unknown sort, expand, fields or body key
 * (0.44 answers those 400); it is kept for future deprecation notices.
 */
export interface VaultbaseWarning {
  /** `http`: a `Vaultbase-Warning` response header. `realtime`: a `warning` frame. */
  source: "http" | "realtime";
  message: string;
  /** `http`: the request's method and path. */
  method?: string;
  path?: string;
  /** `realtime`: the frame's reason (e.g. `unknown_collection`) and topic. */
  reason?: string;
  topic?: string;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Opt-in cancel key. Pass `null` to explicitly disable when default is on. */
  requestKey?: string | null;
  signal?: AbortSignal;
  /** Skip JWT refresh + auth header (login, refresh, public endpoints). */
  skipAuth?: boolean;
  /**
   * Send the auth header but skip the proactive refresh. Used by the refresh
   * call itself: going through maybeRefresh() there awaited the in-flight
   * refresh from inside it, so it never settled.
   */
  skipRefresh?: boolean;
  /** @internal The bearer token this request sent, so a refusal only ends that session. */
  sentToken?: string;
  /** @internal Set on the one retry after a 401 + refresh. */
  retried?: boolean;
  /**
   * @internal Called with the raw response before it is decoded, for callers
   * that need a header the envelope drops (the singleton accessor's ETag).
   */
  onResponse?: (res: Response) => void;
}

interface JwtClaims { exp?: number; iat?: number; [k: string]: unknown }

/**
 * Cheap base64url JWT decode. Validates structure only — signature is the
 * server's job. Used to inspect `exp` for proactive refresh.
 */
export function decodeJwtPayload(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const mid = parts[1] ?? "";
  try {
    const padded = mid.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (padded.length % 4)) % 4;
    const decoded = atob(padded + "=".repeat(padLen));
    return JSON.parse(decoded) as JwtClaims;
  } catch {
    return null;
  }
}

const REFRESH_LEAD_SECONDS = 60;

/**
 * An API token (`vbat_…`, or its bare JWT with `aud: "api"`). It is
 * configuration, not a session: the server refuses to refresh one, and the
 * SDK never clears it.
 */
export function isApiToken(token: string): boolean {
  return token.startsWith("vbat_") || hasApiAudience(decodeJwtPayload(token));
}

function hasApiAudience(claims: JwtClaims | null): boolean {
  const aud = claims?.["aud"];
  return aud === "api" || (Array.isArray(aud) && aud[0] === "api");
}

/**
 * Per-record ETag cache used for optimistic concurrency. Populated whenever
 * the SDK sees an `ETag` response header on a `/api/v1/<collection>/<id>` path,
 * and consumed by `Collection.update` / `.delete` to auto-attach `If-Match`.
 *
 * In-memory only — pinned to the client instance, so concurrent `Vaultbase`
 * objects don't share state. SDK consumers can clear via `vb.client.etags.clear()`.
 */
export class EtagCache {
  /** Most recent last; the oldest go past this many (a long-running process reads many records). */
  static readonly MAX = 1000;
  private readonly map = new Map<string, string>();
  get(collection: string, id: string): string | undefined { return this.map.get(`${collection}:${id}`); }
  set(collection: string, id: string, etag: string): void {
    const key = `${collection}:${id}`;
    this.map.delete(key);
    this.map.set(key, etag);
    if (this.map.size > EtagCache.MAX) this.map.delete(this.map.keys().next().value!);
  }
  delete(collection: string, id: string): void { this.map.delete(`${collection}:${id}`); }
  clear(): void { this.map.clear(); }
}

export class HttpClient {
  readonly baseUrl: string;
  readonly authStore: AuthStore;
  readonly cancel = new CancelRegistry();
  readonly refresher: RefreshCoordinator;
  /** Per-record ETag cache, populated/consumed automatically by the SDK. */
  readonly etags = new EtagCache();
  private readonly fetcher: typeof fetch;
  private readonly defaultAutoCancel: boolean;
  /** Whether requests send cookies (`credentials: "include"`). */
  readonly withCredentials: boolean;
  private readonly authTransport: "header" | "cookie-only";
  private readonly warnings: "dev" | "always" | "off";
  private readonly onWarning: ((w: VaultbaseWarning) => void) | undefined;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.authStore = opts.authStore;
    this.fetcher = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultAutoCancel = opts.defaultAutoCancel ?? false;
    this.withCredentials = opts.withCredentials ?? true;
    this.authTransport = opts.authTransport ?? "header";
    this.warnings = opts.warnings ?? "dev";
    this.onWarning = opts.onWarning;
    this.refresher = new RefreshCoordinator(this);
  }

  /** @internal Hand a server warning to `onWarning` and, per the `warnings` option, the console. */
  emitWarning(w: VaultbaseWarning): void {
    try { this.onWarning?.(w); } catch { /* the app's callback mustn't break the request */ }
    if (this.warnings === "off" || (this.warnings === "dev" && !isDevelopment())) return;
    const where = w.source === "realtime" ? "realtime" : `${w.method ?? "GET"} ${w.path ?? ""}`;
    console.warn(`[vaultbase] ${where}: ${w.message}`);
  }

  /** Raw HTTP request. Translates status codes into `VaultbaseError`. */
  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const method = options.method ?? "GET";
    const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };

    if (!options.skipAuth) {
      if (!options.skipRefresh) await this.maybeRefresh();
      if (this.authTransport === "header") {
        const stored = this.authStore.get();
        if (stored?.token) headers.Authorization = `Bearer ${stored.token}`;
      }
    }
    const sentToken = headers.Authorization ? this.authStore.get()?.token : undefined;

    // Cancellation wiring
    let signal: AbortSignal | undefined = options.signal;
    let cancelKey: string | null = null;
    let cancelSignal: AbortSignal | undefined;
    let unmerge = (): void => {};
    if (options.requestKey !== null) {
      cancelKey = options.requestKey ?? (this.defaultAutoCancel ? `${method}:${path}` : null);
      if (cancelKey) {
        cancelSignal = this.cancel.acquire(cancelKey);
        const merged = mergeSignals(signal, cancelSignal);
        signal = merged.signal;
        unmerge = merged.dispose;
      }
    }

    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      body = options.body instanceof FormData ? options.body : JSON.stringify(options.body);
      if (options.body instanceof FormData) delete headers["Content-Type"];
    }

    // The key is held until the body is read, so a newer request with the
    // same key still cancels this one while its body is arriving.
    try {
      let res: Response;
      try {
        const init: RequestInit = { method, headers, ...(body !== undefined ? { body } : {}) };
        if (signal) init.signal = signal;
        if (this.withCredentials) init.credentials = "include";
        res = await this.fetcher(url, init);
      } catch (e) {
        if (signal?.aborted) { // the caller's signal, or a newer request with the same requestKey
          throw VaultbaseError.aborted();
        }
        throw VaultbaseError.network(e instanceof Error ? e.message : String(e), e);
      }
      // Only a success's ETag: a 412 carries the current one, and caching it
      // would let a blind retry of the same update overwrite the other write.
      if (res.ok) this.captureEtag(path, res);
      options.onResponse?.(res);
      const out = await this.handleResponse<T>(res, path, { ...options, ...(signal ? { signal } : {}), ...(sentToken ? { sentToken } : {}) });
      if (signal?.aborted) throw VaultbaseError.aborted();
      return out;
    } catch (e) {
      if (signal?.aborted && !(e instanceof VaultbaseError && e.kind === "aborted")) throw VaultbaseError.aborted();
      throw e;
    } finally {
      unmerge();
      if (cancelKey && cancelSignal) this.cancel.release(cancelKey, cancelSignal);
    }
  }

  /**
   * Inspect a response for `ETag` and stash it in {@link etags} when the path
   * targets a single-record endpoint (`/api/v1/<collection>/<id>`). Subpaths
   * (`.../history`, `.../restore`, `.../oauth2/...`) and list endpoints
   * (`/api/v1/<collection>`) are ignored.
   */
  private captureEtag(path: string, res: Response): void {
    const etag = res.headers.get("etag");
    if (!etag) return;
    // Accept both versioned (/api/v1/<col>/<id>) and legacy (/api/<col>/<id>).
    const m = /^\/api\/(?:v\d+\/)?([^/?#]+)\/([^/?#]+)(?:\?[^#]*)?$/.exec(path);
    if (!m) return;
    const [, collection, id] = m;
    if (!collection || !id) return;
    this.etags.set(decodeURIComponent(collection), decodeURIComponent(id), etag);
  }

  /** Build a URL with a query-string. Skips undefined values. */
  buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path, this.baseUrl + "/");
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /** @internal A response to the client's result or error; also used by the XHR upload path. */
  async handleResponse<T>(res: Response, path: string, options: RequestOptions): Promise<T> {
    const warning = res.headers.get("vaultbase-warning");
    if (warning) {
      const method = options.method ?? "GET";
      for (const message of warning.split(" | ").map((m) => m.trim()).filter(Boolean)) {
        this.emitWarning({ source: "http", message, method, path });
      }
    }
    try {
      return await this.decodeResponse<T>(res, path, options);
    } catch (e) {
      if (e instanceof VaultbaseError && e.status === undefined && e.kind !== "aborted" && e.kind !== "network") e.status = res.status;
      throw e;
    }
  }

  private async decodeResponse<T>(res: Response, path: string, options: RequestOptions): Promise<T> {
    if (res.status === 429) {
      const retryAfter = parseFloat(res.headers.get("retry-after") ?? "1");
      const retryAfterMs = Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000, 10_000);
      // Auth-refresh path is special-cased upstream; here we just throw.
      throw VaultbaseError.rateLimit(retryAfterMs);
    }

    let data: unknown = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try { data = await res.json(); } catch { data = null; }
    } else if (ct.includes("text/")) {
      try { data = await res.text(); } catch { data = null; }
    }

    if (res.status === 401) {
      const message = extractMessage(data) ?? "Unauthorized";
      const info = refusalInfo(data);
      // A request sent without the session says nothing about the session:
      // keep it (vb.flags with public evaluation off used to sign users out).
      if (options.skipAuth) throw VaultbaseError.auth("invalid", message, info);
      // Server 0.44+, on the records, files and batch APIs. An API token
      // without the scope for this request: signing in again can't fix it,
      // and the token is fine for what it does cover, so it stays.
      if (info.serverReason === "insufficient_scope") throw VaultbaseError.auth("forbidden", message, info);
      // Server 0.44+, same APIs: a token the server doesn't accept (expired,
      // revoked, malformed).
      const tokenInvalid = info.serverReason === "token_invalid";
      const sent = options.sentToken;
      // One refresh and one retry, never more: the retry is marked, so a 401
      // on it ends here whatever the refresh said.
      const current = this.authStore.get()?.token;
      // The session this request was sent with is gone (signed out, or ended
      // by another request's refused refresh): there is nothing to refresh.
      const gone = !!sent && !current;
      if (!options.retried && !gone && !(sent && isApiToken(sent)) && !path.endsWith("/api/v1/auth/refresh")) {
        // The session changed while this request was out (another request
        // refreshed it, or the user signed in again): send with that one.
        const replaced = !!sent && !!current && current !== sent;
        // A refresh that couldn't be answered (offline, 5xx) rejects: that
        // error is this request's, and the session stays.
        if (replaced || await this.refresher.refreshOnce()) {
          // Under this request's key and signal, which it still holds.
          return await this.request<T>(path, { ...options, skipAuth: false, retried: true, requestKey: null });
        }
      }
      // A token we just refreshed was refused too, and not for being invalid:
      // this endpoint refuses the caller (e.g. a route that requires a
      // non-guest account). The session is fine, so keep it.
      if (options.retried && !tokenInvalid) throw VaultbaseError.auth("forbidden", message, info);
      // Refused and not refreshable, or the server calls the fresh token
      // invalid too: the session is over.
      this.endSession(sent);
      throw VaultbaseError.auth("expired", message, info);
    }
    if (res.status === 403) {
      const info = refusalInfo(data);
      let reason: AuthReason = "forbidden";
      if (info.serverReason === "token_invalid") {
        // Servers 0.42 and 0.43 (0.44 answers 401): the token was refused
        // and the request ran as anonymous. That session is over.
        reason = "expired";
        if (options.sentToken) this.endSession(options.sentToken);
      } else if (info.serverReason === "not_signed_in") {
        reason = "not_signed_in";
      }
      throw VaultbaseError.auth(reason, extractMessage(data) ?? "Forbidden", info);
    }
    if (res.status === 400 || res.status === 422) {
      const details = (data as { details?: Record<string, string> } | null)?.details ?? {};
      throw VaultbaseError.validation(extractMessage(data) ?? (res.status === 400 ? "Bad request" : "Validation failed"), details);
    }
    if (res.status === 404) throw VaultbaseError.notFound(extractMessage(data) ?? "Not found", data ?? undefined);
    if (res.status === 409) throw VaultbaseError.conflict(409, extractMessage(data) ?? "Conflict");
    if (res.status === 412) {
      const etag = res.headers.get("etag") ?? undefined;
      throw VaultbaseError.preconditionFailed(extractMessage(data) ?? "Precondition Failed", etag);
    }
    if (res.status === 503) {
      const m = maintenanceInfo(data);
      if (m) {
        // The body carries the retry hint: Retry-After isn't readable cross-origin.
        const seconds = m.retry_after ?? parseFloat(res.headers.get("retry-after") ?? "");
        const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : undefined;
        throw VaultbaseError.maintenance(extractMessage(data) ?? "Down for maintenance", m.level === "read_only" ? "read_only" : "full", m.until, retryAfterMs);
      }
    }
    if (!res.ok) throw VaultbaseError.server(res.status, extractMessage(data) ?? `HTTP ${res.status}`, data);

    // Server uses a `{ data: T }` envelope for single-result endpoints. List
    // endpoints return the page envelope `{ data: T[], page, perPage, ... }`
    // directly — those must NOT be unwrapped or the page metadata is lost.
    if (data && typeof data === "object" && "data" in (data as Record<string, unknown>)) {
      const obj = data as Record<string, unknown>;
      const ENVELOPE_KEYS = new Set(["data", "error", "code", "details"]);
      const hasOtherKeys = Object.keys(obj).some((k) => !ENVELOPE_KEYS.has(k));
      if (!hasOtherKeys) return obj["data"] as T;
    }
    return data as T;
  }

  /**
   * End the session a refused request was sent with. A session that replaced
   * it meanwhile (signed in again) is left alone, and so is an API token:
   * clearing one would send the next requests as anonymous.
   */
  private endSession(sent: string | undefined): void {
    if (sent === undefined) { this.authStore.set(null); return; }
    if (isApiToken(sent)) return;
    if (this.authStore.get()?.token === sent) this.authStore.set(null);
  }

  /**
   * Decide if the stored token is close to expiring; if so, refresh once
   * (mutex'd). When the server refuses the refresh, the session is over:
   * it's cleared and this throws `auth`/`expired`, instead of sending the
   * request without a token (which came back as a confusing `forbidden`).
   * A refresh that couldn't be answered (offline, 5xx) keeps the session and
   * lets the request go. An API token is never refreshed.
   */
  async maybeRefresh(): Promise<void> {
    const stored = this.authStore.get();
    if (!stored?.token || stored.token.startsWith("vbat_")) return;
    const claims = decodeJwtPayload(stored.token);
    if (!claims?.exp || hasApiAudience(claims)) return;
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp - now > REFRESH_LEAD_SECONDS) return;
    const ok = await this.refresher.refreshOnce().catch(() => null);
    if (ok !== false) return;
    const current = this.authStore.get()?.token;
    // Signed in again while the refresh ran: send with that session.
    if (current && current !== stored.token) return;
    if (current) this.authStore.set(null);
    throw VaultbaseError.auth("expired", "Session expired; sign in again");
  }
}

function extractMessage(body: unknown): string | null {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: unknown }).error;
    if (typeof e === "string") return e;
  }
  return null;
}

/** `operation` and `reason` from a 403 or 401 body (server 0.42+; absent on older servers). */
function refusalInfo(body: unknown): { operation?: AuthOperation; serverReason?: string } {
  if (!body || typeof body !== "object") return {};
  const o = body as Record<string, unknown>;
  const ops: readonly string[] = ["create", "update", "delete", "view", "list"];
  return {
    ...(typeof o["operation"] === "string" && ops.includes(o["operation"]) ? { operation: o["operation"] as AuthOperation } : {}),
    ...(typeof o["reason"] === "string" ? { serverReason: o["reason"] } : {}),
  };
}

/**
 * Not a production build. Bundlers replace `process.env.NODE_ENV` with a
 * literal; a browser without that (no `process`) counts as development.
 */
function isDevelopment(): boolean {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return true;
  }
}

/** The `maintenance` object of a maintenance-mode 503, or null for any other body. */
function maintenanceInfo(body: unknown): { level?: string; until?: number; retry_after?: number } | null {
  if (!body || typeof body !== "object") return null;
  const m = (body as { maintenance?: unknown }).maintenance;
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  return {
    ...(typeof o["level"] === "string" ? { level: o["level"] } : {}),
    ...(typeof o["until"] === "number" ? { until: o["until"] } : {}),
    ...(typeof o["retry_after"] === "number" ? { retry_after: o["retry_after"] } : {}),
  };
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  if (!a) return { signal: b, dispose: () => {} };
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (a.aborted || b.aborted) { ctrl.abort(); return { signal: ctrl.signal, dispose: () => {} }; }
  a.addEventListener("abort", onAbort);
  b.addEventListener("abort", onAbort);
  // A caller's long-lived signal would otherwise collect a listener per request.
  return { signal: ctrl.signal, dispose: () => { a.removeEventListener("abort", onAbort); b.removeEventListener("abort", onAbort); } };
}
