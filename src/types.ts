/**
 * Shared schema types. The codegen CLI emits a `Schema` type matching this
 * shape; users pass it as a generic to `new Vaultbase<Schema>()` for
 * IntelliSense throughout the SDK.
 */

export type AnyRecord = Record<string, unknown>;

/** A single collection's read / create / update shapes. */
export interface CollectionTypes<R = AnyRecord, C = AnyRecord, U = AnyRecord> {
  record: R;
  create: C;
  update: U;
}

/**
 * Top-level schema map. Defaults to a permissive shape so apps that skip
 * codegen still compile; codegen-emitted versions narrow this. Uses
 * bivariant `any` on the per-collection types so user-emitted record
 * interfaces (which don't carry an index signature) still satisfy this
 * constraint.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DefaultSchema = Record<string, CollectionTypes<any, any, any>>;

/** Server's standard list-response envelope. */
export interface ListResponse<T> {
  data: T[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
}

export interface ListOptions {
  page?: number;
  perPage?: number;
  filter?: string;
  sort?: string;
  expand?: string;
  fields?: string;
  skipTotal?: boolean;
  /**
   * Full-text search over the collection's searchable fields (server
   * 0.15+). Terms are ANDed and the last one matches as a prefix. Results
   * are ordered by relevance unless `sort` is set.
   */
  search?: string;
  /** Opt-in cancel key. */
  requestKey?: string | null;
  signal?: AbortSignal;
}

export interface MutationOptions {
  requestKey?: string | null;
  signal?: AbortSignal;
}

export interface FileMeta {
  id: string;
  filename: string;
  originalName: string;
  size: number;
  mimeType: string;
}

export interface UploadOptions {
  onProgress?: (e: { loaded: number; total: number }) => void;
  signal?: AbortSignal;
}

/** Realtime event payload as fanned out by the server. */
export interface RealtimeEvent<R = AnyRecord> {
  type: "create" | "update" | "delete";
  collection: string;
  record?: R;
  id?: string;
}

export type SubscribeFilter = "*" | string | string[];
export type SubscribeCallback<R = AnyRecord> = (event: RealtimeEvent<R>) => void;
