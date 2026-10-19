/**
 * Tagged-template filter builder. Produces a `Filter`-branded string with
 * interpolated values escaped + quoted per the server's filter expression
 * grammar (see `vaultbase/src/core/expression.ts`).
 *
 *   const f = q`title ~ ${term} && status = ${"published"}`;
 *   posts.list({ filter: f });
 *
 * Why a tag and not plain string concat? Type safety + automatic escaping.
 * Direct `\`title ~ "${term}"\`` lets quotes / backslashes in `term` break
 * the parser or escape the literal context. The tag walks the parts and
 * encodes each interpolation by JavaScript type:
 *
 *   string   → quoted with `"…"`, embedded `\` and `"` escaped
 *   number   → bare numeric literal (rejects NaN / ±Infinity)
 *   boolean  → `true` / `false`
 *   null     → `null`
 *   Date     → quoted ISO string
 *   array    → `(v1, v2, …)` for use with `?=` / `?~` array-prefix ops
 *   {field}  → bare identifier (validated against the same regex the server uses)
 *
 * Anything else throws — better a hard error than a silent injection.
 */

declare const FilterBrand: unique symbol;
/**
 * Branded filter string. Construct via {@link q} or {@link rawFilter}; the
 * brand stops callers from passing arbitrary strings into APIs that expect
 * "this came through the safe builder".
 */
export type Filter = string & { readonly [FilterBrand]: true };

/** Wrap an identifier so it interpolates as a bare field reference. */
export interface FieldRef { readonly __field: string }
/**
 * Use inside `q` to interpolate a column / dotted-path identifier without quotes.
 *
 *   q`${field("status")} = ${"published"}`
 *   q`${field("meta.color")} = ${"red"}`   // a path inside a json field
 */
export function field(name: string): FieldRef {
  if (!IDENT_PATH_RE.test(name)) throw new Error(`field(): invalid identifier "${name}"`);
  return { __field: name };
}

const IDENT_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function escapeString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function encodeValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) throw new Error("vb.q: undefined value not allowed (use null)");
  if (typeof v === "string") return escapeString(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`vb.q: non-finite number not allowed (${v})`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return escapeString(v.toISOString());
  if (Array.isArray(v)) return `(${v.map(encodeValue).join(", ")})`;
  if (typeof v === "object" && v !== null && "__field" in v && typeof (v as FieldRef).__field === "string") {
    return (v as FieldRef).__field;
  }
  throw new Error(`vb.q: unsupported interpolation type: ${typeof v}`);
}

/**
 * Tagged-template filter builder. Returns a `Filter`-branded string the
 * SDK accepts wherever a filter is expected.
 */
export function q(parts: TemplateStringsArray, ...values: unknown[]): Filter {
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i < values.length) out += encodeValue(values[i]);
  }
  return out as Filter;
}

/**
 * Escape hatch: cast a hand-rolled string to `Filter`. Use only when you
 * know the string came from a trusted source. Prefer {@link q}.
 */
export function rawFilter(s: string): Filter {
  return s as Filter;
}
