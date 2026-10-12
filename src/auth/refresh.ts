import type { HttpClient } from "../client.ts";

interface RefreshResponse { token: string }

/**
 * Coordinates token refresh across the SDK instance. Dedupes concurrent
 * callers via an in-flight promise; cross-tab dedup via BroadcastChannel
 * when the runtime supports it.
 */
export class RefreshCoordinator {
  private inFlight: Promise<boolean> | null = null;
  private channel: BroadcastChannel | null = null;

  constructor(private readonly client: HttpClient) {
    if (typeof globalThis !== "undefined" && "BroadcastChannel" in globalThis) {
      try {
        this.channel = new (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel })
          .BroadcastChannel("vaultbase-refresh");
        this.channel.addEventListener("message", (ev: MessageEvent<unknown>) => {
          const msg = ev.data as { type?: string; token?: string } | null;
          if (msg?.type === "refreshed" && typeof msg.token === "string") {
            const cur = this.client.authStore.get();
            this.client.authStore.set({ token: msg.token, ...(cur?.record ? { record: cur.record } : {}) });
          } else if (msg?.type === "logout") {
            this.client.authStore.set(null);
          }
        });
      } catch { this.channel = null; }
    }
  }

  /**
   * Refresh the token. Returns true on success. Multiple concurrent callers
   * collapse onto the same in-flight refresh.
   */
  refreshOnce(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doRefresh(): Promise<boolean> {
    try {
      const data = await this.client.request<RefreshResponse>("/api/v1/auth/refresh", {
        method: "POST",
        skipAuth: false,
        // Sends the current bearer but must not re-enter maybeRefresh(): that
        // returns this same in-flight refresh, which would wait on itself.
        skipRefresh: true,
        requestKey: null,
      });
      if (!data?.token) {
        this.client.authStore.set(null);
        this.broadcast({ type: "logout" });
        return false;
      }
      const prev = this.client.authStore.get();
      this.client.authStore.set({ token: data.token, ...(prev?.record ? { record: prev.record } : {}) });
      this.broadcast({ type: "refreshed", token: data.token });
      return true;
    } catch {
      this.client.authStore.set(null);
      this.broadcast({ type: "logout" });
      return false;
    }
  }

  private broadcast(msg: { type: "refreshed"; token: string } | { type: "logout" }): void {
    if (!this.channel) return;
    try { this.channel.postMessage(msg); } catch { /* noop */ }
  }
}
