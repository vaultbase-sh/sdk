import { decodeJwtPayload, type HttpClient } from "./client.ts";
import type { FileMeta, UploadOptions } from "./types.ts";
import { VaultbaseError } from "./errors.ts";

interface TokenResponse {
  token: string;
  expires_at: number;
  /** Set by servers that report it: the token is consumed on first download. */
  one_time?: boolean;
}

/** Image transform options for {@link Files.url}. */
export interface FileUrlParams {
  /** `WxH`, `WxH_cover`, or one side 0 to keep the aspect ratio (`400x0`). */
  thumb?: string;
  fit?: "contain" | "cover" | "crop";
  /** Re-encode the image. `auto` picks webp when the browser accepts it (server 0.15+). */
  format?: "webp" | "jpeg" | "png" | "auto";
  /** 1-100, for jpeg / webp output (server 0.15+). */
  quality?: number;
}

/**
 * File upload / download / token minting. Auto-mints + caches per-filename
 * access tokens for `protected: true` fields, refreshing ~60s before expiry.
 * One-time tokens are never cached, and the cache is dropped whenever the
 * signed-in identity changes (the token was granted to the previous one).
 */
export class Files {
  private tokenCache = new Map<string, TokenResponse>();
  /** Identity the cached tokens were minted for; `undefined` until the first mint. */
  private cacheIdentity: string | null | undefined;

  constructor(private readonly client: HttpClient) {}

  /** Upload one or more files. Multi-file fields accept `File[]`. */
  async upload(
    collection: string,
    recordId: string,
    field: string,
    file: File | File[],
    opts: UploadOptions = {},
  ): Promise<FileMeta | FileMeta[]> {
    const fd = new FormData();
    const files = Array.isArray(file) ? file : [file];
    for (const f of files) fd.append("file", f);

    const path = `/api/v1/files/${enc(collection)}/${enc(recordId)}/${enc(field)}`;
    // Progress reporting: best-effort via streaming fetch in supported runtimes.
    if (opts.onProgress && typeof XMLHttpRequest !== "undefined") {
      return await this.uploadXhr(path, fd, opts) as FileMeta | FileMeta[];
    }
    return await this.client.request<FileMeta | FileMeta[]>(path, {
      method: "POST",
      body: fd,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /**
   * Build a public URL for a stored filename. For `protected` fields the
   * URL includes a `?token=…` minted on demand.
   */
  url(filename: string, params: FileUrlParams = {}): string {
    const u = new URL(`/api/v1/files/${enc(filename)}`, this.client.baseUrl + "/");
    if (params.thumb) {
      // The server reads the fit mode from the thumb value (`WxH_cover`).
      const fit = params.fit && params.fit !== "contain" && !params.thumb.includes("_") ? `_${params.fit}` : "";
      u.searchParams.set("thumb", `${params.thumb}${fit}`);
    }
    if (params.format) u.searchParams.set("format", params.format);
    if (params.quality !== undefined) u.searchParams.set("quality", String(params.quality));
    return u.toString();
  }

  /**
   * Mint (or return cached) a 1h access token for a protected file. Auto-
   * refreshes ~60s before expiry.
   */
  async token(collection: string, recordId: string, field: string, filename: string): Promise<TokenResponse> {
    const identity = this.identity();
    if (identity !== this.cacheIdentity) {
      this.tokenCache.clear();
      this.cacheIdentity = identity;
    }
    const key = `${collection}:${recordId}:${field}:${filename}`;
    const now = Math.floor(Date.now() / 1000);
    const cached = this.tokenCache.get(key);
    if (cached && cached.expires_at - now > 60) return cached;

    const data = await this.client.request<TokenResponse>(
      `/api/v1/files/${enc(collection)}/${enc(recordId)}/${enc(field)}/${enc(filename)}/token`,
      { method: "POST" },
    );
    if (!isOneTime(data)) this.tokenCache.set(key, data);
    return data;
  }

  /** Drop every cached file token. */
  clearTokenCache(): void { this.tokenCache.clear(); }

  /** Who file tokens are minted for: `aud:collection:id` from the auth JWT, or the cookie-mode record id. */
  private identity(): string | null {
    const stored = this.client.authStore.get();
    if (!stored) return null;
    const claims = stored.token ? decodeJwtPayload(stored.token) : null;
    if (claims) return `${String(claims["aud"] ?? "")}:${String(claims["collection"] ?? "")}:${String(claims["id"] ?? claims["sub"] ?? "")}`;
    if (stored.token) return `token:${stored.token}`;
    const id = stored.record?.["id"];
    return id === undefined ? null : `record:${String(id)}`;
  }

  /** URL with auto-minted token. Fails fast for non-protected files (no token issued). */
  async urlWithToken(
    collection: string,
    recordId: string,
    field: string,
    filename: string,
    params: FileUrlParams = {},
  ): Promise<string> {
    const tok = await this.token(collection, recordId, field, filename);
    const u = new URL(this.url(filename, params));
    u.searchParams.set("token", tok.token);
    return u.toString();
  }

  async delete(
    collection: string,
    recordId: string,
    field: string,
    filename?: string,
  ): Promise<{ deleted?: number } | null> {
    const path = filename
      ? `/api/v1/files/${enc(collection)}/${enc(recordId)}/${enc(field)}/${enc(filename)}`
      : `/api/v1/files/${enc(collection)}/${enc(recordId)}/${enc(field)}`;
    return await this.client.request(path, { method: "DELETE" });
  }

  // ── XHR upload path (progress events) ───────────────────────────────────
  private uploadXhr(path: string, body: FormData, opts: UploadOptions): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", this.client.buildUrl(path));
      xhr.withCredentials = true;
      const stored = this.client.authStore.get();
      if (stored?.token) xhr.setRequestHeader("Authorization", `Bearer ${stored.token}`);
      if (opts.onProgress) {
        xhr.upload.onprogress = (e) => {
          opts.onProgress?.({ loaded: e.loaded, total: e.total || 0 });
        };
      }
      if (opts.signal) {
        const onAbort = () => xhr.abort();
        opts.signal.addEventListener("abort", onAbort);
      }
      xhr.onerror = () => reject(VaultbaseError.network("Upload failed"));
      xhr.onabort = () => reject(VaultbaseError.aborted());
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          let parsed: unknown;
          try { parsed = JSON.parse(xhr.responseText); } catch { parsed = null; }
          const data = (parsed as { data?: unknown } | null)?.data ?? parsed;
          resolve(data);
        } else if (xhr.status === 401 || xhr.status === 403) {
          reject(VaultbaseError.auth(xhr.status === 401 ? "expired" : "forbidden"));
        } else if (xhr.status === 422) {
          let parsed: { details?: Record<string, string>; error?: string } | null = null;
          try { parsed = JSON.parse(xhr.responseText); } catch { /* noop */ }
          reject(VaultbaseError.validation(parsed?.error ?? "Validation failed", parsed?.details ?? {}));
        } else {
          reject(VaultbaseError.server(xhr.status, `HTTP ${xhr.status}`));
        }
      };
      xhr.send(body);
    });
  }
}

/**
 * A one-time token is spent by the first download, so caching it hands the
 * next caller a URL that 410s. Trust `one_time` when the server sends it;
 * otherwise read the `uses: 1` claim the server signs into such tokens.
 */
function isOneTime(t: TokenResponse): boolean {
  if (typeof t.one_time === "boolean") return t.one_time;
  return decodeJwtPayload(t.token)?.["uses"] === 1;
}

function enc(s: string): string { return encodeURIComponent(s); }
