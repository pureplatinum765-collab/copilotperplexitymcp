import express, { type Request, type Response } from 'express';
import cors from 'cors';

import { echoTool } from './tools/echoTool';
import { greetTool } from './tools/greetTool';
import { perplexityTool } from './tools/perplexityTool';

export interface McpTool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  schema: {
    input: object;
    output: object;
  };
  invoke(input: TInput): Promise<TOutput>;
}

const tools: McpTool[] = [echoTool, greetTool, perplexityTool];

const PORT = process.env.PORT || 8080;
const app  = express();

app.use(cors());
app.use(express.json());

// ---- SSE stream --------------------------------------------------------
app.get('/sse', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // announce tool list immediately
  res.write('event: tools\n');
  res.write(
    `data: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 'tool-list',
      method: 'tools',
      params: {
        tools: tools.map(t => ({
          name:        t.name,
          description: t.description,
          schema:      t.schema
        }))
      }
    })}\n\n`
  );
});

// ---- Tool invocation ---------------------------------------------------
app.post('/invoke/:toolName', async (req, res) => {
  const tool = tools.find(t => t.name === req.params.toolName);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });

  try {
    const result = await tool.invoke(req.body);
    res.json({ jsonrpc: '2.0', id: Date.now().toString(), result });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Unknown error' });
  }
});

// ---- health ------------------------------------------------------------
app.get('/', (_req, res) => res.send('👌 MCP server up'));

app.listen(PORT, () => console.log(`MCP server listening on :${PORT}`));
