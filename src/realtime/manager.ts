import type { HttpClient } from "../client.ts";
import type { AnyRecord, RealtimeEvent, SubscribeCallback, SubscribeFilter } from "../types.ts";

const BACKOFF_MS = [250, 500, 1000, 2000, 5000, 10_000];
const HEARTBEAT_MS = 30_000;

/** Internal subscription record. */
interface Sub<R = AnyRecord> {
  collection: string;
  filter: SubscribeFilter;
  cb: SubscribeCallback<R>;
}

interface Transport {
  send(msg: { type: "subscribe" | "unsubscribe"; topics: string[] }): void;
  /** Present the current token on the open connection. */
  auth(token: string | null): void;
  close(): void;
}

/**
 * Realtime transport manager. Tries WS first, falls back to SSE on failure.
 * Reconnects with exponential backoff + jitter; re-subscribes all topics on
 * each reconnect (server doesn't preserve clientId).
 */
export class RealtimeManager {
  private subs: Sub[] = [];
  private topicRefs = new Map<string, number>();
  private transport: Transport | null = null;
  private connecting = false;
  private closed = false;
  private attempt = 0;
  private clientId: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private dedup = new Set<string>();
  private lastToken: string | null = null;
  private stopAuthWatch: (() => void) | null = null;

  constructor(private readonly client: HttpClient) {}

  /**
   * Keep the connection's identity in step with the auth store. The server
   * checks a connection's token when it's sent and re-checks it every
   * minute (server 0.17+); a token refreshed after connecting was never
   * re-sent, so the connection fell back to anonymous when the old one
   * expired.
   */
  private watchAuth(): void {
    if (this.stopAuthWatch || !this.client.authStore.onChange) return;
    this.lastToken = this.client.authStore.get()?.token ?? null;
    this.stopAuthWatch = this.client.authStore.onChange(() => {
      const token = this.client.authStore.get()?.token ?? null;
      if (token === this.lastToken) return;
      this.lastToken = token;
      this.transport?.auth(token);
    });
  }

  /** `auth_expired` from the server: refresh once; the new token is re-sent via watchAuth. */
  private onAuthExpired(): void {
    if (!this.client.authStore.get()?.token) return;
    void this.client.refresher.refreshOnce().then((ok) => {
      // A store without onChange can't notify us; send the new token directly.
      if (ok && !this.client.authStore.onChange) this.transport?.auth(this.client.authStore.get()?.token ?? null);
    }).catch(() => {});
  }

  subscribe<R = AnyRecord>(collection: string, filter: SubscribeFilter, cb: SubscribeCallback<R>): () => void {
    const sub: Sub = { collection, filter, cb: cb as SubscribeCallback };
    this.subs.push(sub);
    this.closed = false;
    this.watchAuth();
    const topics = topicsFor(sub);
    for (const t of topics) {
      this.topicRefs.set(t, (this.topicRefs.get(t) ?? 0) + 1);
    }
    void this.ensureConnected().then(() => {
      this.transport?.send({ type: "subscribe", topics: this.uniqueTopics() });
    });
    return () => this.unsubscribe(sub);
  }

  private unsubscribe(sub: Sub): void {
    const i = this.subs.indexOf(sub);
    if (i < 0) return;
    this.subs.splice(i, 1);
    const topics = topicsFor(sub);
    for (const t of topics) {
      const n = (this.topicRefs.get(t) ?? 1) - 1;
      if (n <= 0) this.topicRefs.delete(t);
      else this.topicRefs.set(t, n);
    }
    this.transport?.send({ type: "unsubscribe", topics });
    if (this.subs.length === 0) this.closeNow();
  }

  /** Drop everything. Used on logout / unmount. */
  closeNow(): void {
    this.closed = true;
    this.subs = [];
    this.topicRefs.clear();
    this.stopAuthWatch?.();
    this.stopAuthWatch = null;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    try { this.transport?.close(); } catch { /* noop */ }
    this.transport = null;
  }

  private uniqueTopics(): string[] {
    return Array.from(this.topicRefs.keys());
  }

