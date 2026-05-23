# Example MCP Tool Calls

Every example here is a `POST /invoke/<tool>` with a JSON body. Add
`"user_id": "<your-id>"` to any payload to use that user's OAuth token instead
of the env-var PAT.

## github.list_repositories

List a user's public repositories:

```bash
curl -s -X POST http://localhost:8080/invoke/github.list_repositories \
  -H 'content-type: application/json' \
  -d '{"owner":"anthropics","per_page":5,"sort":"updated"}' | jq
```

List repositories for the authenticated user (omit `owner`):

```bash
curl -s -X POST http://localhost:8080/invoke/github.list_repositories \
  -H 'content-type: application/json' \
  -d '{"type":"owner","sort":"pushed","per_page":10}' | jq
```

## github.get_repository

```bash
curl -s -X POST http://localhost:8080/invoke/github.get_repository \
  -H 'content-type: application/json' \
  -d '{"owner":"anthropics","repo":"anthropic-cookbook"}' | jq
```

## github.list_issues

Most-recently-updated open bugs:

```bash
curl -s -X POST http://localhost:8080/invoke/github.list_issues \
  -H 'content-type: application/json' \
  -d '{
    "owner":"anthropics",
    "repo":"anthropic-cookbook",
    "state":"open",
    "labels":["bug"],
    "sort":"updated",
    "direction":"desc",
    "per_page":20
  }' | jq
```

## github.search_issues

GitHub's full search syntax (works regardless of adapter — StackOne
delegates this one to GitHub-direct automatically):

```bash
curl -s -X POST http://localhost:8080/invoke/github.search_issues \
  -H 'content-type: application/json' \
  -d '{"query":"repo:anthropics/anthropic-cookbook is:issue is:open label:documentation","sort":"updated","per_page":10}' | jq
```

## github.list_pull_requests

```bash
curl -s -X POST http://localhost:8080/invoke/github.list_pull_requests \
  -H 'content-type: application/json' \
  -d '{"owner":"anthropics","repo":"anthropic-cookbook","state":"open","sort":"updated"}' | jq
```

## github.get_user

Authenticated user (uses `GITHUB_TOKEN` or the stored OAuth token):

```bash
curl -s -X POST http://localhost:8080/invoke/github.get_user \
  -H 'content-type: application/json' -d '{}' | jq
```

Any public user:

```bash
curl -s -X POST http://localhost:8080/invoke/github.get_user \
  -H 'content-type: application/json' -d '{"login":"octocat"}' | jq
```

## Perplexity natural-language queries that wrap GitHub data

Once the connector is registered in Perplexity Enterprise Max, the model can
chain MCP calls. Useful prompts to try:

- "Summarize the last 10 open issues labelled `bug` in `anthropics/anthropic-cookbook`."
- "Show me the most-starred public repos belonging to the GitHub org `microsoft`,
  then explain what each one does."
- "Find pull requests in `vercel/next.js` that have been open for more than 90
  days and write a one-line summary of each."
- "Look up my GitHub profile, list my five most recently updated repos, and
  draft a short bio that highlights the languages I use."

## OAuth flow walkthrough

```bash
# 1. Start (browser is redirected to GitHub)
open "http://localhost:8080/auth/github/start?user_id=alice"

# 2. GitHub redirects to the callback automatically. You'll see:
# { "status": "ok", "user_id": "alice" }

# 3. Use Alice's token from any MCP tool call
curl -s -X POST http://localhost:8080/invoke/github.get_user \
  -H 'content-type: application/json' -d '{"user_id":"alice"}' | jq

# 4. Revoke locally if needed
curl -s -X POST http://localhost:8080/auth/github/revoke \
  -H 'content-type: application/json' -d '{"user_id":"alice"}'
```

## Health & diagnostics

```bash
curl -s http://localhost:8080/healthz | jq
# {
#   "status": "ok",
#   "adapter": "github-direct",   // or "stackone"
#   "oauth_configured": false,
#   "pat_configured": true
# }
```

Every request emits two JSON log lines (`request received` / `request
completed`) with a `requestId` you can grep on. Set `LOG_LEVEL=debug` to also
see every upstream GitHub/StackOne URL the adapter hits and the rate-limit
headers it gets back.
