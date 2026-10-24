import type { HttpClient } from "./client.ts";
import { VaultbaseError } from "./errors.ts";
import type { AnyRecord, DefaultSchema, ListOptions, ListResponse } from "./types.ts";

const MAX_OPS = 100;

type Op =
  | { method: "GET";    url: string }
  | { method: "POST";   url: string; body: unknown }
  | { method: "PATCH";  url: string; body: unknown }
  | { method: "DELETE"; url: string };

/** Per-op result envelope. Body is typed by the op kind + Schema generic. */
export interface BatchOpResult<B = unknown> {
  status: number;
  body: B;
}

/** Result of `delete()` ops — server returns 204 with no body. */
export type BatchDeleteResult = BatchOpResult<null>;

/**
 * Typed batch builder. Generic params:
 *   S — Schema map (codegen-emitted)
 *   R — accumulator tuple of per-op result types, grown by each chained call
 *
 * Apps that skip codegen still get a usable `Batch` (R defaults to []).
 */
export class Batch<
  S extends DefaultSchema = DefaultSchema,
  R extends readonly BatchOpResult[] = [],
> {
  private ops: Op[] = [];
  constructor(private readonly client: HttpClient) {}

  create<K extends keyof S & string>(
    collection: K,
    body: S[K]["create"],
  ): Batch<S, [...R, BatchOpResult<S[K]["record"]>]>;
  create(collection: string, body: AnyRecord): Batch<S, [...R, BatchOpResult<AnyRecord>]>;
  create(collection: string, body: AnyRecord): Batch<S, readonly BatchOpResult[]> {
    this.ops.push({ method: "POST", url: `/api/v1/${enc(collection)}`, body });
    return this as unknown as Batch<S, readonly BatchOpResult[]>;
  }

  update<K extends keyof S & string>(
    collection: K,
    id: string,
    body: S[K]["update"],
  ): Batch<S, [...R, BatchOpResult<S[K]["record"]>]>;
  update(collection: string, id: string, body: AnyRecord): Batch<S, [...R, BatchOpResult<AnyRecord>]>;
  update(collection: string, id: string, body: AnyRecord): Batch<S, readonly BatchOpResult[]> {
    this.ops.push({ method: "PATCH", url: `/api/v1/${enc(collection)}/${enc(id)}`, body });
    return this as unknown as Batch<S, readonly BatchOpResult[]>;
  }

  delete(collection: string, id: string): Batch<S, [...R, BatchDeleteResult]> {
    this.ops.push({ method: "DELETE", url: `/api/v1/${enc(collection)}/${enc(id)}` });
    return this as unknown as Batch<S, [...R, BatchDeleteResult]>;
  }

  get<K extends keyof S & string>(
    collection: K,
    id: string,
  ): Batch<S, [...R, BatchOpResult<S[K]["record"]>]>;
  get(collection: string, id: string): Batch<S, [...R, BatchOpResult<AnyRecord>]>;
  get(collection: string, id: string): Batch<S, readonly BatchOpResult[]> {
    this.ops.push({ method: "GET", url: `/api/v1/${enc(collection)}/${enc(id)}` });
    return this as unknown as Batch<S, readonly BatchOpResult[]>;
  }

  list<K extends keyof S & string>(
    collection: K,
    query?: ListOptions,
  ): Batch<S, [...R, BatchOpResult<ListResponse<S[K]["record"]>>]>;
  list(
    collection: string,
    query?: ListOptions,
  ): Batch<S, [...R, BatchOpResult<ListResponse<AnyRecord>>]>;
  list(collection: string, query: ListOptions = {}): Batch<S, readonly BatchOpResult[]> {
    // The same parameters as Collection.list: copying every key sent
    // skipTotal as "true" (the server wants "1") and put requestKey and
    // signal in the URL.
    const params = new URLSearchParams();
    const values: Record<string, string | number | undefined> = {
      page: query.page,
      perPage: query.perPage,
      filter: query.filter,
      sort: query.sort,
      expand: query.expand,
      fields: query.fields,
      skipTotal: query.skipTotal ? "1" : undefined,
      search: query.search,
    };
    for (const [k, v] of Object.entries(values)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    this.ops.push({ method: "GET", url: `/api/v1/${enc(collection)}${qs ? `?${qs}` : ""}` });
    return this as unknown as Batch<S, readonly BatchOpResult[]>;
  }

  size(): number { return this.ops.length; }

  async run(): Promise<R> {
    if (this.ops.length === 0) return [] as unknown as R;
    if (this.ops.length > MAX_OPS) {
      throw VaultbaseError.validation(`Batch exceeds ${MAX_OPS} ops`, { batch: `Got ${this.ops.length} ops` });
    }
    const res = await this.client.request<R>("/api/v1/batch", {
      method: "POST",
      body: { requests: this.ops },
    });
    return res;
  }
}

/** Legacy, type-erased result shape — kept for backwards compatibility. */
export type BatchResult = Array<{ status: number; body: unknown }>;

function enc(s: string): string { return encodeURIComponent(s); }
