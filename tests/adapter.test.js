"use strict";
/**
 * Unit tests for the adapter layer.
 *
 * Replaces globalThis.fetch with a per-test stub so we can assert on the
 * exact URLs + headers the adapter builds without touching the network.
 * The stub also lets us simulate 404 / 429 / 5xx upstream responses and
 * verify the StackOne adapter falls back to GitHub-direct on 404.
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
const node_test_1 = require("node:test");
const github_1 = require("../src/auth/github");
const tokenStore_1 = require("../src/auth/tokenStore");
const githubDirect_1 = require("../src/adapters/githubDirect");
const stackone_1 = require("../src/adapters/stackone");
const errors_1 = require("../src/lib/errors");
const helpers_1 = require("./helpers");
function makeFetchStub(responses) {
    const calls = [];
    let i = 0;
    const stub = async (url, init) => {
        calls.push({ url: typeof url === 'string' ? url : url.toString(), init });
        const next = responses[Math.min(i, responses.length - 1)];
        i += 1;
        const resolved = typeof next === 'function' ? next() : next;
        return makeResponse(resolved);
    };
    return { stub, calls };
}
function makeResponse(parts) {
    const status = parts.status ?? 200;
    const headers = parts.headers ?? new Headers();
    const body = parts.body ?? JSON.stringify({});
    return new Response(body, { status, headers });
}
(0, node_test_1.describe)('GitHubDirectAdapter URL construction', () => {
    const originalFetch = globalThis.fetch;
    let calls;
    (0, node_test_1.beforeEach)(() => {
        const { stub, calls: c } = makeFetchStub([{ status: 200, body: '[]' }]);
        globalThis.fetch = stub;
        calls = c;
    });
    (0, node_test_1.afterEach)(() => {
        globalThis.fetch = originalFetch;
    });
    function adapter() {
        const config = (0, helpers_1.makeConfig)({ github: { defaultToken: 'ghp_pat' } });
        const auth = new github_1.GitHubAuth(config.github, (0, tokenStore_1.createTokenStore)());
        return new githubDirect_1.GitHubDirectAdapter(config.github, auth);
    }
    (0, node_test_1.it)('listRepositories with an owner hits /users/{owner}/repos', async () => {
        await adapter().listRepositories({ owner: 'octocat', perPage: 25 }, {});
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /\/users\/octocat\/repos\?/);
        assert.match(calls[0].url, /per_page=25/);
    });
    (0, node_test_1.it)('listRepositories without an owner hits /user/repos', async () => {
        await adapter().listRepositories({}, {});
        assert.match(calls[0].url, /\/user\/repos/);
    });
    (0, node_test_1.it)('sends Bearer token + GitHub API headers', async () => {
        await adapter().getUser('octocat', {});
        const headers = calls[0].init?.headers;
        assert.equal(headers['authorization'], 'Bearer ghp_pat');
        assert.equal(headers['x-github-api-version'], '2022-11-28');
        assert.match(headers['accept'], /application\/vnd\.github\+json/);
    });
});
(0, node_test_1.describe)('GitHubDirectAdapter error handling', () => {
    const originalFetch = globalThis.fetch;
    (0, node_test_1.afterEach)(() => {
        globalThis.fetch = originalFetch;
    });
    function adapter() {
        const config = (0, helpers_1.makeConfig)({ github: { defaultToken: 'ghp_pat' } });
        const auth = new github_1.GitHubAuth(config.github, (0, tokenStore_1.createTokenStore)());
        return new githubDirect_1.GitHubDirectAdapter(config.github, auth);
    }
    (0, node_test_1.it)('throws NotFoundError on 404', async () => {
        const { stub } = makeFetchStub([{ status: 404, body: 'not found' }]);
        globalThis.fetch = stub;
        await assert.rejects(() => adapter().getRepository('a', 'b', {}), errors_1.NotFoundError);
    });
});
(0, node_test_1.describe)('StackOneAdapter fallback', () => {
    const originalFetch = globalThis.fetch;
    (0, node_test_1.afterEach)(() => {
        globalThis.fetch = originalFetch;
    });
    function makeStackOneAdapter() {
        const config = (0, helpers_1.makeConfig)({
            github: { defaultToken: 'ghp_pat' },
            stackone: { apiKey: 'stk_test', accountId: 'acct_42' }
        });
        const auth = new github_1.GitHubAuth(config.github, (0, tokenStore_1.createTokenStore)());
        const direct = new githubDirect_1.GitHubDirectAdapter(config.github, auth);
        return new stackone_1.StackOneAdapter(config.stackone, direct);
    }
    (0, node_test_1.it)('uses HTTP Basic auth header derived from the StackOne api key', async () => {
        const { stub, calls } = makeFetchStub([
            { status: 200, body: JSON.stringify({ data: [] }) }
        ]);
        globalThis.fetch = stub;
        await makeStackOneAdapter().listRepositories({}, {});
        const stackOneCall = calls.find(c => c.url.includes('api.stackone.com'));
        assert.ok(stackOneCall, 'must hit api.stackone.com');
        const headers = stackOneCall.init?.headers;
        const expected = `Basic ${Buffer.from('stk_test:').toString('base64')}`;
        assert.equal(headers['authorization'], expected);
        assert.equal(headers['x-account-id'], 'acct_42');
    });
    (0, node_test_1.it)('falls back to GitHub-direct when StackOne returns 404', async () => {
        const { stub, calls } = makeFetchStub([
            { status: 404, body: 'not found in stackone' },
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
                })
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
