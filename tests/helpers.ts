/**
 * Test helpers. Boots the Express app on a random free port with injected
 * config + auth + adapter, returns a `{ url, close }` handle. Each test owns
 * its own server instance, so tests are independent and parallel-safe.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AppConfig } from '../src/config';
import { GitHubAuth } from '../src/auth/github';
import { createTokenStore, type TokenStore } from '../src/auth/tokenStore';
import { GitHubDirectAdapter } from '../src/adapters/githubDirect';
import type { GitHubAdapter } from '../src/adapters/types';
import { setLogLevel } from '../src/lib/logger';
import { buildApp } from '../src/server';

// Suppress info-level request logs so test output stays readable. Errors
// still surface, so genuine regressions remain visible.
setLogLevel('error');

export type ConfigOverrides = {
  github?: Partial<AppConfig['github']>;
  stackone?: Partial<AppConfig['stackone']>;
  perplexity?: Partial<AppConfig['perplexity']>;
  port?: number;
  logLevel?: AppConfig['logLevel'];
};

export function makeConfig(overrides: ConfigOverrides = {}): AppConfig {
  return {
    port: overrides.port ?? 0,
    logLevel: overrides.logLevel ?? 'error',
    perplexity: {
      apiKey: undefined,
      defaultModel: 'sonar',
      ...overrides.perplexity
    },
    github: {
      defaultToken: undefined,
      clientId: undefined,
      clientSecret: undefined,
      redirectUri: undefined,
      apiBaseUrl: 'https://api.github.com',
      oauthBaseUrl: 'https://github.com',
      userAgent: 'mcp-test/1.0',
      tokenStorePath: undefined,
      ...overrides.github
    },
    stackone: {
      apiKey: undefined,
      accountId: undefined,
      baseUrl: 'https://api.stackone.com',
      githubProvider: 'github',
      ...overrides.stackone
    }
  };
}

export interface BootedApp {
  url: string;
  close(): Promise<void>;
  auth: GitHubAuth;
  adapter: GitHubAdapter;
  tokenStore: TokenStore;
}

export async function bootApp(opts: {
  config?: AppConfig;
  adapter?: GitHubAdapter;
  tokenStore?: TokenStore;
} = {}): Promise<BootedApp> {
  const config = opts.config ?? makeConfig();
  const tokenStore = opts.tokenStore ?? createTokenStore(config.github.tokenStorePath);
  const auth = new GitHubAuth(config.github, tokenStore);
  const adapter = opts.adapter ?? new GitHubDirectAdapter(config.github, auth);

  const app = buildApp({ config, auth, adapter });

  return new Promise(resolve => {
    const server: http.Server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        auth,
        adapter,
        tokenStore,
        close: () =>
          new Promise<void>(r => {
            server.close(() => r());
          })
      });
    });
  });
}

/** Wraps `fetch` to also return parsed JSON when the response has that content-type. */
export async function jsonFetch(
  url: string,
  init?: RequestInit
): Promise<{ status: number; body: any; headers: Headers }> {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let body: any = text;
  if (resp.headers.get('content-type')?.includes('application/json')) {
    try {
      body = JSON.parse(text);
    } catch {
      // leave as text
    }
  }
  return { status: resp.status, body, headers: resp.headers };
}
