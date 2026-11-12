import type { HttpClient } from "./client.ts";
import type {
  AnyRecord,
  CollectionTypes,
  ListOptions,
  AggregateOptions,
  AggregateRow,
  ListResponse,
  MutationOptions,
  ViewParams,
} from "./types.ts";

export interface ConcurrencyOptions {
  /**
   * Optimistic-concurrency control. Defaults to `"auto"`:
   *   - `"auto"`: attach `If-Match` from the SDK's per-record ETag cache when present.
   *   - `string`: an explicit ETag (e.g. from a prior response) to send as `If-Match`.
   *   - `false`: skip the precondition entirely.
   */
  ifMatch?: string | "auto" | false;
}

export interface GetOptions<P extends ViewParams = ViewParams> extends MutationOptions {
  /** A view's parameters (`:name` in its query). Needs server 0.35.0+. */
  params?: P;
  /** Relations to expand, comma-separated (same syntax as `list`). Needs server 0.26.1+. */
  expand?: string;
  /** Fields to return, comma-separated (same syntax as `list`). Needs server 0.26.1+. */
  fields?: string;
  /** Fields to leave out, comma-separated; applied after `fields`. Needs server 0.31.0+. */
  exclude?: string;
}

/** Options for `create`. */
export interface CreateOptions extends MutationOptions {
  /**
   * Makes the create safe to repeat (server 0.46+): sent as
   * `X-VB-Idempotency-Key`. The same key again, from the same caller on the
   * same collection, returns the record the first call made instead of
   * making another. Use a fresh random value per record, such as
   * `crypto.randomUUID()`, and keep it with the pending create until it
   * succeeds. An older server ignores it.
   */
  idempotencyKey?: string;
}
export type UpdateOptions = MutationOptions & ConcurrencyOptions;
export type DeleteOptions = MutationOptions & ConcurrencyOptions;

/**
 * Typed CRUD interface for a single collection. Generic params:
 *   R — the record type (from `Schema[K]['record']`)
 *   C — the create-input type (from `Schema[K]['create']`)
 *   U — the update-input type (from `Schema[K]['update']`)
 */
export class Collection<
  R = AnyRecord,
  C = AnyRecord,
  U = AnyRecord,
  P extends ViewParams = ViewParams,
> {
  constructor(private readonly client: HttpClient, private readonly name: string) {}

  /** Paginated list. Filters / sort / expand pass through to the server expression engine. */
  async list(options: ListOptions<P> = {}): Promise<ListResponse<R>> {
    const query: Record<string, string | number | boolean | undefined> = {
      ...paramsQuery(options.params),
      page: options.page,
      perPage: options.perPage,
      filter: options.filter,
      sort: options.sort,
      expand: options.expand,
      fields: options.fields,
      exclude: options.exclude,
      skipTotal: options.skipTotal ? "1" : undefined,
      search: options.search,
    };
    return await this.client.request<ListResponse<R>>(`/api/v1/${this.encName()}`, {
      query,
      ...(options.requestKey !== undefined ? { requestKey: options.requestKey } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /** Count / sum / avg / min / max over the records a list would return, optionally grouped. */
  async aggregate(options: AggregateOptions<P> = {}): Promise<AggregateRow[]> {
    const join = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(",") : v);
    const query: Record<string, string | number | boolean | undefined> = {
      ...paramsQuery(options.params),
      agg: join(options.agg),
      groupBy: join(options.groupBy),
      filter: options.filter,
      search: options.search,
      sort: options.sort,
      limit: options.limit,
    };
    return await this.client.request<AggregateRow[]>(`/api/v1/${this.encName()}/_aggregate`, {
      query,
      ...(options.requestKey !== undefined ? { requestKey: options.requestKey } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /** Iterate every record matching the filter. Internal pagination. */
  async *iterate(options: Omit<ListOptions<P>, "page"> = {}): AsyncGenerator<R, void, void> {
    const perPage = options.perPage ?? 100;
    let page = 1;
    while (true) {
      const res = await this.list({ ...options, page, perPage });
      for (const r of res.data) yield r;
      // The server clamps perPage (500 max) and echoes the size it used, so a
      // short page is measured against that, not the requested size.
      const size = typeof res.perPage === "number" && res.perPage > 0 ? res.perPage : perPage;
      if (res.data.length === 0 || res.data.length < size) return;
      // totalPages is -1 under skipTotal: unknown, keep paging.
      if (res.totalPages >= 0 && page >= res.totalPages) return;
      page++;
    }
  }

  async get(id: string, opts: GetOptions<P> = {}): Promise<R> {
    const { expand, fields, exclude, params, ...rest } = opts;
    const query: Record<string, string | undefined> = { ...paramsQuery(params), expand, fields, exclude };
    return await this.client.request<R>(`/api/v1/${this.encName()}/${enc(id)}`, { query, ...rest });
  }

  async create(body: C, opts: CreateOptions = {}): Promise<R> {
    const { idempotencyKey, ...rest } = opts;
    return await this.client.request<R>(`/api/v1/${this.encName()}`, {
      method: "POST",
      body,
      ...rest,
      ...(idempotencyKey ? { headers: { "X-VB-Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  async update(id: string, body: U, opts: UpdateOptions = {}): Promise<R> {
    const { ifMatch, ...rest } = opts;
    const headers = this.buildIfMatchHeaders(id, ifMatch);
    return await this.client.request<R>(`/api/v1/${this.encName()}/${enc(id)}`, {
      method: "PATCH",
      body,
      ...rest,
      ...(headers ? { headers } : {}),
    });
  }

  async delete(id: string, opts: DeleteOptions = {}): Promise<null> {
    const { ifMatch, ...rest } = opts;
    const headers = this.buildIfMatchHeaders(id, ifMatch);
    const r = await this.client.request<null>(`/api/v1/${this.encName()}/${enc(id)}`, {
      method: "DELETE",
      ...rest,
      ...(headers ? { headers } : {}),
    });
    // Successful delete invalidates the ETag entry so a subsequent recreate
    // doesn't carry the stale tag forward.
    this.client.etags.delete(this.name, id);
    return r;
  }

  /**
   * Resolve `ifMatch` into the HTTP headers to send. `"auto"` (default) reads
   * from the client's ETag cache; an explicit string overrides the cache;
   * `false` disables the precondition entirely.
   */
  private buildIfMatchHeaders(id: string, ifMatch: ConcurrencyOptions["ifMatch"]): Record<string, string> | null {
    if (ifMatch === false) return null;
    if (typeof ifMatch === "string" && ifMatch.length > 0 && ifMatch !== "auto") return { "If-Match": ifMatch };
    const cached = this.client.etags.get(this.name, id);
    if (!cached) return null;
    return { "If-Match": cached };
  }

  private encName(): string { return enc(this.name); }
}

/** Helper type bridging Schema to Collection generics. */
export type CollectionFor<T extends CollectionTypes> = Collection<
  T["record"], T["create"], T["update"],
  T extends { params: infer P extends ViewParams } ? P : ViewParams
>;

function enc(s: string): string { return encodeURIComponent(s); }

/** `params[name]` query keys for a view's parameters; a Date as ISO 8601. */
function paramsQuery(params: ViewParams | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null) continue;
    out[`params[${k}]`] = v instanceof Date ? v.toISOString() : String(v);
  }
  return out;
}
