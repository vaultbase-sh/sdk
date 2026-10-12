/**
 * Feature flags client. Owns:
 *   - bulk eval cache populated from POST /api/v1/flags/evaluate
 *   - sync accessors (isEnabled / getString / getNumber / getJson)
 *   - optional WS subscription on the `__flags` topic that triggers a
 *     refetch when the server pushes a change/delete delta
 *   - change listeners so reactive UI layers (React hook below) can
 *     re-render on flag updates
 *
 * Trust model: the SDK sends the operator-supplied `context` at eval time;
 * vaultbase doesn't infer it. For server-side hooks/routes, prefer the
 * server-side `ctx.helpers.flags` API which uses the verified caller as
 * context.
 */
import type { HttpClient } from "../client.ts";

export type FlagValue = boolean | string | number | Record<string, unknown> | unknown[] | null;

export interface FlagsConnectOptions {
  /** Evaluation context (e.g. `{ user: { id, plan, country } }`). */
  context?: Record<string, unknown>;
  /** Refetch interval as a fallback when WS isn't available. Default 60 s. */
  pollIntervalMs?: number;
  /** Skip WS, poll only. */
  pollOnly?: boolean;
}

export type FlagsChangeListener = (changedKeys: string[]) => void;

export class FlagsClient {
  private cache = new Map<string, FlagValue>();
  private context: Record<string, unknown> = {};
  private listeners = new Set<FlagsChangeListener>();
  private ws: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private closed = false;
  private reconnectAttempt = 0;

  constructor(private readonly client: HttpClient) {}

  /** Open the connection and seed the cache. Idempotent — safe to call again. */
  async connect(opts: FlagsConnectOptions = {}): Promise<void> {
    this.closed = false;
    if (opts.context) this.context = opts.context;
    await this.refresh();
    if (!opts.pollOnly) this.openWs();
    const interval = Math.max(10_000, opts.pollIntervalMs ?? 60_000);
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => { void this.refresh(); }, interval);
    }
    this.connected = true;
  }

  /** Update the targeting context and refetch immediately. */
  async setContext(context: Record<string, unknown>): Promise<void> {
    this.context = context;
    await this.refresh();
  }

  /** Force a refetch of the bulk evaluation. */
  async refresh(): Promise<void> {
    try {
      // The server answers `{ data: { key: value } }`; HttpClient.request
      // unwraps that envelope, so `res` is the flag map itself.
      const res = await this.client.request<Record<string, FlagValue> | null>(
        "/api/v1/flags/evaluate",
        { method: "POST", body: { context: this.context }, skipAuth: true },
      );
      const next = res && typeof res === "object" ? res : {};
      const changed = diffKeys(this.cache, next);
      this.cache.clear();
      for (const [k, v] of Object.entries(next)) this.cache.set(k, v);
      if (changed.length > 0) this.emit(changed);
    } catch { /* offline / boot — keep last-known cache */ }
  }

  // ── Sync accessors ──────────────────────────────────────────────────────

  isEnabled(key: string, fallback = false): boolean {
    const v = this.cache.get(key);
    return typeof v === "boolean" ? v : fallback;
  }
  getString(key: string, fallback: string): string {
    const v = this.cache.get(key);
    return typeof v === "string" ? v : fallback;
  }
  getNumber(key: string, fallback: number): number {
    const v = this.cache.get(key);
    return typeof v === "number" ? v : fallback;
  }
  getJson<T = unknown>(key: string, fallback: T): T {
    const v = this.cache.get(key);
    return v === undefined || v === null ? fallback : (v as T);
  }
  /** Snapshot of all cached values. */
  all(): Record<string, FlagValue> {
    const out: Record<string, FlagValue> = {};
    for (const [k, v] of this.cache) out[k] = v;
    return out;
  }
  isConnected(): boolean { return this.connected && !this.closed; }

  // ── Listeners ───────────────────────────────────────────────────────────

  on(_event: "change", cb: FlagsChangeListener): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private emit(changedKeys: string[]): void {
    for (const cb of this.listeners) {
      try { cb(changedKeys); } catch { /* listener error ignored */ }
    }
  }

  // ── WS push ─────────────────────────────────────────────────────────────

  private openWs(): void {
    if (typeof globalThis.WebSocket === "undefined") return;
    const url = this.client.baseUrl.replace(/^http/, "ws") + "/realtime";
    let ws: WebSocket;
    try { ws = new globalThis.WebSocket(url); } catch { return; }
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      ws.send(JSON.stringify({ type: "subscribe", topics: ["__flags"] }));
    });
    ws.addEventListener("message", (e) => {
      // Any push on this topic = refetch. We don't trust the message content
      // (it could lie about which flags changed); we re-evaluate to keep the
      // server as the source of truth.
      try {
        const data = JSON.parse(typeof e.data === "string" ? e.data : "");
        if (data?.type === "flag_changed" || data?.type === "flag_deleted") {
          void this.refresh();
        }
      } catch { /* drop */ }
    });
    ws.addEventListener("close", () => {
      this.ws = null;
      if (this.closed) return;
      const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt) * (0.8 + Math.random() * 0.4);
      this.reconnectAttempt++;
      setTimeout(() => { if (!this.closed) this.openWs(); }, delay);
    });
    ws.addEventListener("error", () => {
      try { ws.close(); } catch { /* noop */ }
    });
  }

  /** Drop the WS + stop polling. Safe to call repeatedly. */
  disconnect(): void {
    this.closed = true;
    this.connected = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* noop */ } this.ws = null; }
  }
}

function diffKeys(prev: Map<string, FlagValue>, next: Record<string, FlagValue>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(next)) {
    seen.add(k);
    if (!eq(prev.get(k), v)) out.push(k);
  }
  for (const k of prev.keys()) if (!seen.has(k)) out.push(k);
  return out;
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}
