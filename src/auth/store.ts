/**
 * Pluggable token persistence.
 *
 * Default preference on the browser:
 *   1. CookieAuthStore   — when host writes HttpOnly cookies (SSR / API)
 *   2. SessionStorageAuthStore — same-tab, dies on tab close (XSS-safer)
 *   3. MemoryAuthStore   — Node, SSR, Bun, Deno
 *
 * `LocalStorageAuthStore` is available but not the default. Use only when
 * cross-tab persistence outweighs the lifelong-XSS-readable risk.
 */

export interface StoredAuth {
  token: string;
  /** The signed-in user or admin record, from the sign-in response. */
  record?: Record<string, unknown>;
}

export interface AuthStore {
  get(): StoredAuth | null;
  set(value: StoredAuth | null): void;
  /** Optional cross-tab change broadcast. */
  onChange?(listener: () => void): () => void;
}

export class MemoryAuthStore implements AuthStore {
  private value: StoredAuth | null = null;
  private listeners = new Set<() => void>();
  get(): StoredAuth | null { return this.value; }
  set(value: StoredAuth | null): void {
    this.value = value;
    for (const fn of this.listeners) fn();
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

interface BrowserStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

abstract class WebStorageAuthStore implements AuthStore {
  protected abstract storage(): BrowserStorageLike | null;
  /** Same-tab listeners: the browser's `storage` event never fires in the tab that wrote. */
  private readonly listeners = new Set<() => void>();
  constructor(protected readonly key = "vaultbase_auth") {}

  get(): StoredAuth | null {
    const s = this.storage();
    if (!s) return null;
    const raw = s.getItem(this.key);
    if (!raw) return null;
    try { return JSON.parse(raw) as StoredAuth; } catch { return null; }
  }

  set(value: StoredAuth | null): void {
    const s = this.storage();
    if (!s) return;
    if (value === null) s.removeItem(this.key);
    else s.setItem(this.key, JSON.stringify(value));
    for (const fn of this.listeners) fn();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export class SessionStorageAuthStore extends WebStorageAuthStore {
  protected storage(): BrowserStorageLike | null {
    return typeof globalThis !== "undefined" && "sessionStorage" in globalThis
      ? (globalThis as unknown as { sessionStorage: BrowserStorageLike }).sessionStorage
      : null;
  }
}

/**
 * Cross-tab persistent. Token stays in localStorage forever — readable to
 * any future XSS. Prefer `SessionStorageAuthStore`.
 */
export class LocalStorageAuthStore extends WebStorageAuthStore {
  protected storage(): BrowserStorageLike | null {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? (globalThis as unknown as { localStorage: BrowserStorageLike }).localStorage
      : null;
  }

  /** Fires for changes in this tab and, via the `storage` event, in other tabs. */
  override onChange(listener: () => void): () => void {
    const offLocal = super.onChange(listener);
    if (typeof globalThis === "undefined" || !("addEventListener" in globalThis)) return offLocal;
    const target = globalThis as unknown as {
      addEventListener: (t: string, h: (e: { key?: string }) => void) => void;
      removeEventListener: (t: string, h: (e: { key?: string }) => void) => void;
    };
    const handler = (e: { key?: string }) => { if (e.key === this.key) listener(); };
    target.addEventListener("storage", handler);
    return () => { offLocal(); target.removeEventListener("storage", handler); };
  }
}

/**
 * Cookie-based store. The host (Next.js / Astro / SvelteKit middleware)
 * writes HttpOnly cookies; this store has no client-side token to read,
 * so `get()` returns `null` for the token but `record` may be hydrated by
 * the host via `set()` (without a token).
 */
export class CookieAuthStore implements AuthStore {
  private record: Record<string, unknown> | null = null;
  private listeners = new Set<() => void>();
  get(): StoredAuth | null {
    if (this.record === null) return null;
    return { token: "", record: this.record };
  }
  set(value: StoredAuth | null): void {
    this.record = value?.record ?? null;
    for (const fn of this.listeners) fn();
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** Pick a sensible default for the current environment. */
export function defaultAuthStore(): AuthStore {
  if (typeof globalThis !== "undefined" && "sessionStorage" in globalThis) {
    return new SessionStorageAuthStore();
  }
  return new MemoryAuthStore();
}
