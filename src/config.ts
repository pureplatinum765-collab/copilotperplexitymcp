/**
 * Typed loader for the environment variables the server reads at startup.
 *
 * Variables fall into three groups:
 *   - Perplexity   : existing config, kept for backwards compatibility.
 *   - GitHub       : PAT default, plus optional OAuth App / GitHub App credentials.
 *   - StackOne     : optional. If unset, the GitHub-direct adapter is used.
 *
 * Nothing here throws at import time; callers decide whether a missing value is
 * fatal for their code path (e.g. the OAuth callback handler only complains
 * when OAuth is actually used).
 */

function readString(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface AppConfig {
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  perplexity: {
    apiKey: string | undefined;
    defaultModel: string;
  };

  github: {
    // PAT used when no per-user OAuth token is available.
    defaultToken: string | undefined;
    // OAuth App / GitHub App credentials. Only needed when running the OAuth flow.
    clientId: string | undefined;
    clientSecret: string | undefined;
    redirectUri: string | undefined;
    apiBaseUrl: string;
    oauthBaseUrl: string;
    userAgent: string;
    // Where to persist OAuth tokens between restarts. Empty -> in-memory only.
    tokenStorePath: string | undefined;
  };

  stackone: {
    apiKey: string | undefined;
    accountId: string | undefined;
    baseUrl: string;
    githubProvider: string;
  };
}

export function loadConfig(): AppConfig {
  const logLevelRaw = (readString('LOG_LEVEL', 'info') ?? 'info').toLowerCase();
  const logLevel = (['debug', 'info', 'warn', 'error'].includes(logLevelRaw)
    ? logLevelRaw
    : 'info') as AppConfig['logLevel'];

  return {
    port: readInt('PORT', 8080),
    logLevel,
    perplexity: {
      apiKey: readString('PERPLEXITY_API_KEY'),
      defaultModel: readString('PERPLEXITY_MODEL', 'sonar') ?? 'sonar'
    },
    github: {
      defaultToken: readString('GITHUB_TOKEN'),
      clientId: readString('GITHUB_CLIENT_ID'),
      clientSecret: readString('GITHUB_CLIENT_SECRET'),
      redirectUri: readString('GITHUB_REDIRECT_URI'),
      apiBaseUrl: readString('GITHUB_API_BASE_URL', 'https://api.github.com') ?? 'https://api.github.com',
      oauthBaseUrl: readString('GITHUB_OAUTH_BASE_URL', 'https://github.com') ?? 'https://github.com',
      userAgent: readString('GITHUB_USER_AGENT', 'stackone-github-mcp/1.0') ?? 'stackone-github-mcp/1.0',
      tokenStorePath: readString('GITHUB_TOKEN_STORE_PATH')
    },
    stackone: {
      apiKey: readString('STACKONE_API_KEY'),
      accountId: readString('STACKONE_ACCOUNT_ID'),
      baseUrl: readString('STACKONE_BASE_URL', 'https://api.stackone.com') ?? 'https://api.stackone.com',
      githubProvider: readString('STACKONE_GITHUB_PROVIDER', 'github') ?? 'github'
    }
  };
}
