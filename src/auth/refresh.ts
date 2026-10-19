import type { HttpClient } from "../client.ts";

interface RefreshResponse { token: string }

/**
 * Coordinates token refresh for one SDK instance: concurrent callers share
 * one in-flight refresh.
 *
 * Nothing is broadcast to other instances or tabs. A store shared across
 * tabs (`LocalStorageAuthStore`) already shares the new token and tells
 * other tabs through the `storage` event; any other store holds a session of
 * its own, which another client's refresh or 401 must not touch. (A shared
 * BroadcastChannel used to do exactly that, and also kept Bun and Node
 * processes from exiting.)
 */
export class RefreshCoordinator {
  private inFlight: Promise<boolean> | null = null;

  constructor(private readonly client: HttpClient) {}

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
        return false;
      }
      const prev = this.client.authStore.get();
      this.client.authStore.set({ token: data.token, ...(prev?.record ? { record: prev.record } : {}) });
      return true;
    } catch {
      this.client.authStore.set(null);
      return false;
    }
  }
}
