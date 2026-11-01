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
  | "precondition_failed"
  | "server"
  | "maintenance"
  | "aborted";

export interface NetworkErrorData    { kind: "network"; message: string; cause?: unknown }
export interface AuthErrorData       { kind: "auth"; message: string; reason: "expired" | "invalid" | "forbidden" }
export interface ValidationErrorData { kind: "validation"; message: string; details: Record<string, string> }
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
  | PreconditionFailedErrorData
  | ServerErrorData
  | MaintenanceErrorData
  | AbortedErrorData;

export class VaultbaseError extends Error {
  readonly kind: ErrorKind;
  readonly data: VaultbaseErrorData;

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
  static auth(reason: AuthErrorData["reason"], message?: string): VaultbaseError {
    return new VaultbaseError({ kind: "auth", reason, message: message ?? `Authentication failed: ${reason}` });
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
