# Copilot + Perplexity MCP Server ✨ 

A lightweight Model Context Protocol (MCP) server—built with TypeScript + Express, deployable to an Azure Linux Web App—that streams its tool catalog via a single Server-Sent Events endpoint and exposes `echo`, `greet`, `perplexity.search`, and a suite of `github.*` tools (optionally routed through StackOne) so Microsoft Copilot Studio agents, Power Automate flows, and **Perplexity Enterprise Max** can invoke them for real-time, citation-backed answers from Perplexity AI and live data from GitHub.

## StackOne ↔ GitHub ↔ Perplexity bridge

The repo now ships a complete bridge that lets Perplexity Enterprise Max (or any MCP client) query GitHub through this server, optionally routed through StackOne as an intermediary.

| Tool | Purpose |
|------|---------|
| `github.list_repositories` | List repos for a user/org or the authenticated user |
| `github.get_repository`    | Fetch a single repo's metadata |
| `github.list_issues`       | List issues with state/label/assignee filters |
| `github.search_issues`     | Full GitHub search syntax across issues/PRs |
| `github.list_pull_requests`| List PRs with state/base/head filters |
| `github.get_user`          | Authenticated or arbitrary user profile |

Auth: both PAT (default fallback via `GITHUB_TOKEN`) and OAuth 2.0 (per-user via `/auth/github/start` → `/auth/github/callback`, with refresh-token support for GitHub Apps) are supported out of the box.

Backend: the adapter auto-selects — StackOne when `STACKONE_API_KEY` is set, GitHub-direct otherwise. Operations StackOne can't serve fall through to GitHub-direct so the tool surface stays stable.

- Setup: [docs/STACKONE_GITHUB_SETUP.md](docs/STACKONE_GITHUB_SETUP.md)
- Example queries: [docs/EXAMPLES.md](docs/EXAMPLES.md)
- Env template: [`.env.example`](.env.example)
- Swagger for the new endpoints: [`assets/github_connector.yml`](assets/github_connector.yml)


## Compatibility Summary

| Layer | Compatible Targets |
|-------|-------------------|
| Runtime | Node.js 20 LTS (tested); works with any Node 18+ environment |
| Hosting | Azure App Service for Linux (Basic B1 or higher) — container runtime uses the built-in NODE |
| CI/CD | GitHub Actions (Ubuntu runners) via `azure/webapps-deploy@v3` |
| MCP client | Microsoft Copilot Studio agents (Generative actions / "AI Plugin" preview)<br>Power Automate / Logic Apps (custom connector actions) |
| LLM back-end | Perplexity AI REST API — any current public model (default `sonar`, but overridable) |
| Local dev / testing | macOS, Windows, WSL2, or Linux with Node 20 + npm 10; cURL or Postman for raw SSE tests |

No other cloud services or proprietary dependencies are required—the repo is cloud-agnostic beyond Azure Web App and uses only standard HTTP + SSE.

## End-to-End Setup — High-Level Checklist

### 1. Clone and Validate the Repo

```bash
git clone https://github.com/ITSpecialist111/CopilotPerplexityMCP.git
cd CopilotPerplexityMCP
```

Push a throw-away commit or open a PR → GitHub Actions runs the "Azure Web App CI" workflow. Green check = code builds & lints.

### 2. Add Required GitHub Secrets

| Secret | Value (where to get it) |
|--------|-------------------------|
| AZURE_PUBLISH_PROFILE | Download the Publish profile XML from the target Azure Web App → paste entire XML text. |
| AZURE_WEBAPP_NAME | The exact Web App name (e.g. `perplexmcpcopilot`). |

Repo → Settings → Secrets → Actions → New repository secret.

### 3. Prepare the Azure Web App

**Create resources:**
```bash
az group create -n rg-mcp-demo -l uksouth
az appservice plan create -g rg-mcp-demo -n asp-mcp-demo --sku B1 --is-linux
az webapp create -g rg-mcp-demo -p asp-mcp-demo -n perplexmcpcopilot --runtime "NODE|20-lts"
```

**App Settings** (Portal → Configuration → Application settings):
- `PERPLEXITY_API_KEY` – your Perplexity key
- `PERPLEXITY_MODEL` – optional default model

Enable Application logging so you can tail the Log Stream.

Once the Web App exists, the publish-profile secret lets GitHub Actions deploy on every push.

### 4. Push → Deploy → Smoke Test

```bash
git commit --allow-empty -m "trigger deploy"
git push origin main
```

Actions builds, publishes to Azure.

**Verify:**
```bash
curl -N https://<webapp>.azurewebsites.net/sse    # should emit "event: tools"
```

### 5. Set Up the Custom Connector

Power Platform → Solutions → + New → Custom connector → Import an OpenAPI file.
- Upload `swagger/mcp_connector.yaml` (in this repo).
- Security → No authentication.
- AI Plugin (preview)
  - Fill Name, Description, Contact email, Legal URL.
  - Toggle Enabled for generative actions → On.
  - Create connection when prompted (no creds).
- Test tab → call MCP SSE Stream → should return the tool list.

### 6. Enable the Plugin in Copilot Studio

- Open your Copilot agent in the Studio designer.
- ✨ Overview → toggle Generative actions → On.
- Click + Actions, pick Perplexity MCP Connector under custom connections/MCP, toggle Use by this agent → On.
- Publish the agent.

**Chat prompt example:** "Using your Perplexity search tool, what's the capital of France?"

Azure Log Stream should show:
```
GET /sse
POST /invoke/perplexity.search
```
—indicating the agent discovered the tools and invoked the one it needed.

<p align="center">
  <a href="https://www.buymeacoffee.com/ITSpecialist" target="_blank">
    <img src="https://img.shields.io/badge/Buy&nbsp;me&nbsp;a&nbsp;coffee-Support&nbsp;Dev-yellow?style=for-the-badge&logo=buy-me-a-coffee" alt="Buy Me A Coffee">
  </a>
</p>
