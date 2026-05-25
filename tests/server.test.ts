/**
 * Integration tests for the HTTP surface. Each test boots a fresh server on a
 * random port so they're independent and parallel-safe.
 *
 * Coverage:
 *   - /healthz reports correct adapter + auth flags
 *   - /sse advertises every registered tool
 *   - error envelopes for auth, validation, and unknown-tool failures
 *   - OAuth start endpoint behaviour with and without OAuth env vars
 */

import * as assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { bootApp, jsonFetch, makeConfig, type BootedApp } from './helpers';

describe('GET /healthz', () => {
  let app: BootedApp;
  before(async () => {
    app = await bootApp({
      config: makeConfig({ github: { defaultToken: 'ghp_test' } })
    });
  });
  after(() => app.close());

  it('reports adapter selection and auth flags', async () => {
    const { status, body } = await jsonFetch(`${app.url}/healthz`);
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.adapter, 'github-direct');
    assert.equal(body.oauth_configured, false);
    assert.equal(body.pat_configured, true);
  });
});

describe('GET /sse', () => {
  let app: BootedApp;
  before(async () => {
    app = await bootApp();
  });
  after(() => app.close());

  it('advertises 10 tools (4 base + 6 GitHub) as a single tools event', async () => {
    const resp = await fetch(`${app.url}/sse`);
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') ?? '', /text\/event-stream/);

    const text = await resp.text();
    assert.ok(text.startsWith('event: tools\n'), 'SSE must begin with tools event');

    const dataLine = text.split('\n').find(l => l.startsWith('data: '));
    assert.ok(dataLine, 'must have a data line');
    const payload = JSON.parse(dataLine.slice(6));
    const names = payload.params.tools.map((t: { name: string }) => t.name).sort();

    assert.deepEqual(names, [
      'echo',
      'github.get_repository',
      'github.get_user',
      'github.list_issues',
      'github.list_pull_requests',
      'github.list_repositories',
      'github.search_issues',
      'greet',
      'perplexity.search',
      'perplexity.search.stream'
    ]);
  });
});

describe('POST /invoke error envelopes', () => {
  let app: BootedApp;
  before(async () => {
    app = await bootApp();
  });
  after(() => app.close());

  it('returns 401 auth_error when no token is configured', async () => {
    const { status, body } = await jsonFetch(`${app.url}/invoke/github.get_user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'auth_error');
    assert.match(body.error.message, /GITHUB_TOKEN|user_id/i);
  });

  it('returns 400 validation_error for unknown tool', async () => {
    const { status, body } = await jsonFetch(`${app.url}/invoke/github.no_such_tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'validation_error');
    assert.match(body.error.message, /tool not found/);
  });

  it('returns 400 validation_error when required input is missing', async () => {
    const { status, body } = await jsonFetch(`${app.url}/invoke/github.get_repository`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'validation_error');
    assert.match(body.error.message, /owner/);
  });

  it('returns x-request-id header on every response', async () => {
    const { headers } = await jsonFetch(`${app.url}/healthz`);
    assert.ok(headers.get('x-request-id'), 'response must include x-request-id');
  });
});

describe('GET /auth/github/start', () => {
  it('returns 500 config_error when OAuth env vars are unset', async () => {
    const app = await bootApp();
    try {
      const { status, body } = await jsonFetch(
        `${app.url}/auth/github/start?user_id=alice`
      );
      assert.equal(status, 500);
      assert.equal(body.error.code, 'config_error');
      assert.match(body.error.message, /OAuth is not configured/);
    } finally {
      await app.close();
    }
  });

  it('302-redirects to GitHub authorize when OAuth is configured', async () => {
    const app = await bootApp({
      config: makeConfig({
        github: {
          clientId: 'client_xyz',
          clientSecret: 'secret_abc',
          redirectUri: 'http://example.com/cb'
        }
      })
    });
    try {
      const resp = await fetch(`${app.url}/auth/github/start?user_id=alice`, {
        redirect: 'manual'
      });
      assert.equal(resp.status, 302);
      const location = resp.headers.get('location') ?? '';
      assert.match(location, /^https:\/\/github\.com\/login\/oauth\/authorize/);
      assert.match(location, /client_id=client_xyz/);
      assert.match(location, /redirect_uri=http%3A%2F%2Fexample\.com%2Fcb/);
      assert.match(location, /state=[a-f0-9]{48}/);
    } finally {
      await app.close();
    }
  });
});
