/**
 * Token storage for GitHub OAuth credentials.
 *
 * Defaults to in-memory storage (process-scoped, lost on restart). If
 * `GITHUB_TOKEN_STORE_PATH` is set, tokens are also persisted to disk as JSON
 * so the OAuth flow survives reloads in local dev. Production deployments
 * should swap this for a real secret store (Azure Key Vault, AWS Secrets
 * Manager, etc.) by replacing the implementation behind the same interface.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { log } from '../lib/logger';

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  // Absolute Unix epoch (seconds) when the access token expires.
  // `undefined` means the token does not expire (classic OAuth Apps).
  expiresAt?: number;
  // Refresh token expiry (GitHub Apps issue refresh tokens valid for 6 months).
  refreshTokenExpiresAt?: number;
  scope?: string;
  tokenType?: string;
  obtainedAt: number;
}

export interface TokenStore {
  get(userId: string): Promise<StoredToken | undefined>;
  set(userId: string, token: StoredToken): Promise<void>;
  delete(userId: string): Promise<void>;
  list(): Promise<string[]>;
}

class InMemoryTokenStore implements TokenStore {
  protected tokens = new Map<string, StoredToken>();

  async get(userId: string): Promise<StoredToken | undefined> {
    return this.tokens.get(userId);
  }

  async set(userId: string, token: StoredToken): Promise<void> {
    this.tokens.set(userId, token);
  }

  async delete(userId: string): Promise<void> {
    this.tokens.delete(userId);
  }

  async list(): Promise<string[]> {
    return Array.from(this.tokens.keys());
  }
}

class FileBackedTokenStore extends InMemoryTokenStore {
  constructor(private readonly filePath: string) {
    super();
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw) as Record<string, StoredToken>;
      for (const [user, token] of Object.entries(data)) {
        this.tokens.set(user, token);
      }
      log.info('token store hydrated from disk', { count: this.tokens.size });
    } catch (err) {
      log.warn('failed to hydrate token store; starting empty', {
        error: (err as Error).message
      });
    }
  }

  private flush(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const data = Object.fromEntries(this.tokens.entries());
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  async set(userId: string, token: StoredToken): Promise<void> {
    await super.set(userId, token);
    this.flush();
  }

  async delete(userId: string): Promise<void> {
    await super.delete(userId);
    this.flush();
  }
}

export function createTokenStore(filePath?: string): TokenStore {
  return filePath ? new FileBackedTokenStore(filePath) : new InMemoryTokenStore();
}
