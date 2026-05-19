/**
 * Adapter that talks directly to api.github.com.
 *
 * This is the default — it requires no third-party service. Used whenever
 * `STACKONE_API_KEY` is unset. Every request runs through `withRetry` so
 * transient 5xx and rate-limit responses are handled uniformly.
 */

import type { AppConfig } from '../config';
import type { GitHubAuth } from '../auth/github';
import { NotFoundError, RateLimitError, UpstreamError } from '../lib/errors';
import { log } from '../lib/logger';
import { withRetry } from '../lib/retry';
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

interface GhRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  visibility?: string;
  private?: boolean;
  default_branch: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  html_url: string;
  updated_at: string | null;
  topics?: string[];
  archived?: boolean;
  disabled?: boolean;
  size?: number;
  pushed_at?: string | null;
  created_at?: string | null;
  homepage?: string | null;
}

interface GhUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  public_repos: number;
  followers: number;
  following: number;
  html_url: string;
  created_at: string | null;
}

interface GhIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  user: { login: string } | null;
  assignees: Array<{ login: string }> | null;
  labels: Array<{ name: string } | string>;
  comments: number;
  html_url: string;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  body: string | null;
  pull_request?: unknown;
}

interface GhPull {
  id: number;
  number: number;
  title: string;
  state: string;
  user: { login: string } | null;
  base: { ref: string };
  head: { ref: string };
  draft: boolean;
  merged_at: string | null;
  html_url: string;
  created_at: string | null;
  updated_at: string | null;
  body: string | null;
}

export class GitHubDirectAdapter implements GitHubAdapter {
  readonly name = 'github-direct' as const;

  constructor(
    private readonly config: AppConfig['github'],
    private readonly auth: GitHubAuth
  ) {}

  async listRepositories(
    opts: ListReposOptions,
    ctx: RequestContext
  ): Promise<PagedResult<RepoSummary>> {
    const params = new URLSearchParams();
    if (opts.type) params.set('type', opts.type);
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.direction) params.set('direction', opts.direction);
    setPaging(params, opts);

    const path = opts.owner ? `/users/${enc(opts.owner)}/repos` : '/user/repos';
    const repos = await this.get<GhRepo[]>(`${path}?${params}`, ctx);
    return toPage(repos.map(toRepoSummary), opts);
  }

  async getRepository(owner: string, repo: string, ctx: RequestContext): Promise<RepoDetail> {
    const data = await this.get<GhRepo>(`/repos/${enc(owner)}/${enc(repo)}`, ctx);
    return toRepoDetail(data);
  }

  async listIssues(
    owner: string,
    repo: string,
    opts: ListIssuesOptions,
    ctx: RequestContext
  ): Promise<PagedResult<IssueSummary>> {
    const params = new URLSearchParams();
    if (opts.state) params.set('state', opts.state);
    if (opts.labels?.length) params.set('labels', opts.labels.join(','));
    if (opts.assignee) params.set('assignee', opts.assignee);
    if (opts.creator) params.set('creator', opts.creator);
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.direction) params.set('direction', opts.direction);
    setPaging(params, opts);

    const issues = await this.get<GhIssue[]>(
      `/repos/${enc(owner)}/${enc(repo)}/issues?${params}`,
      ctx
    );
    return toPage(issues.map(toIssueSummary), opts);
  }

  async searchIssues(
    opts: SearchIssuesOptions,
    ctx: RequestContext
  ): Promise<PagedResult<IssueSummary>> {
    const params = new URLSearchParams();
    params.set('q', opts.query);
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.order) params.set('order', opts.order);
    setPaging(params, opts);

    const data = await this.get<{ total_count: number; items: GhIssue[] }>(
      `/search/issues?${params}`,
      ctx
    );
    return {
      items: data.items.map(toIssueSummary),
      page: opts.page ?? 1,
      perPage: opts.perPage ?? 30,
      hasMore: (opts.page ?? 1) * (opts.perPage ?? 30) < data.total_count,
      totalCount: data.total_count
    };
  }

  async listPullRequests(
    owner: string,
    repo: string,
    opts: ListPullsOptions,
    ctx: RequestContext
  ): Promise<PagedResult<PullRequestSummary>> {
    const params = new URLSearchParams();
    if (opts.state) params.set('state', opts.state);
    if (opts.base) params.set('base', opts.base);
    if (opts.head) params.set('head', opts.head);
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.direction) params.set('direction', opts.direction);
    setPaging(params, opts);

    const pulls = await this.get<GhPull[]>(
      `/repos/${enc(owner)}/${enc(repo)}/pulls?${params}`,
      ctx
    );
    return toPage(pulls.map(toPullSummary), opts);
  }

  async getUser(login: string | undefined, ctx: RequestContext): Promise<UserProfile> {
    const path = login ? `/users/${enc(login)}` : '/user';
    const data = await this.get<GhUser>(path, ctx);
    return toUserProfile(data);
  }

  // ---------------------------------------------------------------------------

  private async get<T>(path: string, ctx: RequestContext): Promise<T> {
    const token = await this.auth.getTokenFor(ctx.userId);
    const url = `${this.config.apiBaseUrl}${path}`;

    return withRetry(async () => {
      log.debug('github request', { method: 'GET', url, user_id: ctx.userId });
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': this.config.userAgent,
          'x-github-api-version': '2022-11-28'
        }
      });

      logRateLimit(resp.headers);

      if (resp.status === 404) {
        throw new NotFoundError(`GitHub resource not found: ${path}`);
      }

      if (resp.status === 429 || (resp.status === 403 && isRateLimitResponse(resp.headers))) {
        const retryAfter = resolveRetryAfter(resp.headers);
        throw new RateLimitError(retryAfter, `GitHub rate limit reached on ${path}`);
      }

      if (!resp.ok) {
        const body = await safeText(resp);
        throw new UpstreamError(resp.status, `GitHub ${resp.status} for ${path}`, body);
      }

      return (await resp.json()) as T;
    });
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers — kept as plain functions so the StackOne adapter can reuse
// the shape definitions even if the upstream payloads differ.

