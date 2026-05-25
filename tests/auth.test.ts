/**
 * Unit tests for the GitHub auth layer + token store.
 *
 * Covers the three behaviours that, if they regress, would silently break
 * production: PAT fallback resolution, OAuth state validation, and
 * file-backed token persistence.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { GitHubAuth } from '../src/auth/github';
import { createTokenStore } from '../src/auth/tokenStore';
import { AuthError, ConfigError } from '../src/lib/errors';
import { makeConfig } from './helpers';

describe('GitHubAuth.getTokenFor', () => {
  it('returns the PAT when no user_id and GITHUB_TOKEN is set', async () => {
    const config = makeConfig({ github: { defaultToken: 'ghp_pat' } });
    const auth = new GitHubAuth(config.github, createTokenStore());
    assert.equal(await auth.getTokenFor(undefined), 'ghp_pat');
  });

  it('returns the per-user OAuth token when present', async () => {
    const config = makeConfig({ github: { defaultToken: 'ghp_pat' } });
    const store = createTokenStore();
    await store.set('alice', { accessToken: 'oauth_alice', obtainedAt: 0 });
    const auth = new GitHubAuth(config.github, store);
    assert.equal(await auth.getTokenFor('alice'), 'oauth_alice');
  });

  it('falls back to the PAT when the named user has no stored token', async () => {
    const config = makeConfig({ github: { defaultToken: 'ghp_pat' } });
    const auth = new GitHubAuth(config.github, createTokenStore());
    assert.equal(await auth.getTokenFor('someone_else'), 'ghp_pat');
  });

  it('throws AuthError when neither user token nor PAT is available', async () => {
    const config = makeConfig();
    const auth = new GitHubAuth(config.github, createTokenStore());
    await assert.rejects(() => auth.getTokenFor(undefined), AuthError);
    await assert.rejects(() => auth.getTokenFor('alice'), AuthError);
  });
});

describe('GitHubAuth OAuth state machine', () => {
  function configuredAuth() {
    const config = makeConfig({
      github: {
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'http://example.com/cb'
      }
    });
    return new GitHubAuth(config.github, createTokenStore());
  }

  it('beginOAuth throws ConfigError when OAuth is not configured', () => {
    const auth = new GitHubAuth(makeConfig().github, createTokenStore());
    assert.throws(() => auth.beginOAuth('alice'), ConfigError);
  });

  it('beginOAuth returns a URL with a fresh state each call', () => {
    const auth = configuredAuth();
    const url1 = new URL(auth.beginOAuth('alice'));
    const url2 = new URL(auth.beginOAuth('alice'));
    assert.notEqual(url1.searchParams.get('state'), url2.searchParams.get('state'));
    assert.equal(url1.searchParams.get('client_id'), 'cid');
    assert.equal(url1.searchParams.get('redirect_uri'), 'http://example.com/cb');
  });

  it('completeOAuth rejects an unknown state without calling GitHub', async () => {
    const auth = configuredAuth();
    await assert.rejects(() => auth.completeOAuth('code_xyz', 'state_never_issued'), AuthError);
  });
});

describe('File-backed token store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tokens-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists tokens across instances at the configured path', async () => {
    const storePath = path.join(tmpDir, 'tokens.json');

    const store1 = createTokenStore(storePath);
    await store1.set('alice', { accessToken: 'oauth_a', obtainedAt: 0 });
    await store1.set('bob', { accessToken: 'oauth_b', obtainedAt: 0 });

    assert.ok(fs.existsSync(storePath), 'token file must exist on disk');

    const store2 = createTokenStore(storePath);
    assert.equal((await store2.get('alice'))?.accessToken, 'oauth_a');
    assert.equal((await store2.get('bob'))?.accessToken, 'oauth_b');
  });

  it('removes the entry on delete and reflects the change on disk', async () => {
    const storePath = path.join(tmpDir, 'tokens.json');

    const store = createTokenStore(storePath);
    await store.set('alice', { accessToken: 'oauth_a', obtainedAt: 0 });
    await store.delete('alice');

    const reloaded = createTokenStore(storePath);
    assert.equal(await reloaded.get('alice'), undefined);
  });
});
