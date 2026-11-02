/**
 * Realtime connection lifecycle: closing while a socket opens, reconnect
 * backoff against a server that accepts and then closes, a refused origin,
 * and subscribe sending only new topics.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { HttpClient } from "../src/client.ts";
import { MemoryAuthStore } from "../src/auth/store.ts";
import { RealtimeManager } from "../src/realtime/manager.ts";

class FakeWs {
  static all: FakeWs[] = [];
  static onOpen: (ws: FakeWs) => void = () => {};
  sent: Array<{ type: string; topics?: string[] }> = [];
  closed = false;
  private handlers: Record<string, Array<(e: unknown) => void>> = {};
  constructor(public url: string) {
    FakeWs.all.push(this);
    setTimeout(() => { if (!this.closed) { this.emit("open", {}); FakeWs.onOpen(this); } }, 5);
  }
  addEventListener(t: string, fn: (e: unknown) => void) { (this.handlers[t] ??= []).push(fn); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { if (this.closed) return; this.closed = true; this.emit("close", {}); }
  emit(t: string, e: unknown) { for (const fn of this.handlers[t] ?? []) fn(e); }
}

const g = globalThis as unknown as { WebSocket?: unknown };
const saved = g.WebSocket;
afterEach(() => { g.WebSocket = saved; FakeWs.all = []; FakeWs.onOpen = () => {}; });

const client = () => new HttpClient({ baseUrl: "http://localhost", authStore: new MemoryAuthStore(), fetch: (async () => new Response("{}")) as unknown as typeof fetch });

describe("realtime lifecycle", () => {
  it("unsubscribing before the socket opens doesn't leave it open", async () => {
    g.WebSocket = FakeWs;
    const rt = new RealtimeManager(client());
    const off = rt.subscribe("posts", "*", () => {});
    off();
    await Bun.sleep(30);
    expect(FakeWs.all.length).toBeGreaterThan(0);
    expect(FakeWs.all.every((ws) => ws.closed)).toBe(true);
  });

  it("a server that accepts and closes at once is retried with growing delays, not every 250 ms", async () => {
    g.WebSocket = FakeWs;
    FakeWs.onOpen = (ws) => setTimeout(() => ws.close(), 1);
    const rt = new RealtimeManager(client());
    rt.subscribe("posts", "*", () => {});
    await Bun.sleep(2000);
    rt.closeNow();
    // 250 + 500 + 1000 ms of backoff fit in 2 s: about four sockets, not eight.
    expect(FakeWs.all.length).toBeLessThanOrEqual(5);
  });

  it("a refused origin stops the reconnects", async () => {
    g.WebSocket = FakeWs;
    FakeWs.onOpen = (ws) => { ws.emit("message", { data: JSON.stringify({ type: "error", reason: "origin_not_allowed" }) }); ws.close(); };
    const rt = new RealtimeManager(client());
    const warn = console.warn; console.warn = () => {};
    try {
      rt.subscribe("posts", "*", () => {});
      await Bun.sleep(800);
    } finally { console.warn = warn; rt.closeNow(); }
    expect(FakeWs.all.length).toBe(1);
  });

  it("a second subscription sends only its new topic", async () => {
    g.WebSocket = FakeWs;
    const rt = new RealtimeManager(client());
    rt.subscribe("posts", "*", () => {});
    await Bun.sleep(20);
    rt.subscribe("comments", "*", () => {});
    rt.subscribe("posts", "*", () => {});
    const subs = FakeWs.all[0]!.sent.filter((m) => m.type === "subscribe").map((m) => m.topics);
    expect(subs).toEqual([["posts"], ["comments"]]);
    rt.closeNow();
  });
});
