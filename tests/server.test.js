"use strict";
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
const helpers_1 = require("./helpers");
(0, node_test_1.describe)('GET /healthz', () => {
    let app;
    (0, node_test_1.before)(async () => {
        app = await (0, helpers_1.bootApp)({
            config: (0, helpers_1.makeConfig)({ github: { defaultToken: 'ghp_test' } })
        });
    });
    (0, node_test_1.after)(() => app.close());
    (0, node_test_1.it)('reports adapter selection and auth flags', async () => {
        const { status, body } = await (0, helpers_1.jsonFetch)(`${app.url}/healthz`);
        assert.equal(status, 200);
        assert.equal(body.status, 'ok');
        assert.equal(body.adapter, 'github-direct');
        assert.equal(body.oauth_configured, false);
        assert.equal(body.pat_configured, true);
    });
});
(0, node_test_1.describe)('GET /sse', () => {
    let app;
    (0, node_test_1.before)(async () => {
        app = await (0, helpers_1.bootApp)();
    });
    (0, node_test_1.after)(() => app.close());
    (0, node_test_1.it)('advertises 10 tools (4 base + 6 GitHub) as a single tools event', async () => {
        const resp = await fetch(`${app.url}/sse`);
        assert.equal(resp.status, 200);
        assert.match(resp.headers.get('content-type') ?? '', /text\/event-stream/);
        const text = await resp.text();
        assert.ok(text.startsWith('event: tools\n'), 'SSE must begin with tools event');
        const dataLine = text.split('\n').find(l => l.startsWith('data: '));
        assert.ok(dataLine, 'must have a data line');
        const payload = JSON.parse(dataLine.slice(6));
        const names = payload.params.tools.map((t) => t.name).sort();
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
(0, node_test_1.describe)('POST /invoke error envelopes', () => {
    let app;
    (0, node_test_1.before)(async () => {
        app = await (0, helpers_1.bootApp)();
    });
    (0, node_test_1.after)(() => app.close());
    (0, node_test_1.it)('returns 401 auth_error when no token is configured', async () => {
        const { status, body } = await (0, helpers_1.jsonFetch)(`${app.url}/invoke/github.get_user`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        assert.equal(status, 401);
        assert.equal(body.error.code, 'auth_error');
        assert.match(body.error.message, /GITHUB_TOKEN|user_id/i);
    });
    (0, node_test_1.it)('returns 400 validation_error for unknown tool', async () => {
        const { status, body } = await (0, helpers_1.jsonFetch)(`${app.url}/invoke/github.no_such_tool`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        assert.equal(status, 400);
        assert.equal(body.error.code, 'validation_error');
        assert.match(body.error.message, /tool not found/);
    });
    (0, node_test_1.it)('returns 400 validation_error when required input is missing', async () => {
        const { status, body } = await (0, helpers_1.jsonFetch)(`${app.url}/invoke/github.get_repository`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        assert.equal(status, 400);
        assert.equal(body.error.code, 'validation_error');
        assert.match(body.error.message, /owner/);
    });
    (0, node_test_1.it)('returns x-request-id header on every response', async () => {
        const { headers } = await (0, helpers_1.jsonFetch)(`${app.url}/healthz`);
        assert.ok(headers.get('x-request-id'), 'response must include x-request-id');
    });
});
(0, node_test_1.describe)('GET /auth/github/start', () => {
    (0, node_test_1.it)('returns 500 config_error when OAuth env vars are unset', async () => {
        const app = await (0, helpers_1.bootApp)();
        try {
            const { status, body } = await (0, helpers_1.jsonFetch)(`${app.url}/auth/github/start?user_id=alice`);
            assert.equal(status, 500);
            assert.equal(body.error.code, 'config_error');
            assert.match(body.error.message, /OAuth is not configured/);
        }
        finally {
            await app.close();
        }
    });
    (0, node_test_1.it)('302-redirects to GitHub authorize when OAuth is configured', async () => {
        const app = await (0, helpers_1.bootApp)({
            config: (0, helpers_1.makeConfig)({
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
        }
        finally {
            await app.close();
        }
    });
});
