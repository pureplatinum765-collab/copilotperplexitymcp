import express, { type Request, type Response } from 'express';
import cors from 'cors';

import { echoTool } from './tools/echoTool';
import { greetTool } from './tools/greetTool';
import {
  perplexityTool,
  perplexityStreamTool,
  callPerplexityStream
} from './tools/perplexityTool';

export interface McpTool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  schema: {
    input: object;
    output: object;
  };
  invoke(input: TInput): Promise<TOutput>;
}

// 🔧 All tools, including streaming variant
const tools: McpTool[] = [
  echoTool,
  greetTool,
  perplexityTool,
  perplexityStreamTool
];

const PORT = process.env.PORT || 8080;
const app = express();

app.use(cors());
app.use(express.json());

// ---- SSE advertisement for MCP tools -----------------------------------
app.get('/sse', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write('event: tools\n');
  res.write(
    `data: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 'tool-list',
      method: 'tools',
      params: {
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          schema: t.schema
        }))
      }
    })}\n\n`
  );

  res.end(); // Copilot expects stream to close after list
});

// ---- Generic MCP tool handler ------------------------------------------
app.post('/invoke/:toolName', async (req: Request, res: Response) => {
  const tool = tools.find(t => t.name === req.params.toolName);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });

  try {
    const result = await tool.invoke(req.body);
    res.json({ jsonrpc: '2.0', id: Date.now().toString(), result });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Unknown error' });
  }
});

// ---- Standalone stream endpoint (for raw output testing) ---------------
app.post('/stream/perplexity.search', async (req: Request, res: Response) => {
  const { prompt, model } = req.body;
  const chosenModel = model || process.env.PERPLEXITY_MODEL || 'sonar';

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    await callPerplexityStream(chosenModel, prompt, (chunk: string) => {
      res.write(chunk);
    });
    res.end();
  } catch (err) {
    console.error('Streaming error:', err);
    res.status(500).send(`Streaming error: ${err}`);
  }
});

// ---- Health check ------------------------------------------------------
app.get('/', (_req, res) => res.send('👌 MCP server up'));

app.listen(PORT, () => console.log(`MCP server listening on :${PORT}`));
