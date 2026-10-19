import { VaultbaseError } from "./errors.ts";
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
 * Per-record ETag cache used for optimistic concurrency. Populated whenever
 * the SDK sees an `ETag` response header on a `/api/v1/<collection>/<id>` path,
 * and consumed by `Collection.update` / `.delete` to auto-attach `If-Match`.
 *
 * In-memory only — pinned to the client instance, so concurrent `Vaultbase`
 * objects don't share state. SDK consumers can clear via `vb.client.etags.clear()`.
 */
export class EtagCache {
  private readonly map = new Map<string, string>();
  get(collection: string, id: string): string | undefined { return this.map.get(`${collection}:${id}`); }
  set(collection: string, id: string, etag: string): void { this.map.set(`${collection}:${id}`, etag); }
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
  private readonly withCredentials: boolean;
  private readonly authTransport: "header" | "cookie-only";

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.authStore = opts.authStore;
    this.fetcher = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultAutoCancel = opts.defaultAutoCancel ?? false;
    this.withCredentials = opts.withCredentials ?? true;
    this.authTransport = opts.authTransport ?? "header";
    this.refresher = new RefreshCoordinator(this);
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

    // Cancellation wiring
    let signal: AbortSignal | undefined = options.signal;
    let cancelKey: string | null = null;
    if (options.requestKey !== null) {
      cancelKey = options.requestKey ?? (this.defaultAutoCancel ? `${method}:${path}` : null);
      if (cancelKey) {
        const cancelSignal = this.cancel.acquire(cancelKey);
        signal = mergeSignals(signal, cancelSignal);
      }
    }

    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      body = options.body instanceof FormData ? options.body : JSON.stringify(options.body);
      if (options.body instanceof FormData) delete headers["Content-Type"];
    }

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
    } finally {
      if (cancelKey && signal) this.cancel.release(cancelKey, signal);
    }

    this.captureEtag(path, res);
    options.onResponse?.(res);
    return await this.handleResponse<T>(res, path, options);
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

  private async handleResponse<T>(res: Response, path: string, options: RequestOptions): Promise<T> {
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
      // A request sent without the session says nothing about the session:
      // keep it (vb.flags with public evaluation off used to sign users out).
      if (options.skipAuth) throw VaultbaseError.auth("invalid", extractMessage(data) ?? "Unauthorized");
      // Try a single refresh+retry for non-auth-flow paths.
      if (!options.skipAuth && !options.retried && !path.endsWith("/api/v1/auth/refresh")) {
        const ok = await this.refresher.refreshOnce().catch(() => false);
        if (ok) {
          return await this.request<T>(path, { ...options, skipAuth: false, retried: true });
        }
      }
      // A token we just refreshed was refused too: this endpoint refuses the
      // caller (e.g. a route that requires a non-guest account). The session
      // is fine, so keep it; refreshing again would only loop.
      if (options.retried) {
        throw VaultbaseError.auth("forbidden", extractMessage(data) ?? "Unauthorized");
      }
      this.authStore.set(null);
      throw VaultbaseError.auth("expired", extractMessage(data) ?? "Unauthorized");
    }
    if (res.status === 403) throw VaultbaseError.auth("forbidden", extractMessage(data) ?? "Forbidden");
    if (res.status === 422) {
      const details = (data as { details?: Record<string, string> } | null)?.details ?? {};
      throw VaultbaseError.validation(extractMessage(data) ?? "Validation failed", details);
    }
    if (res.status === 409) throw VaultbaseError.conflict(409, extractMessage(data) ?? "Conflict");
    if (res.status === 412) {
      const etag = res.headers.get("etag") ?? undefined;
      throw VaultbaseError.preconditionFailed(extractMessage(data) ?? "Precondition Failed", etag);
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

  /** Decide if the stored token is close to expiring; if so, refresh once (mutex'd). */
  async maybeRefresh(): Promise<void> {
    const stored = this.authStore.get();
    if (!stored?.token) return;
    const claims = decodeJwtPayload(stored.token);
    if (!claims?.exp) return;
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp - now > REFRESH_LEAD_SECONDS) return;
    await this.refresher.refreshOnce().catch(() => false);
  }
}

function extractMessage(body: unknown): string | null {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: unknown }).error;
    if (typeof e === "string") return e;
  }
  return null;
}

function mergeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!a) return b!;
  if (!b) return a;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (a.aborted || b.aborted) ctrl.abort();
  else { a.addEventListener("abort", onAbort); b.addEventListener("abort", onAbort); }
  return ctrl.signal;
}
