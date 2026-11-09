/**
 * Discriminated error union. Every SDK call rejects with a `VaultbaseError`
 * carrying a `kind` so apps can `switch` instead of string-matching.
 */

export type ErrorKind =
  | "network"
  | "auth"
  | "validation"
  | "rate_limit"
  | "conflict"
  | "not_found"
  | "precondition_failed"
  | "server"
  | "maintenance"
  | "aborted";

export interface NetworkErrorData    { kind: "network"; message: string; cause?: unknown }
/** The operation a 403 refused, as the server names it (server 0.42+). */
export type AuthOperation = "create" | "update" | "delete" | "view" | "list";
/**
 * `expired`: the session ended (the token expired or the server refused it);
 * it has been cleared, so show sign-in.
 * `not_signed_in`: the request had no session and the rule needs one; show sign-in.
 * `invalid`: wrong credentials, or a 401 on a request sent without the session.
 * `forbidden`: signed in (or not required to be), but a rule or an admin-only
 * endpoint refused it.
 */
export type AuthReason = "expired" | "invalid" | "forbidden" | "not_signed_in";
export interface AuthErrorData {
  kind: "auth";
  message: string;
  reason: AuthReason;
  /** The refused operation, from a 403 body (server 0.42+). */
  operation?: AuthOperation;
  /** The server's own reason, from a 403 body: `not_signed_in`, `rule_denied`, `admin_only` or `token_invalid` (server 0.42+). */
  serverReason?: string;
}
/** 422, or a 400 (a bad filter, sort or request body). `details` maps fields to messages when the server sends them. */
export interface ValidationErrorData { kind: "validation"; message: string; details: Record<string, string> }
/** 404: the record, collection or route doesn't exist (or the caller may not see it). */
export interface NotFoundErrorData   { kind: "not_found"; message: string; body?: unknown }
export interface RateLimitErrorData  { kind: "rate_limit"; message: string; retryAfterMs: number }
export interface ConflictErrorData   { kind: "conflict"; message: string; serverCode: 409 | 422 }
export interface ServerErrorData     { kind: "server"; message: string; status: number; body?: unknown }
export interface AbortedErrorData    { kind: "aborted"; message: string }
/**
 * 503 from a server in maintenance mode. `level` is `read_only` when reads
 * still work; `until` (Unix seconds) and `retryAfterMs` are set when the
 * admin said when it should be back.
 */
export interface MaintenanceErrorData {
  kind: "maintenance";
  message: string;
  level: "full" | "read_only";
  until?: number;
  retryAfterMs?: number;
}
/** 412 Precondition Failed — `If-Match` ETag did not match the server's record. */
export interface PreconditionFailedErrorData {
  kind: "precondition_failed";
  message: string;
  /** The server's current ETag (when echoed). */
  currentEtag?: string;
}

export type VaultbaseErrorData =
  | NetworkErrorData
  | AuthErrorData
  | ValidationErrorData
  | RateLimitErrorData
  | ConflictErrorData
  | NotFoundErrorData
  | PreconditionFailedErrorData
  | ServerErrorData
  | MaintenanceErrorData
  | AbortedErrorData;

export class VaultbaseError extends Error {
  readonly kind: ErrorKind;
  readonly data: VaultbaseErrorData;
  /** The HTTP status, when the error came from a response. */
  status?: number;

  constructor(data: VaultbaseErrorData) {
    super(data.message);
    this.name = "VaultbaseError";
    this.kind = data.kind;
    this.data = data;
    Object.setPrototypeOf(this, VaultbaseError.prototype);
  }

  static network(message: string, cause?: unknown): VaultbaseError {
    return new VaultbaseError({ kind: "network", message, ...(cause !== undefined ? { cause } : {}) });
  }
  /** `auth` errors: the refused operation (server 0.42+). */
  get operation(): AuthOperation | undefined { return this.data.kind === "auth" ? this.data.operation : undefined; }
  /** `auth` errors: the server's reason from a 403 body (server 0.42+). */
  get serverReason(): string | undefined { return this.data.kind === "auth" ? this.data.serverReason : undefined; }

  static auth(reason: AuthReason, message?: string, extra: { operation?: AuthOperation; serverReason?: string } = {}): VaultbaseError {
    return new VaultbaseError({
      kind: "auth", reason, message: message ?? `Authentication failed: ${reason}`,
      ...(extra.operation !== undefined ? { operation: extra.operation } : {}),
      ...(extra.serverReason !== undefined ? { serverReason: extra.serverReason } : {}),
    });
  }
  static validation(message: string, details: Record<string, string> = {}): VaultbaseError {
    return new VaultbaseError({ kind: "validation", message, details });
  }
  static rateLimit(retryAfterMs: number, message = "Rate limited"): VaultbaseError {
    return new VaultbaseError({ kind: "rate_limit", message, retryAfterMs });
  }
  static conflict(serverCode: 409 | 422, message: string): VaultbaseError {
    return new VaultbaseError({ kind: "conflict", message, serverCode });
  }
  static notFound(message = "Not found", body?: unknown): VaultbaseError {
    return new VaultbaseError({ kind: "not_found", message, ...(body !== undefined ? { body } : {}) });
  }
  static server(status: number, message: string, body?: unknown): VaultbaseError {
    return new VaultbaseError({ kind: "server", message, status, ...(body !== undefined ? { body } : {}) });
  }
  static maintenance(message: string, level: MaintenanceErrorData["level"], until?: number, retryAfterMs?: number): VaultbaseError {
    const data: MaintenanceErrorData = { kind: "maintenance", message, level };
    if (until !== undefined) data.until = until;
    if (retryAfterMs !== undefined) data.retryAfterMs = retryAfterMs;
    return new VaultbaseError(data);
  }
  static aborted(message = "Request aborted"): VaultbaseError {
    return new VaultbaseError({ kind: "aborted", message });
  }
  static preconditionFailed(message = "Precondition Failed", currentEtag?: string): VaultbaseError {
    const data: PreconditionFailedErrorData = { kind: "precondition_failed", message };
    if (currentEtag !== undefined) data.currentEtag = currentEtag;
    return new VaultbaseError(data);
  }
}

/** Convenience type-guard. */
export function isVaultbaseError(e: unknown): e is VaultbaseError {
  return e instanceof VaultbaseError;
}
