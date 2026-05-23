/**
 * GitHub authentication: PAT default + OAuth (works for both OAuth Apps and
 * GitHub Apps with user-to-server tokens).
 *
 * Flow:
 *   1. Caller hits `GET /auth/github/start?user_id=<id>` — we generate a
 *      cryptographic state, remember the user_id it maps to, and 302 to GitHub.
 *   2. GitHub redirects to `GITHUB_REDIRECT_URI` with `?code=...&state=...`.
 *   3. `/auth/github/callback` validates state, exchanges the code for an
 *      access token, and stores it in the token store keyed by user_id.
 *
 * `getTokenFor(userId)` is the single entry point for the adapter layer:
 *   - returns the user's OAuth token if present (refreshing first if needed),
 *   - falls back to the env-var PAT (`GITHUB_TOKEN`) if no user-specific token
 *     exists. This makes local dev painless while still supporting per-user
 *     auth in production.
 */

import * as crypto from 'node:crypto';

import type { AppConfig } from '../config';
import { AuthError, ConfigError, UpstreamError } from '../lib/errors';
import { log } from '../lib/logger';
import type { StoredToken, TokenStore } from './tokenStore';

interface PendingState {
  userId: string;
  createdAt: number;
  // Where to redirect the browser after the callback completes successfully.
  // Optional — handy when the OAuth flow is initiated from another app.
  returnTo?: string;
}

interface AccessTokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

// Refresh refresh tokens that are within this many seconds of expiry.
const REFRESH_SKEW_SECONDS = 60;

// Drop pending state entries older than this — protects against unbounded growth.
const PENDING_STATE_TTL_MS = 15 * 60 * 1000;

export class GitHubAuth {
  private readonly pendingStates = new Map<string, PendingState>();

  constructor(
    private readonly config: AppConfig['github'],
    private readonly tokenStore: TokenStore
  ) {}

  /** True when the OAuth flow is configured. */
  isOAuthConfigured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret && this.config.redirectUri);
  }

  /**
   * Build the GitHub authorize URL and stash the state so we can validate it
   * on callback. Caller is expected to 302 to the returned URL.
   */
  beginOAuth(userId: string, scope = 'repo read:user', returnTo?: string): string {
    if (!this.isOAuthConfigured()) {
      throw new ConfigError(
        'OAuth is not configured: set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_REDIRECT_URI'
      );
    }

    this.evictExpiredStates();

    const state = crypto.randomBytes(24).toString('hex');
    this.pendingStates.set(state, { userId, createdAt: Date.now(), returnTo });

    const url = new URL(`${this.config.oauthBaseUrl}/login/oauth/authorize`);
    url.searchParams.set('client_id', this.config.clientId!);
    url.searchParams.set('redirect_uri', this.config.redirectUri!);
    url.searchParams.set('scope', scope);
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'true');

    log.info('oauth flow started', { user_id: userId, scope });
    return url.toString();
  }

  /**
   * Validate the state, exchange the code for an access token, and store it.
   * Returns the user_id and the optional returnTo URL the caller passed in.
   */
  async completeOAuth(code: string, state: string): Promise<{ userId: string; returnTo?: string }> {
    if (!this.isOAuthConfigured()) {
      throw new ConfigError('OAuth is not configured');
    }

    const pending = this.pendingStates.get(state);
    if (!pending) {
      throw new AuthError('unknown or expired OAuth state');
    }
    this.pendingStates.delete(state);

    if (Date.now() - pending.createdAt > PENDING_STATE_TTL_MS) {
      throw new AuthError('OAuth state expired; restart the flow');
    }

    const tokenResp = await this.exchangeCode(code);
    const stored = this.toStoredToken(tokenResp);
    await this.tokenStore.set(pending.userId, stored);

    log.info('oauth token stored', {
      user_id: pending.userId,
      has_refresh_token: Boolean(stored.refreshToken),
      expires_at: stored.expiresAt
    });

    return { userId: pending.userId, returnTo: pending.returnTo };
  }

  /**
   * Resolve a usable bearer token for `userId`:
   *   - prefer the user's OAuth token, refreshing if near expiry,
   *   - else fall back to the env PAT,
   *   - else throw AuthError.
   */
  async getTokenFor(userId?: string): Promise<string> {
    if (userId) {
      const stored = await this.tokenStore.get(userId);
      if (stored) {
        const fresh = await this.refreshIfNeeded(userId, stored);
        return fresh.accessToken;
      }
    }

    if (this.config.defaultToken) {
      return this.config.defaultToken;
    }

    throw new AuthError(
      userId
        ? `no GitHub token stored for user "${userId}" and no GITHUB_TOKEN fallback set`
        : 'no GITHUB_TOKEN set and no user_id provided'
    );
  }

  /** Revoke a stored OAuth token locally. Does not call GitHub's revoke endpoint. */
  async revoke(userId: string): Promise<void> {
    await this.tokenStore.delete(userId);
    log.info('oauth token revoked locally', { user_id: userId });
  }

  // ---------------------------------------------------------------------------

  private async exchangeCode(code: string): Promise<AccessTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.clientId!,
      client_secret: this.config.clientSecret!,
      code,
      redirect_uri: this.config.redirectUri!
    });

    const resp = await fetch(`${this.config.oauthBaseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': this.config.userAgent
      },
      body
    });

    if (!resp.ok) {
      throw new UpstreamError(resp.status, `GitHub OAuth exchange failed: ${resp.status}`);
    }

    const data = (await resp.json()) as AccessTokenResponse;
    if (data.error) {
      throw new AuthError(`GitHub OAuth error: ${data.error_description ?? data.error}`);
    }
    if (!data.access_token) {
      throw new AuthError('GitHub OAuth response missing access_token');
    }
    return data;
  }

  private async refreshIfNeeded(userId: string, stored: StoredToken): Promise<StoredToken> {
    if (!stored.expiresAt) return stored;

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (stored.expiresAt - nowSeconds > REFRESH_SKEW_SECONDS) return stored;

    if (!stored.refreshToken) {
      throw new AuthError(
        `stored token for user "${userId}" expired and no refresh token available; restart OAuth flow`
      );
    }

    log.info('refreshing GitHub token', { user_id: userId });

    const body = new URLSearchParams({
      client_id: this.config.clientId!,
      client_secret: this.config.clientSecret!,
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken
    });

    const resp = await fetch(`${this.config.oauthBaseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': this.config.userAgent
      },
      body
    });

    if (!resp.ok) {
      throw new UpstreamError(resp.status, `GitHub refresh failed: ${resp.status}`);
    }

    const data = (await resp.json()) as AccessTokenResponse;
    if (data.error || !data.access_token) {
      throw new AuthError(`GitHub refresh failed: ${data.error_description ?? data.error ?? 'unknown'}`);
    }

    const refreshed = this.toStoredToken(data);
    await this.tokenStore.set(userId, refreshed);
    return refreshed;
  }

  private toStoredToken(resp: AccessTokenResponse): StoredToken {
    const obtainedAt = Math.floor(Date.now() / 1000);
    return {
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token,
      tokenType: resp.token_type,
      scope: resp.scope,
      expiresAt: resp.expires_in ? obtainedAt + resp.expires_in : undefined,
      refreshTokenExpiresAt: resp.refresh_token_expires_in
        ? obtainedAt + resp.refresh_token_expires_in
        : undefined,
      obtainedAt
    };
  }

  private evictExpiredStates(): void {
    const cutoff = Date.now() - PENDING_STATE_TTL_MS;
    for (const [state, entry] of this.pendingStates) {
      if (entry.createdAt < cutoff) this.pendingStates.delete(state);
    }
  }
}
