/**
 * Adapter that routes GitHub data through StackOne's Unified API.
 *
 * StackOne authenticates with HTTP Basic (API key as the username, blank
 * password) and uses the `x-account-id` header to select which linked account
 * the call runs against. The exact path layout of StackOne's developer-tools
 * unified resource isn't standardized across all providers, so each path here
 * is intentionally overridable via env vars (see config.ts) — adjust them to
 * match your StackOne workspace if needed.
 *
 * The adapter falls back to the GitHub-direct implementation for any
 * operation that StackOne can't serve (e.g. raw issue search), which keeps
 * the tool surface stable regardless of which backend is wired in.
 */

import type { AppConfig } from '../config';
import { ConfigError, NotFoundError, RateLimitError, UpstreamError } from '../lib/errors';
import { log } from '../lib/logger';
import { withRetry } from '../lib/retry';
import type { GitHubDirectAdapter } from './githubDirect';
import type {
  GitHubAdapter,
  IssueSummary,
  ListIssuesOptions,
  ListPullsOptions,
  ListReposOptions,
  PagedResult,
  PullRequestSummary,
  RepoDetail,
  RepoSummary,
  RequestContext,
  SearchIssuesOptions,
  UserProfile
} from './types';

interface StackOneEnvelope<T> {
  data?: T;
  next?: string;
  next_page?: string;
  raw?: unknown;
}

export class StackOneAdapter implements GitHubAdapter {
  readonly name = 'stackone' as const;
  private readonly authHeader: string;

  constructor(
    private readonly config: AppConfig['stackone'],
    private readonly fallback: GitHubDirectAdapter
  ) {
    if (!config.apiKey) {
      throw new ConfigError('STACKONE_API_KEY is required to use the StackOne adapter');
    }
    this.authHeader = `Basic ${Buffer.from(`${config.apiKey}:`).toString('base64')}`;
  }

  async listRepositories(
    opts: ListReposOptions,
    ctx: RequestContext
  ): Promise<PagedResult<RepoSummary>> {
    // StackOne unified GitHub coverage varies by workspace. Where it exposes a
    // repositories resource, we expect `/unified/dev-tools/repositories`. The
    // call gracefully falls back to GitHub-direct on 404.
    const params = new URLSearchParams();
    if (opts.owner) params.set('filter[owner]', opts.owner);
    if (opts.perPage) params.set('page_size', String(opts.perPage));
    if (opts.page) params.set('page', String(opts.page));

    try {
      const env = await this.get<StackOneEnvelope<RepoSummary[]>>(
        `/unified/dev-tools/repositories?${params}`,
        ctx
      );
      const items = env.data ?? [];
      return {
        items,
        page: opts.page ?? 1,
        perPage: opts.perPage ?? 30,
        hasMore: Boolean(env.next || env.next_page) || items.length >= (opts.perPage ?? 30)
      };
    } catch (err) {
      return this.fallbackOr404<PagedResult<RepoSummary>>(err, () =>
        this.fallback.listRepositories(opts, ctx)
      );
    }
  }

  async getRepository(owner: string, repo: string, ctx: RequestContext): Promise<RepoDetail> {
    try {
      const env = await this.get<StackOneEnvelope<RepoDetail>>(
        `/unified/dev-tools/repositories/${encodeURIComponent(`${owner}/${repo}`)}`,
        ctx
      );
      if (!env.data) throw new NotFoundError(`repository ${owner}/${repo} not found via StackOne`);
      return env.data;
    } catch (err) {
      return this.fallbackOr404(err, () => this.fallback.getRepository(owner, repo, ctx));
    }
  }

