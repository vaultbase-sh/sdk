import type { HttpClient } from "../client.ts";
import type { AnyRecord } from "../types.ts";

export interface LoginInput { email: string; password: string }
export interface LoginResult<R = AnyRecord> { token: string; record: R }
export interface MfaPending { mfa_required: true; mfa_token: string }

export interface RegisterInput {
  email: string;
  password: string;
  [k: string]: unknown;
}

export interface OtpRequestInput { email: string }
export interface OtpAuthInput { token?: string; code?: string; email?: string }

export interface MfaLoginInput { mfa_token: string; code?: string; recovery_code?: string }

export interface OAuth2AuthorizeQuery {
  provider: string;
  redirectUri: string;
  state?: string;
  use_pkce?: "1";
  code_challenge?: string;
}

export interface OAuth2ExchangeInput {
  provider: string;
  code: string;
  redirectUri: string;
  state?: string;
  code_verifier?: string;
}

export interface OAuth2MergeConfirmInput {
  merge_token: string;
  password?: string;
}

/** Per-collection auth namespace: `vb.auth.users.login(...)`. */
export class CollectionAuth<R = AnyRecord> {
  constructor(private readonly client: HttpClient, private readonly collection: string) {}

  async register(input: RegisterInput): Promise<{ id: string; email: string }> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/register`, {
      method: "POST",
      body: input,
      skipAuth: true,
    });
  }

  async login(input: LoginInput): Promise<LoginResult<R> | MfaPending> {
    const data = await this.client.request<LoginResult<R> | MfaPending>(
      `/api/v1/auth/${enc(this.collection)}/login`,
      { method: "POST", body: input, skipAuth: true },
    );
    if (!("mfa_required" in data) && data.token) {
      this.client.authStore.set({ token: data.token, record: data.record as Record<string, unknown> });
    }
    return data;
  }

  async loginMfa(input: MfaLoginInput): Promise<LoginResult<R>> {
    const data = await this.client.request<LoginResult<R>>(
      `/api/v1/auth/${enc(this.collection)}/login/mfa`,
      { method: "POST", body: input, skipAuth: true },
    );
    if (data.token) {
      this.client.authStore.set({ token: data.token, record: data.record as Record<string, unknown> });
    }
    return data;
  }

  async requestVerify(): Promise<{ sent: boolean; alreadyVerified?: boolean }> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/request-verify`, { method: "POST" });
  }

  async verifyEmail(token: string): Promise<{ verified: boolean }> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/verify-email`, {
      method: "POST",
      body: { token },
      skipAuth: true,
    });
  }

  async requestPasswordReset(email: string): Promise<{ sent: boolean }> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/request-password-reset`, {
      method: "POST",
      body: { email },
      skipAuth: true,
    });
  }

  async confirmPasswordReset(token: string, password: string): Promise<{ reset: boolean }> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/confirm-password-reset`, {
      method: "POST",
      body: { token, password },
      skipAuth: true,
    });
  }

  /** Email a confirmation link to `newEmail` (signed-in user; server 0.16+). */
  async requestEmailChange(newEmail: string): Promise<{ sent: boolean }> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/request-email-change`, {
      method: "POST",
      body: { newEmail },
    });
  }

  /**
   * Apply the change with the link's token and the current password. Every
   * existing session ends, this one included; sign in again with the new email.
   */
  async confirmEmailChange(token: string, password: string): Promise<{ changed: boolean; email: string }> {
    const res = await this.client.request<{ changed: boolean; email: string }>(
      `/api/v1/auth/${enc(this.collection)}/confirm-email-change`,
      { method: "POST", body: { token, password }, skipAuth: true },
    );
    this.client.authStore.set(null);
    return res;
  }

  /** Set a password from an invitation link; also verifies the email (server 0.16+). */
  async acceptInvite(token: string, password: string): Promise<{ accepted: boolean }> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/accept-invite`, {
      method: "POST",
      body: { token, password },
      skipAuth: true,
    });
  }

  async otpRequest(email: string): Promise<{ sent: boolean }> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/otp/request`, {
      method: "POST",
      body: { email },
      skipAuth: true,
    });
  }

  async otpAuth(input: OtpAuthInput): Promise<LoginResult<R> | MfaPending> {
    const data = await this.client.request<LoginResult<R> | MfaPending>(
      `/api/v1/auth/${enc(this.collection)}/otp/auth`,
      { method: "POST", body: input, skipAuth: true },
    );
    if (!("mfa_required" in data) && data.token) {
      this.client.authStore.set({ token: data.token, record: data.record as Record<string, unknown> });
    }
    return data;
  }

  async totpSetup(): Promise<{ secret: string; otpauth_url: string }> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/totp/setup`, { method: "POST" });
  }

  async totpConfirm(code: string): Promise<{ enabled: true }> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/totp/confirm`, {
      method: "POST",
      body: { code },
    });
  }

  async totpDisable(code: string): Promise<{ enabled: false }> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/totp/disable`, {
      method: "POST",
      body: { code },
    });
  }

  async recoveryRegenerate(): Promise<{ codes: string[] }> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/totp/recovery/regenerate`, {
      method: "POST",
    });
  }

  async recoveryStatus(): Promise<{ total: number; remaining: number }> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/totp/recovery/status`);
  }

  async anonymous(): Promise<LoginResult<R>> {
    const data = await this.client.request<LoginResult<R>>(
      `/api/v1/auth/${enc(this.collection)}/anonymous`,
      { method: "POST", skipAuth: true },
    );
    if (data.token) {
      this.client.authStore.set({ token: data.token, record: data.record as Record<string, unknown> });
    }
    return data;
  }

  async promote(input: RegisterInput): Promise<LoginResult<R>> {
    const data = await this.client.request<LoginResult<R>>(
      `/api/v1/auth/${enc(this.collection)}/promote`,
      { method: "POST", body: input },
    );
    if (data.token) {
      this.client.authStore.set({ token: data.token, record: data.record as Record<string, unknown> });
    }
    return data;
  }

  async oauth2Providers(): Promise<Array<{ name: string; displayName?: string; clientId?: string }>> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/oauth2/providers`, { skipAuth: true });
  }

  async oauth2Authorize(query: OAuth2AuthorizeQuery): Promise<{
    authorize_url: string;
    code_challenge?: string;
    code_challenge_method?: "S256";
    pkce: "server" | "client" | "none";
  }> {
    const q: Record<string, string | number | boolean | undefined> = { ...query };
    return await this.client.request(
      `/api/v1/auth/${enc(this.collection)}/oauth2/authorize`,
      { query: q, skipAuth: true },
    );
  }

  async oauth2Exchange(input: OAuth2ExchangeInput): Promise<LoginResult<R> | { merge_required: true; merge_token: string; email: string; provider: string }> {
    const data = await this.client.request<LoginResult<R> | { merge_required: true; merge_token: string; email: string; provider: string }>(
      `/api/v1/auth/${enc(this.collection)}/oauth2/exchange`,
      { method: "POST", body: input, skipAuth: true },
    );
    if ("token" in data && data.token) {
      this.client.authStore.set({ token: data.token, record: data.record as Record<string, unknown> });
    }
    return data;
  }

  async oauth2MergeConfirm(input: OAuth2MergeConfirmInput): Promise<LoginResult<R> & { linked_provider: string }> {
    const data = await this.client.request<LoginResult<R> & { linked_provider: string }>(
      `/api/v1/auth/${enc(this.collection)}/oauth2/merge-confirm`,
      { method: "POST", body: input },
    );
    if (data.token) {
      this.client.authStore.set({ token: data.token, record: data.record as Record<string, unknown> });
    }
    return data;
  }

  async oauth2Unlink(provider: string): Promise<null> {
    return await this.client.request(`/api/v1/auth/${enc(this.collection)}/oauth2/${enc(provider)}/unlink`, {
      method: "DELETE",
    });
  }
}

