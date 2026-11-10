import { isApiToken, type HttpClient } from "../client.ts";
import type { AnyRecord, RealtimeEvent, SubscribeCallback, SubscribeFilter } from "../types.ts";

const BACKOFF_MS = [250, 500, 1000, 2000, 5000, 10_000];
const HEARTBEAT_MS = 30_000;
/** A connection must stay up this long before the backoff starts over. */
const STABLE_MS = 5_000;

interface WarningFrame { type: "warning"; reason?: unknown; topic?: unknown; message?: unknown }

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
  private lastToken: string | null = null;
  private stopAuthWatch: (() => void) | null = null;
  /** Bumped by closeNow(): a socket from an older generation is stale. */
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  /** The server refused this origin: retrying can't help until the page reloads. */
  private refused = false;
  /** SSE subscription POSTs, one at a time; each sends the topics held then. */
  private ssePosting: Promise<void> = Promise.resolve();

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

  /** `auth_expired` from the server: refresh once; the new token is re-sent via watchAuth. An API token can't be refreshed. */
  private onAuthExpired(): void {
    const token = this.client.authStore.get()?.token;
    if (!token || isApiToken(token)) return;
    void this.client.refresher.refreshOnce().then((ok) => {
      // A store without onChange can't notify us; send the new token directly.
      if (ok && !this.client.authStore.onChange) this.transport?.auth(this.client.authStore.get()?.token ?? null);
    }).catch(() => {});
  }

  /** A `warning` frame (server 0.42+), e.g. a subscription to a collection that doesn't exist. */
  private onWarningFrame(f: WarningFrame): void {
    const reason = typeof f.reason === "string" ? f.reason : undefined;
    const topic = typeof f.topic === "string" ? f.topic : undefined;
    // System topics (`__flags`) aren't collections; server 0.42.0 warned on them.
    if (topic?.startsWith("__")) return;
    const message = typeof f.message === "string" && f.message
      ? f.message
      : `${reason ?? "warning"}${topic ? ` (topic '${topic}')` : ""}`;
    this.client.emitWarning({ source: "realtime", message, ...(reason ? { reason } : {}), ...(topic ? { topic } : {}) });
  }

  subscribe<R = AnyRecord>(collection: string, filter: SubscribeFilter, cb: SubscribeCallback<R>): () => void {
    const sub: Sub = { collection, filter, cb: cb as SubscribeCallback };
    this.subs.push(sub);
    this.closed = false;
    this.watchAuth();
    // Only topics nobody held yet: a (re)connect sends the whole list itself.
    const added: string[] = [];
    for (const t of topicsFor(sub)) {
      const n = this.topicRefs.get(t) ?? 0;
      if (n === 0) added.push(t);
      this.topicRefs.set(t, n + 1);
    }
    if (this.transport) { if (added.length > 0) this.transport.send({ type: "subscribe", topics: added }); }
    else void this.ensureConnected();
    return () => this.unsubscribe(sub);
  }

  private unsubscribe(sub: Sub): void {
    const i = this.subs.indexOf(sub);
    if (i < 0) return;
    this.subs.splice(i, 1);
    // Another subscription may hold the same topic; the server only hears
    // about the ones nobody holds any more.
    const released: string[] = [];
    for (const t of topicsFor(sub)) {
      const n = (this.topicRefs.get(t) ?? 1) - 1;
      if (n <= 0) { this.topicRefs.delete(t); released.push(t); }
      else this.topicRefs.set(t, n);
    }
    if (released.length > 0) this.transport?.send({ type: "unsubscribe", topics: released });
    if (this.subs.length === 0) this.closeNow();
  }

  /** Drop everything. Used on logout / unmount. */
  closeNow(): void {
    this.closed = true;
    this.generation++;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
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
    if (this.transport || this.connecting || this.closed || this.refused) return;
    this.connecting = true;
    const gen = this.generation;
    try {
      const t = await this.connectWs(gen).catch(() => this.connectSse(gen));
      this.connecting = false;
      // Closed (an unsubscribe, a logout) while it opened: don't keep it.
      if (gen !== this.generation) { t.close(); return; }
      this.transport = t;
      // A server that accepts and then closes at once (a refused origin, the
      // connection cap, maintenance) must not reset the backoff.
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => { this.stableTimer = null; this.attempt = 0; }, STABLE_MS);
    } catch {
      this.connecting = false;
      if (gen === this.generation) this.scheduleReconnect();
    }
  }

  /** The current transport went away: forget it and try again later. */
  private dropped(t: Transport | null): void {
    if (t && this.transport !== t) return; // an older socket's late event
    this.transport = null;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
    if (!this.closed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.refused || this.retryTimer) return;
    const idx = Math.min(this.attempt, BACKOFF_MS.length - 1);
    const base = BACKOFF_MS[idx]!;
    const jitter = base * (0.8 + Math.random() * 0.4);
    this.attempt++;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.ensureConnected(); }, jitter);
  }

  /**
   * Hand an event to the subscriptions it belongs to. The server sends each
   * event once per connection, however many of its topics match, so there's
   * nothing to de-duplicate here: two updates to one record in quick
   * succession are two events.
   */
  private deliver(ev: RealtimeEvent): void {
    for (const sub of this.subs) {
      if (sub.collection !== "*" && sub.collection !== ev.collection) continue;
      if (sub.filter === "*") { sub.cb(ev); continue; }
      const ids = Array.isArray(sub.filter) ? sub.filter : [sub.filter];
      const evId = ev.id ?? (ev.record?.["id"] as string | undefined);
      if (evId && ids.includes(evId)) sub.cb(ev);
    }
  }

  // ── WebSocket path ──────────────────────────────────────────────────────
  private async connectWs(gen: number): Promise<Transport> {
    if (typeof globalThis.WebSocket === "undefined") throw new Error("no websocket");
    const wsUrl = this.client.baseUrl.replace(/^http/, "ws") + "/realtime";
    const ws = new globalThis.WebSocket(wsUrl);
    // Until it opens, a failure is ensureConnected's to handle (it falls back
    // to SSE or schedules the retry); after, a drop reconnects from here.
    let opened = false;
    let transport: Transport | null = null;
    return await new Promise<Transport>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* noop */ }
        reject(new Error("ws timeout"));
      }, 5000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        opened = true;
        if (gen !== this.generation) { try { ws.close(); } catch { /* noop */ } reject(new Error("closed")); return; }
        const stored = this.client.authStore.get();
        if (stored?.token) {
          ws.send(JSON.stringify({ type: "auth", token: stored.token }));
        }
        const topics = this.uniqueTopics();
        if (topics.length > 0) ws.send(JSON.stringify({ type: "subscribe", topics }));
        this.startHeartbeat(() => ws.send(JSON.stringify({ type: "ping" })));
        transport = {
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
          if (data?.type === "warning") { this.onWarningFrame(data); return; }
          if (data?.type === "error" && data?.reason === "origin_not_allowed") {
            this.refused = true;
            console.warn("[vaultbase] realtime: this origin isn't in the server's allowed origins; not reconnecting");
            return;
          }
          if (data?.collection && data?.type) this.deliver(data as RealtimeEvent);
        } catch { /* drop malformed */ }
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        if (!opened) { reject(new Error("ws closed")); return; }
        if (gen === this.generation) this.dropped(transport);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("ws error"));
      });
    });
  }

  // ── SSE fallback ────────────────────────────────────────────────────────
  private async connectSse(gen: number): Promise<Transport> {
    if (typeof globalThis.EventSource === "undefined") throw new Error("no eventsource");
    // SSE adapter: open the stream, capture clientId from first frame, then
    // POST subscriptions. Topic mutations re-POST to /api/v1/realtime.
    const url = this.client.baseUrl + "/api/v1/realtime";
    const es = new globalThis.EventSource(url, { withCredentials: true });
    let opened = false; // as in connectWs
    let transport: Transport | null = null;
    return await new Promise<Transport>((resolve, reject) => {
      const timer = setTimeout(() => { try { es.close(); } catch { /* noop */ } reject(new Error("sse timeout")); }, 5000);
      es.addEventListener("connect", (ev: MessageEvent) => {
        clearTimeout(timer);
        opened = true;
        if (gen !== this.generation) { try { es.close(); } catch { /* noop */ } reject(new Error("closed")); return; }
        try {
          const parsed = JSON.parse(ev.data) as { clientId?: string };
          if (parsed.clientId) this.clientId = parsed.clientId;
        } catch { /* noop */ }
        this.sseSubscribe();
        transport = {
          // The server replaces the stream's whole topic list, so every
          // change posts the current one.
          send: () => this.sseSubscribe(),
          // The control POST carries the token, so re-posting re-authenticates.
          // Without a token it would keep the old identity: reopen the stream.
          auth: (token) => {
            if (token) { this.sseSubscribe(); return; }
            const t = transport;
            t?.close();
            this.dropped(t);
          },
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
          const data = JSON.parse(ev.data) as RealtimeEvent | { type: "auth_expired" } | WarningFrame;
          if (data?.type === "auth_expired") { this.onAuthExpired(); return; }
          if (data?.type === "warning") { this.onWarningFrame(data as WarningFrame); return; }
          if ("collection" in data && data.collection && data.type) this.deliver(data as RealtimeEvent);
        } catch { /* drop */ }
      });
      es.addEventListener("error", () => {
        clearTimeout(timer);
        es.close();
        if (!opened) { reject(new Error("sse error")); return; }
        // The stream dropped: forget it, so the reconnect opens a new one.
        this.clientId = null;
        if (gen === this.generation) this.dropped(transport);
      });
    });
  }

  /**
   * Post the current topics. Queued behind any POST in flight, and reading
   * the topics when its turn comes: two racing POSTs could land in the wrong
   * order, and the last one replaces the list.
   */
  private sseSubscribe(): void {
    this.ssePosting = this.ssePosting.then(async () => {
      if (!this.clientId) return;
      const stored = this.client.authStore.get();
      await this.client.request("/api/v1/realtime", {
        method: "POST",
        requestKey: null,
        body: {
          clientId: this.clientId,
          topics: this.uniqueTopics(),
          ...(stored?.token ? { token: stored.token } : {}),
        },
      });
    }).catch(() => { /* the next change or reconnect posts again */ });
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
  // `subscribe("*", "*")` is every collection; `subscribe(name, "*")` is one.
  if (sub.filter === "*") return [sub.collection];
  const ids = Array.isArray(sub.filter) ? sub.filter : [sub.filter];
  return ids.map((id) => `${sub.collection}/${id}`);
}
