/**
 * Unit tests for the adapter layer.
 *
 * Replaces globalThis.fetch with a per-test stub so we can assert on the
 * exact URLs + headers the adapter builds without touching the network.
 * The stub also lets us simulate 404 / 429 / 5xx upstream responses and
 * verify the StackOne adapter falls back to GitHub-direct on 404.
 */

import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { GitHubAuth } from '../src/auth/github';
import { createTokenStore } from '../src/auth/tokenStore';
import { GitHubDirectAdapter } from '../src/adapters/githubDirect';
import { StackOneAdapter } from '../src/adapters/stackone';
import { NotFoundError } from '../src/lib/errors';
import { makeConfig } from './helpers';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function makeFetchStub(responses: Array<Partial<Response> | (() => Partial<Response>)>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const stub: typeof fetch = async (url, init) => {
    calls.push({ url: typeof url === 'string' ? url : (url as URL).toString(), init });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const resolved = typeof next === 'function' ? next() : next;
    return makeResponse(resolved);
  };
  return { stub, calls };
}

function makeResponse(parts: Partial<Response>): Response {
  const status = parts.status ?? 200;
  const headers = (parts.headers as Headers) ?? new Headers();
  const body = (parts as any).body ?? JSON.stringify({});
  return new Response(body, { status, headers });
}

describe('GitHubDirectAdapter URL construction', () => {
  const originalFetch = globalThis.fetch;
  let calls: FetchCall[];

  beforeEach(() => {
    const { stub, calls: c } = makeFetchStub([{ status: 200, body: '[]' as any }]);
    globalThis.fetch = stub;
    calls = c;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function adapter() {
    const config = makeConfig({ github: { defaultToken: 'ghp_pat' } });
    const auth = new GitHubAuth(config.github, createTokenStore());
    return new GitHubDirectAdapter(config.github, auth);
  }

  it('listRepositories with an owner hits /users/{owner}/repos', async () => {
    await adapter().listRepositories({ owner: 'octocat', perPage: 25 }, {});
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/users\/octocat\/repos\?/);
    assert.match(calls[0].url, /per_page=25/);
  });

  it('listRepositories without an owner hits /user/repos', async () => {
    await adapter().listRepositories({}, {});
    assert.match(calls[0].url, /\/user\/repos/);
  });

  it('sends Bearer token + GitHub API headers', async () => {
    await adapter().getUser('octocat', {});
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer ghp_pat');
    assert.equal(headers['x-github-api-version'], '2022-11-28');
    assert.match(headers['accept'], /application\/vnd\.github\+json/);
  });
});

describe('GitHubDirectAdapter error handling', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function adapter() {
    const config = makeConfig({ github: { defaultToken: 'ghp_pat' } });
    const auth = new GitHubAuth(config.github, createTokenStore());
    return new GitHubDirectAdapter(config.github, auth);
  }

  it('throws NotFoundError on 404', async () => {
    const { stub } = makeFetchStub([{ status: 404, body: 'not found' as any }]);
    globalThis.fetch = stub;
    await assert.rejects(() => adapter().getRepository('a', 'b', {}), NotFoundError);
  });
});

describe('StackOneAdapter fallback', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeStackOneAdapter() {
    const config = makeConfig({
      github: { defaultToken: 'ghp_pat' },
      stackone: { apiKey: 'stk_test', accountId: 'acct_42' }
    });
    const auth = new GitHubAuth(config.github, createTokenStore());
    const direct = new GitHubDirectAdapter(config.github, auth);
    return new StackOneAdapter(config.stackone, direct);
  }

  it('uses HTTP Basic auth header derived from the StackOne api key', async () => {
    const { stub, calls } = makeFetchStub([
      { status: 200, body: JSON.stringify({ data: [] }) as any }
    ]);
    globalThis.fetch = stub;

    await makeStackOneAdapter().listRepositories({}, {});

    const stackOneCall = calls.find(c => c.url.includes('api.stackone.com'));
    assert.ok(stackOneCall, 'must hit api.stackone.com');
    const headers = stackOneCall.init?.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from('stk_test:').toString('base64')}`;
    assert.equal(headers['authorization'], expected);
    assert.equal(headers['x-account-id'], 'acct_42');
  });

  it('falls back to GitHub-direct when StackOne returns 404', async () => {
    const { stub, calls } = makeFetchStub([
      { status: 404, body: 'not found in stackone' as any },
      // The fallback call to api.github.com must succeed.
      {
        status: 200,
        body: JSON.stringify({
          id: 1,
          full_name: 'a/b',
          name: 'b',
          owner: { login: 'a' },
          description: null,
          default_branch: 'main',
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          language: null,
          html_url: 'https://github.com/a/b',
          updated_at: null
        }) as any
      }
    ]);
    globalThis.fetch = stub;

    const result = await makeStackOneAdapter().getRepository('a', 'b', {});
    assert.equal(result.fullName, 'a/b');
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /api\.stackone\.com/);
    assert.match(calls[1].url, /api\.github\.com/);
  });
});
