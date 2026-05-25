"use strict";
/**
 * Unit tests for the GitHub auth layer + token store.
 *
 * Covers the three behaviours that, if they regress, would silently break
 * production: PAT fallback resolution, OAuth state validation, and
 * file-backed token persistence.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("node:assert/strict"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_test_1 = require("node:test");
const github_1 = require("../src/auth/github");
const tokenStore_1 = require("../src/auth/tokenStore");
const errors_1 = require("../src/lib/errors");
const helpers_1 = require("./helpers");
(0, node_test_1.describe)('GitHubAuth.getTokenFor', () => {
    (0, node_test_1.it)('returns the PAT when no user_id and GITHUB_TOKEN is set', async () => {
        const config = (0, helpers_1.makeConfig)({ github: { defaultToken: 'ghp_pat' } });
        const auth = new github_1.GitHubAuth(config.github, (0, tokenStore_1.createTokenStore)());
        assert.equal(await auth.getTokenFor(undefined), 'ghp_pat');
    });
    (0, node_test_1.it)('returns the per-user OAuth token when present', async () => {
        const config = (0, helpers_1.makeConfig)({ github: { defaultToken: 'ghp_pat' } });
        const store = (0, tokenStore_1.createTokenStore)();
        await store.set('alice', { accessToken: 'oauth_alice', obtainedAt: 0 });
        const auth = new github_1.GitHubAuth(config.github, store);
        assert.equal(await auth.getTokenFor('alice'), 'oauth_alice');
    });
    (0, node_test_1.it)('falls back to the PAT when the named user has no stored token', async () => {
        const config = (0, helpers_1.makeConfig)({ github: { defaultToken: 'ghp_pat' } });
        const auth = new github_1.GitHubAuth(config.github, (0, tokenStore_1.createTokenStore)());
        assert.equal(await auth.getTokenFor('someone_else'), 'ghp_pat');
    });
    (0, node_test_1.it)('throws AuthError when neither user token nor PAT is available', async () => {
        const config = (0, helpers_1.makeConfig)();
        const auth = new github_1.GitHubAuth(config.github, (0, tokenStore_1.createTokenStore)());
        await assert.rejects(() => auth.getTokenFor(undefined), errors_1.AuthError);
        await assert.rejects(() => auth.getTokenFor('alice'), errors_1.AuthError);
    });
});
(0, node_test_1.describe)('GitHubAuth OAuth state machine', () => {
    function configuredAuth() {
        const config = (0, helpers_1.makeConfig)({
            github: {
                clientId: 'cid',
                clientSecret: 'csec',
                redirectUri: 'http://example.com/cb'
            }
        });
        return new github_1.GitHubAuth(config.github, (0, tokenStore_1.createTokenStore)());
    }
    (0, node_test_1.it)('beginOAuth throws ConfigError when OAuth is not configured', () => {
        const auth = new github_1.GitHubAuth((0, helpers_1.makeConfig)().github, (0, tokenStore_1.createTokenStore)());
        assert.throws(() => auth.beginOAuth('alice'), errors_1.ConfigError);
    });
    (0, node_test_1.it)('beginOAuth returns a URL with a fresh state each call', () => {
        const auth = configuredAuth();
        const url1 = new URL(auth.beginOAuth('alice'));
        const url2 = new URL(auth.beginOAuth('alice'));
        assert.notEqual(url1.searchParams.get('state'), url2.searchParams.get('state'));
        assert.equal(url1.searchParams.get('client_id'), 'cid');
        assert.equal(url1.searchParams.get('redirect_uri'), 'http://example.com/cb');
    });
    (0, node_test_1.it)('completeOAuth rejects an unknown state without calling GitHub', async () => {
        const auth = configuredAuth();
        await assert.rejects(() => auth.completeOAuth('code_xyz', 'state_never_issued'), errors_1.AuthError);
    });
});
(0, node_test_1.describe)('File-backed token store', () => {
    let tmpDir;
    (0, node_test_1.beforeEach)(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tokens-'));
    });
    (0, node_test_1.afterEach)(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    (0, node_test_1.it)('persists tokens across instances at the configured path', async () => {
        const storePath = path.join(tmpDir, 'tokens.json');
        const store1 = (0, tokenStore_1.createTokenStore)(storePath);
        await store1.set('alice', { accessToken: 'oauth_a', obtainedAt: 0 });
        await store1.set('bob', { accessToken: 'oauth_b', obtainedAt: 0 });
        assert.ok(fs.existsSync(storePath), 'token file must exist on disk');
        const store2 = (0, tokenStore_1.createTokenStore)(storePath);
        assert.equal((await store2.get('alice'))?.accessToken, 'oauth_a');
        assert.equal((await store2.get('bob'))?.accessToken, 'oauth_b');
    });
    (0, node_test_1.it)('removes the entry on delete and reflects the change on disk', async () => {
        const storePath = path.join(tmpDir, 'tokens.json');
        const store = (0, tokenStore_1.createTokenStore)(storePath);
        await store.set('alice', { accessToken: 'oauth_a', obtainedAt: 0 });
        await store.delete('alice');
        const reloaded = (0, tokenStore_1.createTokenStore)(storePath);
        assert.equal(await reloaded.get('alice'), undefined);
    });
});
