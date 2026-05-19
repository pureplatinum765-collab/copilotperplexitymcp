/**
 * Common interface every GitHub data source must satisfy.
 *
 * Two implementations live alongside this file:
 *   - `githubDirect.ts` — talks to api.github.com directly (default).
 *   - `stackone.ts`     — talks to api.stackone.com when STACKONE_API_KEY is set.
 *
 * Both return the same normalized DTOs so that MCP tools above don't care
 * which backend served the request.
 */

export interface RequestContext {
  userId?: string;
  requestId?: string;
}

export interface PaginationOptions {
  page?: number;
  perPage?: number;
}

export interface RepoSummary {
  id: number | string;
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  visibility: string | null;
  defaultBranch: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  language: string | null;
  url: string;
  updatedAt: string | null;
}

export interface RepoDetail extends RepoSummary {
  topics: string[];
  archived: boolean;
  disabled: boolean;
  size: number;
  pushedAt: string | null;
  createdAt: string | null;
  homepage: string | null;
}

export interface IssueSummary {
  id: number | string;
  number: number;
  title: string;
  state: 'open' | 'closed' | string;
  author: string | null;
  assignees: string[];
  labels: string[];
  comments: number;
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  body: string | null;
  // Set only when listing a repo's combined issues+PRs from GitHub's REST API.
  isPullRequest: boolean;
}

export interface PullRequestSummary {
  id: number | string;
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged' | string;
  author: string | null;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
  merged: boolean;
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
  mergedAt: string | null;
  body: string | null;
}

export interface UserProfile {
  id: number | string;
  login: string;
  name: string | null;
  email: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  publicRepos: number;
  followers: number;
  following: number;
  url: string;
  createdAt: string | null;
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  perPage: number;
  hasMore: boolean;
  totalCount?: number;
}

export interface SearchIssuesOptions extends PaginationOptions {
  query: string;
  sort?: 'comments' | 'created' | 'updated';
  order?: 'asc' | 'desc';
}

export interface ListReposOptions extends PaginationOptions {
  owner?: string;
  type?: 'all' | 'owner' | 'public' | 'private' | 'member';
  sort?: 'created' | 'updated' | 'pushed' | 'full_name';
  direction?: 'asc' | 'desc';
}

export interface ListIssuesOptions extends PaginationOptions {
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  assignee?: string;
  creator?: string;
  sort?: 'created' | 'updated' | 'comments';
  direction?: 'asc' | 'desc';
}

export interface ListPullsOptions extends PaginationOptions {
  state?: 'open' | 'closed' | 'all';
  base?: string;
  head?: string;
  sort?: 'created' | 'updated' | 'popularity' | 'long-running';
  direction?: 'asc' | 'desc';
}

export interface GitHubAdapter {
  readonly name: 'github-direct' | 'stackone';

  listRepositories(opts: ListReposOptions, ctx: RequestContext): Promise<PagedResult<RepoSummary>>;
  getRepository(owner: string, repo: string, ctx: RequestContext): Promise<RepoDetail>;
  listIssues(
    owner: string,
    repo: string,
    opts: ListIssuesOptions,
    ctx: RequestContext
  ): Promise<PagedResult<IssueSummary>>;
  searchIssues(opts: SearchIssuesOptions, ctx: RequestContext): Promise<PagedResult<IssueSummary>>;
  listPullRequests(
    owner: string,
    repo: string,
    opts: ListPullsOptions,
    ctx: RequestContext
  ): Promise<PagedResult<PullRequestSummary>>;
  getUser(login: string | undefined, ctx: RequestContext): Promise<UserProfile>;
}