function toRepoSummary(r: GhRepo): RepoSummary {
  return {
    id: r.id,
    fullName: r.full_name,
    name: r.name,
    owner: r.owner.login,
    description: r.description,
    visibility: r.visibility ?? (r.private ? 'private' : 'public'),
    defaultBranch: r.default_branch,
    stars: r.stargazers_count,
    forks: r.forks_count,
    openIssues: r.open_issues_count,
    language: r.language,
    url: r.html_url,
    updatedAt: r.updated_at
  };
}

function toRepoDetail(r: GhRepo): RepoDetail {
  return {
    ...toRepoSummary(r),
    topics: r.topics ?? [],
    archived: r.archived ?? false,
    disabled: r.disabled ?? false,
    size: r.size ?? 0,
    pushedAt: r.pushed_at ?? null,
    createdAt: r.created_at ?? null,
    homepage: r.homepage ?? null
  };
}

function toIssueSummary(i: GhIssue): IssueSummary {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    state: i.state,
    author: i.user?.login ?? null,
    assignees: (i.assignees ?? []).map(a => a.login),
    labels: (i.labels ?? []).map(l => (typeof l === 'string' ? l : l.name)),
    comments: i.comments,
    url: i.html_url,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    closedAt: i.closed_at,
    body: i.body,
    isPullRequest: Boolean(i.pull_request)
  };
}

function toPullSummary(p: GhPull): PullRequestSummary {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    state: p.merged_at ? 'merged' : p.state,
    author: p.user?.login ?? null,
    baseBranch: p.base.ref,
    headBranch: p.head.ref,
    draft: p.draft,
    merged: Boolean(p.merged_at),
    url: p.html_url,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    mergedAt: p.merged_at,
    body: p.body
  };
}

function toUserProfile(u: GhUser): UserProfile {
  return {
    id: u.id,
    login: u.login,
    name: u.name,
    email: u.email,
    bio: u.bio,
    company: u.company,
    location: u.location,
    publicRepos: u.public_repos,
    followers: u.followers,
    following: u.following,
    url: u.html_url,
    createdAt: u.created_at
  };
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function setPaging(params: URLSearchParams, opts: { page?: number; perPage?: number }): void {
  if (opts.page) params.set('page', String(opts.page));
  if (opts.perPage) params.set('per_page', String(Math.min(opts.perPage, 100)));
}

function toPage<T>(items: T[], opts: { page?: number; perPage?: number }): PagedResult<T> {
  const perPage = opts.perPage ?? 30;
  return {
    items,
    page: opts.page ?? 1,
    perPage,
    hasMore: items.length >= perPage
  };
}

function isRateLimitResponse(headers: Headers): boolean {
  const remaining = headers.get('x-ratelimit-remaining');
  return remaining === '0';
}

function resolveRetryAfter(headers: Headers): number {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const parsed = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const resetEpoch = Number.parseInt(reset, 10);
    if (Number.isFinite(resetEpoch)) {
      return Math.max(0, resetEpoch - Math.floor(Date.now() / 1000));
    }
  }
  return 30;
}

function logRateLimit(headers: Headers): void {
  const remaining = headers.get('x-ratelimit-remaining');
  const limit = headers.get('x-ratelimit-limit');
  if (remaining && limit) {
    log.debug('github rate limit', { remaining, limit });
  }
}

async function safeText(resp: Response): Promise<string | undefined> {
  try {
    return await resp.text();
  } catch {
    return undefined;
  }
}