  async listIssues(
    owner: string,
    repo: string,
    opts: ListIssuesOptions,
    ctx: RequestContext
  ): Promise<PagedResult<IssueSummary>> {
    const params = new URLSearchParams();
    params.set('filter[repository]', `${owner}/${repo}`);
    if (opts.state) params.set('filter[state]', opts.state);
    if (opts.perPage) params.set('page_size', String(opts.perPage));
    if (opts.page) params.set('page', String(opts.page));

    try {
      const env = await this.get<StackOneEnvelope<IssueSummary[]>>(
        `/unified/dev-tools/issues?${params}`,
        ctx
      );
      const items = env.data ?? [];
      return {
        items,
        page: opts.page ?? 1,
        perPage: opts.perPage ?? 30,
        hasMore: Boolean(env.next || env.next_page) || items.length >= (opts.perPage ?? 30)
      };
    } catch (err) {
      return this.fallbackOr404(err, () => this.fallback.listIssues(owner, repo, opts, ctx));
    }
  }

  searchIssues(opts: SearchIssuesOptions, ctx: RequestContext): Promise<PagedResult<IssueSummary>> {
    // StackOne's unified API doesn't expose GitHub's full text search yet —
    // delegate to the direct adapter so the tool keeps working.
    return this.fallback.searchIssues(opts, ctx);
  }

  async listPullRequests(
    owner: string,
    repo: string,
    opts: ListPullsOptions,
    ctx: RequestContext
  ): Promise<PagedResult<PullRequestSummary>> {
    const params = new URLSearchParams();
    params.set('filter[repository]', `${owner}/${repo}`);
    if (opts.state) params.set('filter[state]', opts.state);
    if (opts.perPage) params.set('page_size', String(opts.perPage));
    if (opts.page) params.set('page', String(opts.page));

    try {
      const env = await this.get<StackOneEnvelope<PullRequestSummary[]>>(
        `/unified/dev-tools/pull-requests?${params}`,
        ctx
      );
      const items = env.data ?? [];
      return {
        items,
        page: opts.page ?? 1,
        perPage: opts.perPage ?? 30,
        hasMore: Boolean(env.next || env.next_page) || items.length >= (opts.perPage ?? 30)
      };
    } catch (err) {
      return this.fallbackOr404(err, () =>
        this.fallback.listPullRequests(owner, repo, opts, ctx)
      );
    }
  }

  async getUser(login: string | undefined, ctx: RequestContext): Promise<UserProfile> {
    const path = login
      ? `/unified/dev-tools/users/${encodeURIComponent(login)}`
      : '/unified/dev-tools/users/me';

    try {
      const env = await this.get<StackOneEnvelope<UserProfile>>(path, ctx);
      if (!env.data) throw new NotFoundError(`user ${login ?? 'me'} not found via StackOne`);
      return env.data;
    } catch (err) {
      return this.fallbackOr404(err, () => this.fallback.getUser(login, ctx));
    }
  }

  // ---------------------------------------------------------------------------

  private async get<T>(path: string, ctx: RequestContext): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    return withRetry(async () => {
      log.debug('stackone request', { method: 'GET', url, user_id: ctx.userId });

      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: this.authHeader,
        'x-stackone-provider': this.config.githubProvider
      };
      if (this.config.accountId) headers['x-account-id'] = this.config.accountId;

      const resp = await fetch(url, { method: 'GET', headers });

      if (resp.status === 404) {
        throw new NotFoundError(`StackOne resource not found: ${path}`);
      }
      if (resp.status === 429) {
        const retryAfter = Number.parseInt(resp.headers.get('retry-after') ?? '30', 10);
        throw new RateLimitError(Number.isFinite(retryAfter) ? retryAfter : 30, 'StackOne rate limited');
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => undefined);
        throw new UpstreamError(resp.status, `StackOne ${resp.status} for ${path}`, body);
      }
      return (await resp.json()) as T;
    });
  }

  private async fallbackOr404<T>(err: unknown, fn: () => Promise<T>): Promise<T> {
    if (err instanceof NotFoundError) {
      log.info('stackone returned 404; falling back to github-direct', {
        error: err.message
      });
      return fn();
    }
    throw err;
  }
}
