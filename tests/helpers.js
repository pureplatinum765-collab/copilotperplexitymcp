"use strict";
/**
 * Test helpers. Boots the Express app on a random free port with injected
 * config + auth + adapter, returns a `{ url, close }` handle. Each test owns
 * its own server instance, so tests are independent and parallel-safe.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeConfig = makeConfig;
exports.bootApp = bootApp;
exports.jsonFetch = jsonFetch;
const github_1 = require("../src/auth/github");
const tokenStore_1 = require("../src/auth/tokenStore");
const githubDirect_1 = require("../src/adapters/githubDirect");
const logger_1 = require("../src/lib/logger");
const server_1 = require("../src/server");
// Suppress info-level request logs so test output stays readable. Errors
// still surface, so genuine regressions remain visible.
(0, logger_1.setLogLevel)('error');
function makeConfig(overrides = {}) {
    return {
        port: overrides.port ?? 0,
        logLevel: overrides.logLevel ?? 'error',
        perplexity: {
            apiKey: undefined,
            defaultModel: 'sonar',
            ...overrides.perplexity
        },
        github: {
            defaultToken: undefined,
            clientId: undefined,
            clientSecret: undefined,
            redirectUri: undefined,
            apiBaseUrl: 'https://api.github.com',
            oauthBaseUrl: 'https://github.com',
            userAgent: 'mcp-test/1.0',
            tokenStorePath: undefined,
            ...overrides.github
        },
        stackone: {
            apiKey: undefined,
            accountId: undefined,
            baseUrl: 'https://api.stackone.com',
            githubProvider: 'github',
            ...overrides.stackone
        }
    };
}
async function bootApp(opts = {}) {
    const config = opts.config ?? makeConfig();
    const tokenStore = opts.tokenStore ?? (0, tokenStore_1.createTokenStore)(config.github.tokenStorePath);
    const auth = new github_1.GitHubAuth(config.github, tokenStore);
    const adapter = opts.adapter ?? new githubDirect_1.GitHubDirectAdapter(config.github, auth);
    const app = (0, server_1.buildApp)({ config, auth, adapter });
    return new Promise(resolve => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            resolve({
                url: `http://127.0.0.1:${port}`,
                auth,
                adapter,
                tokenStore,
                close: () => new Promise(r => {
                    server.close(() => r());
                })
            });
        });
    });
}
/** Wraps `fetch` to also return parsed JSON when the response has that content-type. */
async function jsonFetch(url, init) {
    const resp = await fetch(url, init);
    const text = await resp.text();
    let body = text;
    if (resp.headers.get('content-type')?.includes('application/json')) {
        try {
            body = JSON.parse(text);
        }
        catch {
            // leave as text
        }
    }
    return { status: resp.status, body, headers: resp.headers };
}
