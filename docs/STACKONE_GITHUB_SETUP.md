# StackOne ↔ GitHub ↔ Perplexity MCP Bridge — Setup

This guide covers the GitHub + StackOne pieces added on top of the existing
Perplexity MCP server. The pre-existing endpoints (`/sse`, `/query`,
`/invoke/perplexity.search`, etc.) keep working exactly as before — the new
modules slot in alongside them.

## Architecture at a glance

```
                  ┌────────────────────┐
Perplexity ──MCP─►│  Express MCP svr   │──HTTPS─► api.github.com   (default)
Copilot Studio    │  src/server.ts     │
                  │                    │──HTTPS─► api.stackone.com (when key set)
                  └────────────────────┘                │
                              │                         └──► GitHub on your behalf
                              ▼
                  ┌────────────────────┐
                  │ GitHub OAuth flow  │  /auth/github/start → callback
                  │ + PAT fallback     │  tokens in TokenStore (memory|file)
                  └────────────────────┘
```

Adapter selection is automatic:
- `STACKONE_API_KEY` present → `StackOneAdapter` (with GitHub-direct fallback
  for operations StackOne can't serve, e.g. issue search).
- Otherwise → `GitHubDirectAdapter`.

## 1. Configure GitHub authentication

Pick one (or both — the server prefers per-user OAuth and falls back to PAT).

### Option A: Personal Access Token (fastest)

1. Visit https://github.com/settings/personal-access-tokens/new
2. Create a fine-grained token. Recommended read-only scopes for this server:
   - Repository → Contents (read), Issues (read), Pull requests (read), Metadata
   - Account → Profile (read)
3. Copy the token into `GITHUB_TOKEN` in your `.env` / Azure App Settings.

The server uses this token for any request that doesn't carry a `user_id`.

### Option B: OAuth App / GitHub App (recommended for production)

1. Go to https://github.com/settings/developers → **New OAuth App**
   (or **New GitHub App** for refresh-token support).
2. Authorization callback URL:
   - Local dev: `http://localhost:8080/auth/github/callback`
   - Azure:     `https://<your-app>.azurewebsites.net/auth/github/callback`
3. Generate a client secret. Drop the values into:
   ```
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   GITHUB_REDIRECT_URI=https://<your-app>.azurewebsites.net/auth/github/callback
   ```
4. Kick off the flow:
   ```bash
   open "http://localhost:8080/auth/github/start?user_id=alice"
   ```
   GitHub will bounce the browser to your callback, the server exchanges the
   code and stores the token keyed by `user_id=alice`. From then on, MCP
   tool calls that include `"user_id":"alice"` use her token.

GitHub Apps return a refresh token; the server refreshes automatically when
the access token is within 60 seconds of expiry.

## 2. (Optional) Configure StackOne

Skip this section if you just want to talk to GitHub directly.

1. In your StackOne workspace, create or copy an API key.
2. Link the GitHub provider for an account; note the `x-account-id` value.
3. Set:
   ```
   STACKONE_API_KEY=...
   STACKONE_ACCOUNT_ID=...
   STACKONE_BASE_URL=https://api.stackone.com   # default
   STACKONE_GITHUB_PROVIDER=github              # default
   ```

The adapter calls StackOne using HTTP Basic auth (API key as username, empty
password). The unified GitHub paths it expects are:
- `GET /unified/dev-tools/repositories`
- `GET /unified/dev-tools/repositories/{owner}/{repo}`
- `GET /unified/dev-tools/issues?filter[repository]=owner/repo`
- `GET /unified/dev-tools/pull-requests?filter[repository]=owner/repo`
- `GET /unified/dev-tools/users/{login}` (or `/users/me`)

If your StackOne workspace uses different paths, override them in
`src/adapters/stackone.ts` — the rest of the server doesn't care, because
every method returns the same normalized DTO shape from `adapters/types.ts`.

Any operation StackOne returns a 404 for falls through to the GitHub-direct
adapter, so you keep full tool coverage even with partial StackOne support.

## 3. Run locally

```bash
cp .env.example .env
# fill in GITHUB_TOKEN at minimum

npm install
npm run dev          # ts-node-dev, hot reload
# or
npm run build && npm start
```

Quick smoke test:

```bash
# Health: shows which adapter is wired in
curl -s http://localhost:8080/healthz | jq

# Tool catalogue
curl -sN http://localhost:8080/sse | head -c 800

# Public repo
curl -s -X POST http://localhost:8080/invoke/github.get_repository \
  -H 'content-type: application/json' \
  -d '{"owner":"anthropics","repo":"anthropic-cookbook"}' | jq

# Authenticated user (uses GITHUB_TOKEN)
curl -s -X POST http://localhost:8080/invoke/github.get_user \
  -H 'content-type: application/json' -d '{}' | jq
```

## 4. Deploy

The existing `.github/workflows/azure-webapp.yml` keeps working — it builds
TypeScript and ships the `dist/` directory to the Azure Web App named in the
`AZURE_WEBAPP_NAME` secret.

Add the new App Settings in the Azure portal (or via `az webapp config
appsettings set`):

```bash
az webapp config appsettings set \
  -g rg-mcp-demo -n perplexmcpcopilot \
  --settings \
    GITHUB_TOKEN="ghp_..." \
    GITHUB_CLIENT_ID="..." \
    GITHUB_CLIENT_SECRET="..." \
    GITHUB_REDIRECT_URI="https://perplexmcpcopilot.azurewebsites.net/auth/github/callback" \
    STACKONE_API_KEY="..." \
    STACKONE_ACCOUNT_ID="..."
```

## 5. Wire it into Perplexity Enterprise Max

Perplexity Enterprise Max consumes MCP servers via the **Connectors** UI:
1. In Perplexity admin → Connectors → **Add MCP server**.
2. Server URL: `https://<your-app>.azurewebsites.net/sse`
3. Invoke URL pattern: `https://<your-app>.azurewebsites.net/invoke/{toolName}`
4. The server auto-advertises every tool in `tools` (see `src/server.ts`).
5. For OAuth-backed multi-user flows, the team admin shares the
   `/auth/github/start?user_id=<perplexity-user-id>` URL with each user once.

## 6. Security checklist

- All credentials come from environment variables — no hardcoded tokens.
- `GITHUB_TOKEN_STORE_PATH` writes a 0600-permission file; the in-memory store
  is the right default for ephemeral containers. For production, swap
  `createTokenStore` for an Azure Key Vault / AWS Secrets Manager implementation.
- The OAuth `state` parameter is generated with `crypto.randomBytes(24)` and
  validated against an in-memory map with a 15-minute TTL.
- Refresh tokens (when issued) are refreshed automatically with a 60s skew.
- Every upstream error returns a typed JSON envelope; tokens are never echoed
  in error messages.
- Structured logs (JSON, request-scoped `requestId`) are stdout-only — easy
  to ship to any log aggregator without leaking secrets.

See `docs/EXAMPLES.md` for sample queries.
