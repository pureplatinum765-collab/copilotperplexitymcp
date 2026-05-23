/**
 * Builds the full set of GitHub MCP tools from a single adapter instance.
 *
 * Each tool is a thin wrapper that:
 *   - validates required input,
 *   - calls one adapter method,
 *   - returns a JSON-safe object.
 *
 * The factory pattern (tools created with the adapter in scope) means the
 * server can swap adapters without touching tool definitions.
 */

import { ValidationError } from '../../lib/errors';
import type { McpTool } from '../../server';
import type { GitHubAdapter, RequestContext } from '../../adapters/types';

interface CommonInput {
  user_id?: string;
}

export function createGitHubTools(adapter: GitHubAdapter): McpTool[] {
  return [
    createListRepos(adapter),
    createGetRepo(adapter),
    createListIssues(adapter),
    createSearchIssues(adapter),
    createListPullRequests(adapter),
    createGetUser(adapter)
  ];
}

const userIdField = {
  type: 'string',
  description: 'Optional user ID whose OAuth token should be used. Falls back to GITHUB_TOKEN.'
};

function ctxFrom(input: CommonInput): RequestContext {
  return { userId: input.user_id };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`"${name}" is required and must be a non-empty string`);
  }
  return value;
}

// ---------------------------------------------------------------------------

function createListRepos(adapter: GitHubAdapter): McpTool {
  interface Input extends CommonInput {
    owner?: string;
    type?: 'all' | 'owner' | 'public' | 'private' | 'member';
    sort?: 'created' | 'updated' | 'pushed' | 'full_name';
    direction?: 'asc' | 'desc';
    page?: number;
    per_page?: number;
  }

  return {
    name: 'github.list_repositories',
    description:
      'List repositories for a user/org, or for the authenticated user if no owner is provided.',
    schema: {
      input: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'GitHub user or organization login. Omit for authenticated user.' },
          type: { type: 'string', enum: ['all', 'owner', 'public', 'private', 'member'] },
          sort: { type: 'string', enum: ['created', 'updated', 'pushed', 'full_name'] },
          direction: { type: 'string', enum: ['asc', 'desc'] },
          page: { type: 'integer', minimum: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 100 },
          user_id: userIdField
        }
      },
      output: {
        type: 'object',
        properties: {
          items: { type: 'array' },
          page: { type: 'integer' },
          per_page: { type: 'integer' },
          has_more: { type: 'boolean' }
        }
      }
    },
    async invoke(input: Input) {
      const page = await adapter.listRepositories(
        {
          owner: input.owner,
          type: input.type,
          sort: input.sort,
          direction: input.direction,
          page: input.page,
          perPage: input.per_page
        },
        ctxFrom(input)
      );
      return {
        items: page.items,
        page: page.page,
        per_page: page.perPage,
        has_more: page.hasMore
      };
    }
  };
}

function createGetRepo(adapter: GitHubAdapter): McpTool {
  interface Input extends CommonInput {
    owner: string;
    repo: string;
  }

  return {
    name: 'github.get_repository',
    description: 'Fetch detailed metadata for a single repository.',
    schema: {
      input: {
        type: 'object',
        required: ['owner', 'repo'],
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          user_id: userIdField
        }
      },
      output: { type: 'object' }
    },
    async invoke(input: Input) {
      return adapter.getRepository(
        requireString(input.owner, 'owner'),
        requireString(input.repo, 'repo'),
        ctxFrom(input)
      );
    }
  };
}

