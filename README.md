# MCP Azure Server Starter

This repository provides a minimal **Model Context Protocol (MCP)** server ready to deploy to **Azure App Service** and connect to **Microsoft Copilot Studio** via a custom MCP connector.

---

## Features

* 🚀 **Express + TypeScript** server that exposes an `SSE` endpoint (`/sse`) and simple tool‑invoke REST routes.
* 🛠 **Example tools** (`echo`, `greet`) show how to add your own business logic.
* 🏗 **GitHub workflow** for CI/CD – pushes to `main` are built and deployed automatically to your Web App.
* 📄 **OpenAPI (`assets/connector.yml`)** satisfies Copilot Studio’s requirements (`Agentic`, `McpSse` tags).
* 🔒 No auth by default – add your preferred scheme before production!

---

## Quick Start (local)

```bash
# 1 – Install
npm install

# 2 – run in watch mode
npm run dev

# 3 – Open another terminal and test
curl -N localhost:3000/sse
curl -X POST localhost:3000/invoke/echo -H "Content-Type: application/json" -d '{"text":"hello"}'
```

---

## Azure Deploy

1. Create an **Azure Web App** (Node 20 LTS runtime).
2. Add two App Settings  
   | Setting | Value |
   |---------|-------|
   | `PORT`  | `8080` |
   | `NODE_ENV` | `production` |
3. In the Web App page, copy the **Publish Profile** (or set up a deployment user).
4. In your repo → *Settings → Secrets*, add:
   * `AZURE_WEBAPP_NAME` – exact name of the Web App
   * `AZURE_PUBLISH_PROFILE` – contents of the publish‐profile XML
5. Push to `main`. The included **GitHub Actions** workflow builds, zips, and deploys.

---

## Extend ▸ Adding tools

Each tool is a TypeScript class that implements:

```ts
interface McpTool<TInput, TOutput> {
  name: string;
  description: string;
  schema: {
    input: JSONSchemaType<TInput>;
    output: JSONSchemaType<TOutput>;
  };
  invoke(input: TInput): Promise<TOutput>;
}
```

1. Drop a new file in `src/tools`.
2. Export an instance of your tool.
3. Import it in `src/server.ts` and append to the `tools` array.

The server automatically announces the tool definitions to Copilot Studio on every `SSE` connection.

---

## References

* Microsoft Learn – [Extend your agent with MCP](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp)
* Model Context Protocol spec – <https://modelcontextprotocol.io>
