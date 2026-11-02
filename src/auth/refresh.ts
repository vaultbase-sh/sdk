import type { HttpClient } from "../client.ts";
import { VaultbaseError } from "../errors.ts";

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
   * Refresh the token. Resolves true on success, false when the server
   * refused the session (which then ends). Rejects when the refresh couldn't
   * be answered (offline, rate limited, maintenance, a 5xx): the session is
   * kept for a later try. Concurrent callers share one in-flight refresh.
   */
  refreshOnce(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doRefresh(): Promise<boolean> {
    const before = this.client.authStore.get()?.token;
    let data: RefreshResponse | null;
    try {
      data = await this.client.request<RefreshResponse>("/api/v1/auth/refresh", {
        method: "POST",
        skipAuth: false,
        // Sends the current bearer but must not re-enter maybeRefresh(): that
        // returns this same in-flight refresh, which would wait on itself.
        skipRefresh: true,
        requestKey: null,
      });
    } catch (e) {
      // A refused session (401) was already cleared by the client. Anything
      // else says nothing about the session: keep it.
      if (e instanceof VaultbaseError && e.kind === "auth") return false;
      throw e;
    }
    // Signed out or signed in again while this ran: leave that session alone.
    if (this.client.authStore.get()?.token !== before) return false;
    if (!data?.token) {
      this.client.authStore.set(null);
      return false;
    }
    const prev = this.client.authStore.get();
    this.client.authStore.set({ token: data.token, ...(prev?.record ? { record: prev.record } : {}) });
    return true;
  }
}