  private async ensureConnected(): Promise<void> {
    if (this.transport || this.connecting || this.closed) return;
    this.connecting = true;
    try {
      const t = await this.connectWs().catch(() => this.connectSse());
      this.transport = t;
      this.attempt = 0;
      this.connecting = false;
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const idx = Math.min(this.attempt, BACKOFF_MS.length - 1);
    const base = BACKOFF_MS[idx]!;
    const jitter = base * (0.8 + Math.random() * 0.4);
    this.attempt++;
    setTimeout(() => { void this.ensureConnected(); }, jitter);
  }

  private deliver(ev: RealtimeEvent): void {
    // De-dupe per (id+type) within a 1s sliding window — server fans out the
    // same event through both `<collection>` and `<collection>/<id>` topics.
    const key = `${ev.collection}:${ev.id ?? ev.record?.["id"] ?? ""}:${ev.type}`;
    if (this.dedup.has(key)) return;
    this.dedup.add(key);
    setTimeout(() => this.dedup.delete(key), 1000);
    for (const sub of this.subs) {
      if (sub.collection !== ev.collection && sub.filter !== "*") continue;
      if (sub.filter === "*") { sub.cb(ev); continue; }
      const ids = Array.isArray(sub.filter) ? sub.filter : [sub.filter];
      const evId = ev.id ?? (ev.record?.["id"] as string | undefined);
      if (evId && ids.includes(evId)) sub.cb(ev);
    }
  }

  // ── WebSocket path ──────────────────────────────────────────────────────
  private async connectWs(): Promise<Transport> {
    if (typeof globalThis.WebSocket === "undefined") throw new Error("no websocket");
    const wsUrl = this.client.baseUrl.replace(/^http/, "ws") + "/realtime";
    const ws = new globalThis.WebSocket(wsUrl);
    return await new Promise<Transport>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* noop */ }
        reject(new Error("ws timeout"));
      }, 5000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        const stored = this.client.authStore.get();
        if (stored?.token) {
          ws.send(JSON.stringify({ type: "auth", token: stored.token }));
        }
        const topics = this.uniqueTopics();
        if (topics.length > 0) ws.send(JSON.stringify({ type: "subscribe", topics }));
        this.startHeartbeat(() => ws.send(JSON.stringify({ type: "ping" })));
        const transport: Transport = {
          send: (msg) => ws.send(JSON.stringify(msg)),
          // A null token can't be "sent"; the server keeps the old identity
          // until it expires, then sends auth_expired. Reconnect to drop it now.
          auth: (token) => {
            if (token) { try { ws.send(JSON.stringify({ type: "auth", token })); } catch { /* closed */ } }
            else { try { ws.close(); } catch { /* noop */ } }
          },
          close: () => { try { ws.close(); } catch { /* noop */ } },
        };
        resolve(transport);
      });
      ws.addEventListener("message", (e) => {
        try {
          const data = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (data?.type === "connected") return;
          if (data?.type === "auth_expired") { this.onAuthExpired(); return; }
          if (data?.collection && data?.type) this.deliver(data as RealtimeEvent);
        } catch { /* drop malformed */ }
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        this.transport = null;
        if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
        if (!this.closed) this.scheduleReconnect();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("ws error"));
      });
    });
  }

  // ── SSE fallback ────────────────────────────────────────────────────────
  private async connectSse(): Promise<Transport> {
    if (typeof globalThis.EventSource === "undefined") throw new Error("no eventsource");
    // SSE adapter: open the stream, capture clientId from first frame, then
    // POST subscriptions. Topic mutations re-POST to /api/v1/realtime.
    const url = this.client.baseUrl + "/api/v1/realtime";
    const es = new globalThis.EventSource(url, { withCredentials: true });
    return await new Promise<Transport>((resolve, reject) => {
      const timer = setTimeout(() => { try { es.close(); } catch { /* noop */ } reject(new Error("sse timeout")); }, 5000);
      es.addEventListener("connect", (ev: MessageEvent) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(ev.data) as { clientId?: string };
          if (parsed.clientId) this.clientId = parsed.clientId;
        } catch { /* noop */ }
        void this.sseSubscribe(this.uniqueTopics());
        const transport: Transport = {
          send: (msg) => {
            if (msg.type === "subscribe") void this.sseSubscribe(this.uniqueTopics());
            else if (msg.type === "unsubscribe") void this.sseSubscribe(this.uniqueTopics());
          },
          // The SSE control POST carries the token; re-posting re-authenticates.
          auth: () => { void this.sseSubscribe(this.uniqueTopics()).catch(() => {}); },
          close: () => {
            try { es.close(); } catch { /* noop */ }
            if (this.clientId) {
              void this.client.request(`/api/v1/realtime/${encodeURIComponent(this.clientId)}`, { method: "DELETE" }).catch(() => {});
            }
          },
        };
        resolve(transport);
      });
      es.addEventListener("message", (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as RealtimeEvent | { type: "auth_expired" };
          if (data?.type === "auth_expired") { this.onAuthExpired(); return; }
          if ("collection" in data && data.collection && data.type) this.deliver(data as RealtimeEvent);
        } catch { /* drop */ }
      });
      es.addEventListener("error", () => {
        clearTimeout(timer);
        es.close();
        if (!this.closed) this.scheduleReconnect();
        reject(new Error("sse error"));
      });
    });
  }

  private async sseSubscribe(topics: string[]): Promise<void> {
    if (!this.clientId) return;
    const stored = this.client.authStore.get();
    await this.client.request("/api/v1/realtime", {
      method: "POST",
      body: {
        clientId: this.clientId,
        topics,
        ...(stored?.token ? { token: stored.token } : {}),
      },
    });
  }

  private startHeartbeat(send: () => void): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      try { send(); } catch { /* noop */ }
    }, HEARTBEAT_MS);
  }
}

/** Compute the WS topics implied by a `subscribe` call. */
function topicsFor(sub: Sub): string[] {
  if (sub.filter === "*") return [sub.collection, "*"];
  const ids = Array.isArray(sub.filter) ? sub.filter : [sub.filter];
  return ids.map((id) => `${sub.collection}/${id}`);
}