function createListIssues(adapter: GitHubAdapter): McpTool {
  interface Input extends CommonInput {
    owner: string;
    repo: string;
    state?: 'open' | 'closed' | 'all';
    labels?: string[];
    assignee?: string;
    creator?: string;
    sort?: 'created' | 'updated' | 'comments';
    direction?: 'asc' | 'desc';
    page?: number;
    per_page?: number;
  }

  return {
    name: 'github.list_issues',
    description: 'List issues in a repository. By default returns open issues only.',
    schema: {
      input: {
        type: 'object',
        required: ['owner', 'repo'],
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
          labels: { type: 'array', items: { type: 'string' } },
          assignee: { type: 'string' },
          creator: { type: 'string' },
          sort: { type: 'string', enum: ['created', 'updated', 'comments'] },
          direction: { type: 'string', enum: ['asc', 'desc'] },
          page: { type: 'integer', minimum: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 100 },
          user_id: userIdField
        }
      },
      output: { type: 'object' }
    },
    async invoke(input: Input) {
      const page = await adapter.listIssues(
        requireString(input.owner, 'owner'),
        requireString(input.repo, 'repo'),
        {
          state: input.state,
          labels: input.labels,
          assignee: input.assignee,
          creator: input.creator,
          sort: input.sort,
          direction: input.direction,
          page: input.page,
          perPage: input.per_page
        },
        ctxFrom(input)
      );
      return {
        items: page.items,
        page: page.page,
        per_page: page.perPage,
        has_more: page.hasMore
      };
    }
  };
}

function createSearchIssues(adapter: GitHubAdapter): McpTool {
  interface Input extends CommonInput {
    query: string;
    sort?: 'comments' | 'created' | 'updated';
    order?: 'asc' | 'desc';
    page?: number;
    per_page?: number;
  }

  return {
    name: 'github.search_issues',
    description:
      'Search issues and pull requests using GitHub\'s search syntax (e.g. "repo:owner/name is:open label:bug").',
    schema: {
      input: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'GitHub search query string.' },
          sort: { type: 'string', enum: ['comments', 'created', 'updated'] },
          order: { type: 'string', enum: ['asc', 'desc'] },
          page: { type: 'integer', minimum: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 100 },
          user_id: userIdField
        }
      },
      output: { type: 'object' }
    },
    async invoke(input: Input) {
      const page = await adapter.searchIssues(
        {
          query: requireString(input.query, 'query'),
          sort: input.sort,
          order: input.order,
          page: input.page,
          perPage: input.per_page
        },
        ctxFrom(input)
      );
      return {
        items: page.items,
        page: page.page,
        per_page: page.perPage,
        has_more: page.hasMore,
        total_count: page.totalCount
      };
    }
  };
}

function createListPullRequests(adapter: GitHubAdapter): McpTool {
  interface Input extends CommonInput {
    owner: string;
    repo: string;
    state?: 'open' | 'closed' | 'all';
    base?: string;
    head?: string;
    sort?: 'created' | 'updated' | 'popularity' | 'long-running';
    direction?: 'asc' | 'desc';
    page?: number;
    per_page?: number;
  }

  return {
    name: 'github.list_pull_requests',
    description: 'List pull requests in a repository.',
    schema: {
      input: {
        type: 'object',
        required: ['owner', 'repo'],
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
          base: { type: 'string' },
          head: { type: 'string' },
          sort: { type: 'string', enum: ['created', 'updated', 'popularity', 'long-running'] },
          direction: { type: 'string', enum: ['asc', 'desc'] },
          page: { type: 'integer', minimum: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 100 },
          user_id: userIdField
        }
      },
      output: { type: 'object' }
    },
    async invoke(input: Input) {
      const page = await adapter.listPullRequests(
        requireString(input.owner, 'owner'),
        requireString(input.repo, 'repo'),
        {
          state: input.state,
          base: input.base,
          head: input.head,
          sort: input.sort,
          direction: input.direction,
          page: input.page,
          perPage: input.per_page
        },
        ctxFrom(input)
      );
      return {
        items: page.items,
        page: page.page,
        per_page: page.perPage,
        has_more: page.hasMore
      };
    }
  };
}

function createGetUser(adapter: GitHubAdapter): McpTool {
  interface Input extends CommonInput {
    login?: string;
  }

  return {
    name: 'github.get_user',
    description: 'Fetch a user profile. Omit "login" to get the authenticated user.',
    schema: {
      input: {
        type: 'object',
        properties: {
          login: { type: 'string', description: 'GitHub username. Omit for authenticated user.' },
          user_id: userIdField
        }
      },
      output: { type: 'object' }
    },
    async invoke(input: Input) {
      return adapter.getUser(input.login, ctxFrom(input));
    }
  };
}
