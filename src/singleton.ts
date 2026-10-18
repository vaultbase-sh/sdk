import type { HttpClient } from "./client.ts";
import type { UpdateOptions } from "./collection.ts";
import type { AnyRecord, CollectionTypes, MutationOptions } from "./types.ts";

export interface SingletonGetOptions extends MutationOptions {
  /** Relations to expand, comma-separated (same syntax as `list`). */
  expand?: string;
  /** Fields to return, comma-separated (same syntax as `list`). */
  fields?: string;
}

/**
 * Key the singleton's ETag is cached under in `client.etags`, next to the
 * per-record entries (`<collection>:<id>`). Not a valid record id, so it
 * can't collide with one.
 */
export const SINGLETON_ETAG_KEY = "@singleton";

/**
 * Accessor for a singleton collection: one record, read and written at the
 * collection's own path (`GET` / `PATCH /api/v1/<name>`). Generic params:
 *   R — the record type (from `Schema[K]['record']`)
 *   U — the update-input type (from `Schema[K]['update']`)
 */
export class Singleton<R = AnyRecord, U = AnyRecord> {
  constructor(private readonly client: HttpClient, private readonly name: string) {}

  /** Read the record. Caches its ETag for the next `update`. */
  async get(opts: SingletonGetOptions = {}): Promise<R> {
    const { expand, fields, ...rest } = opts;
    const query: Record<string, string | undefined> = { expand, fields };
    return await this.client.request<R>(this.path(), {
      query,
      ...rest,
      onResponse: (res) => this.captureEtag(res),
    });
  }

  /**
   * Update the record. `ifMatch` works as on `Collection.update`: by default
   * (`"auto"`) the ETag from this singleton's last `get` / `update` is sent as
   * `If-Match`; a string sends that ETag; `false` sends none. A mismatch
   * throws `VaultbaseError(kind: "precondition_failed")`.
   */
  async update(body: U, opts: UpdateOptions = {}): Promise<R> {
    const { ifMatch, ...rest } = opts;
    let headers: Record<string, string> | undefined;
    if (typeof ifMatch === "string" && ifMatch.length > 0 && ifMatch !== "auto") {
      headers = { "If-Match": ifMatch };
    } else if (ifMatch !== false) {
      const cached = this.client.etags.get(this.name, SINGLETON_ETAG_KEY);
      if (cached) headers = { "If-Match": cached };
    }
    return await this.client.request<R>(this.path(), {
      method: "PATCH",
      body,
      ...rest,
      ...(headers ? { headers } : {}),
      onResponse: (res) => this.captureEtag(res),
    });
  }

  private captureEtag(res: Response): void {
    const etag = res.headers.get("etag");
    if (etag) this.client.etags.set(this.name, SINGLETON_ETAG_KEY, etag);
  }

  private path(): string { return `/api/v1/${encodeURIComponent(this.name)}`; }
}

/** Helper type bridging Schema to Singleton generics. */
export type SingletonFor<T extends CollectionTypes> = Singleton<T["record"], T["update"]>;