/** Admin-namespaced auth flows. */
export class AdminAuth {
  constructor(private readonly client: HttpClient) {}

  async setup(input: { email: string; password: string }, opts: { setupKey?: string } = {}): Promise<{ id: string; email: string }> {
    return await this.client.request("/api/v1/admin/setup", {
      method: "POST",
      body: input,
      skipAuth: true,
      ...(opts.setupKey ? { headers: { "x-setup-key": opts.setupKey } } : {}),
    });
  }

  async setupStatus(): Promise<{ has_admin: boolean }> {
    return await this.client.request("/api/v1/admin/setup/status", { skipAuth: true });
  }

  async login(input: LoginInput): Promise<{ token: string; admin: { id: string; email: string } }> {
    const data = await this.client.request<{ token: string; admin: { id: string; email: string } }>(
      "/api/v1/admin/auth/login",
      { method: "POST", body: input, skipAuth: true },
    );
    if (data.token) this.client.authStore.set({ token: data.token, record: data.admin });
    return data;
  }

  async me(): Promise<{ id: string; email: string; aud: "admin"; exp?: number }> {
    return await this.client.request("/api/v1/admin/auth/me");
  }

  /** Create a user without a password and email them an invitation link (server 0.16+). */
  async invite(collection: string, email: string, data: Record<string, unknown> = {}): Promise<{ id: string; email: string }> {
    return await this.client.request(`/api/v1/admin/users/${enc(collection)}/invite`, {
      method: "POST",
      body: { email, data },
    });
  }

  async impersonate<R = AnyRecord>(collection: string, userId: string): Promise<LoginResult<R> & { impersonated_by: string }> {
    return await this.client.request(`/api/v1/admin/impersonate/${enc(collection)}/${enc(userId)}`, { method: "POST" });
  }
}

/** Shared (admin or user) flows. */
export class SharedAuth {
  constructor(private readonly client: HttpClient) {}

  async refresh(): Promise<{ token: string }> {
    return await this.client.request("/api/v1/auth/refresh", { method: "POST" });
  }

  async logout(): Promise<void> {
    try { await this.client.request("/api/v1/auth/logout", { method: "POST" }); }
    finally { this.client.authStore.set(null); }
  }

  async me<R = AnyRecord>(): Promise<R> {
    return await this.client.request("/api/v1/auth/me");
  }
}

function enc(s: string): string { return encodeURIComponent(s); }
