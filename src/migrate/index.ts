/**
 * Programmatic migration helpers — used by the `vb-migrate` CLI and by
 * deploy scripts that want to wire schema apply into CI without the
 * interactive UI.
 *
 * All functions hit the existing server endpoints under
 * `/api/v1/admin/migrations/*` (snapshot / diff / apply).
 */

export type ApplyMode = "additive" | "sync";

export interface SnapshotEnvelope {
  generated_at: string;
  version: number;
  collections: unknown[];
}

export interface DiffEntry {
  /** "create" — new in source, missing on target.
   *  "update" — present in both but differs (rules / fields / view query).
   *  "unchanged" — already in sync.
   *  "remove" — on the target only; no apply mode deletes it. */
  kind: "create" | "update" | "unchanged" | "remove";
  collection: string;
  /** Human-readable list of differences for `update` kind. Empty otherwise. */
  changes?: string[];
}

export interface ApplyResult {
  created: string[];
  updated: string[];
  skipped: string[];
  errors: { collection: string; message: string }[];
}

export interface RemoteOpts {
  /** Base URL of the target server (no trailing slash). */
  url: string;
  /** Admin JWT — must have `aud:"admin"`. */
  adminToken: string;
  /** Optional fetch override (tests / proxies). Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

async function authedFetch(opts: RemoteOpts, path: string, init: RequestInit = {}): Promise<Response> {
  const f = opts.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.adminToken}`,
    ...((init.headers ?? {}) as Record<string, string>),
  };
  return await f(joinUrl(opts.url, path), { ...init, headers });
}

/** Fetch a snapshot from a target server. */
export async function pullSnapshot(opts: RemoteOpts): Promise<SnapshotEnvelope> {
  const res = await authedFetch(opts, "/api/v1/admin/migrations/snapshot");
  if (!res.ok) throw new Error(`pull failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return unwrap(data) as SnapshotEnvelope;
}

/** Compute the diff between `snapshot` and the target server's current schema. */
export async function diffSnapshot(snapshot: SnapshotEnvelope, opts: RemoteOpts): Promise<DiffEntry[]> {
  const res = await authedFetch(opts, "/api/v1/admin/migrations/diff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snapshot }),
  });
  if (!res.ok) throw new Error(`diff failed: ${res.status} ${res.statusText}`);
  return toDiffEntries(unwrap(await res.json()));
}

interface ServerDiff {
  added?: Array<{ name: string }>;
  modified?: Array<{ name: string; changes?: string[] }>;
  unchanged?: Array<{ name: string }>;
  removed?: Array<{ name: string }>;
}

/** The server answers `{ added, modified, unchanged, removed }`; flatten it. */
export function toDiffEntries(v: unknown): DiffEntry[] {
  if (Array.isArray(v)) return v as DiffEntry[];
  const d = (v ?? {}) as ServerDiff;
  return [
    ...(d.added ?? []).map((c): DiffEntry => ({ kind: "create", collection: c.name })),
    ...(d.modified ?? []).map((c): DiffEntry => ({ kind: "update", collection: c.name, changes: c.changes ?? [] })),
    ...(d.unchanged ?? []).map((c): DiffEntry => ({ kind: "unchanged", collection: c.name })),
    ...(d.removed ?? []).map((c): DiffEntry => ({ kind: "remove", collection: c.name })),
  ];
}

/** Apply `snapshot` to the target server. `mode` is `"additive"` (safe; create-only) or `"sync"`. */
export async function applySnapshot(
  snapshot: SnapshotEnvelope,
  opts: RemoteOpts & { mode?: ApplyMode },
): Promise<ApplyResult> {
  const res = await authedFetch(opts, "/api/v1/admin/migrations/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snapshot, mode: opts.mode ?? "additive" }),
  });
  if (!res.ok) throw new Error(`apply failed: ${res.status} ${res.statusText}`);
  const r = (unwrap(await res.json()) ?? {}) as Partial<Omit<ApplyResult, "errors">> & { errors?: Array<{ collection: string; message?: string; error?: string }> };
  return {
    created: r.created ?? [],
    updated: r.updated ?? [],
    skipped: r.skipped ?? [],
    // The server names the message `error`.
    errors: (r.errors ?? []).map((e) => ({ collection: e.collection, message: e.message ?? e.error ?? "" })),
  };
}

/**
 * The server's standard envelope: `{data: T}`. Some endpoints return the
 * raw shape (snapshot download), so accept both.
 */
function unwrap(v: unknown): unknown {
  if (v && typeof v === "object" && "data" in (v as object)) {
    return (v as { data: unknown }).data;
  }
  return v;
}
