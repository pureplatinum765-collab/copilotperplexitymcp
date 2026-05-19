import * as crypto from 'node:crypto';

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';

import { loadConfig } from './config';
import { createGitHubAdapter } from './adapters/factory';
import { GitHubAuth } from './auth/github';
import { createTokenStore } from './auth/tokenStore';
import { AppError, ValidationError } from './lib/errors';
import { log, setLogLevel, withContext } from './lib/logger';
import { createGitHubTools } from './tools/github';
import { echoTool } from './tools/echoTool';
import { greetTool } from './tools/greetTool';
import {
  callPerplexityStream,
  perplexityStreamTool,
  perplexityTool
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

const config = loadConfig();
setLogLevel(config.logLevel);

const tokenStore = createTokenStore(config.github.tokenStorePath);
const githubAuth = new GitHubAuth(config.github, tokenStore);
const githubAdapter = createGitHubAdapter(config, githubAuth);

const tools: McpTool[] = [
  echoTool,
  greetTool,
  perplexityTool,
  perplexityStreamTool,
  ...createGitHubTools(githubAdapter)
];

const app = express();

app.use(cors());
app.use(express.json());

// Request logger / correlation ID -------------------------------------------
app.use((req, res, next) => {
  const requestId = req.header('x-request-id') ?? crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  withContext({ requestId, method: req.method, path: req.path }, () => {
    const start = Date.now();
    log.info('request received');
    res.on('finish', () => {
      log.info('request completed', {
        status: res.statusCode,
        duration_ms: Date.now() - start
      });
    });
    next();
  });
});

// ---- SSE advertisement for MCP tools -------------------------------------
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

  res.end();
});

// ---- Generic MCP tool handler --------------------------------------------
app.post('/invoke/:toolName', async (req: Request, res: Response, next: NextFunction) => {
  const tool = tools.find(t => t.name === req.params.toolName);
  if (!tool) {
    next(new ValidationError(`tool not found: ${req.params.toolName}`));
    return;
  }

  try {
    const result = await tool.invoke(req.body);
    res.json({ jsonrpc: '2.0', id: Date.now().toString(), result });
  } catch (err) {
    next(err);
  }
});

// ---- Power Platform POST /query (legacy, unchanged) ----------------------
app.post('/query', async (req: Request, res: Response, next: NextFunction) => {
  const { prompt, model } = req.body;
  if (!prompt) {
    next(new ValidationError('Missing prompt in request body'));
    return;
  }

  try {
    const chosenModel = model || config.perplexity.defaultModel;
    let output = '';
    await callPerplexityStream(chosenModel, prompt, (chunk: string) => {
      output += chunk;
    });
    res.status(200).json({
      jsonrpc: '2.0',
      id: Date.now().toString(),
      result: { answer: output.trim(), citations: [] }
    });
  } catch (err) {
    next(err);
  }
});

// ---- Standalone perplexity stream (raw output) ---------------------------
app.post('/stream/perplexity.search', async (req: Request, res: Response) => {
  const { prompt, model } = req.body;
  const chosenModel = model || config.perplexity.defaultModel;

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    await callPerplexityStream(chosenModel, prompt, (chunk: string) => {
      res.write(chunk);
    });
    res.end();
  } catch (err) {
    log.error('perplexity stream error', { error: (err as Error).message });
    res.status(500).send(`Streaming error: ${err}`);
  }
});

// ---- SSE perplexity stream ------------------------------------------------
app.get('/sse/perplexity.search', async (req: Request, res: Response) => {
  const prompt = req.query.prompt as string;
  const model = (req.query.model as string) || config.perplexity.defaultModel;
  if (!prompt) {
    res.status(400).json({ error: 'Missing ?prompt= query parameter' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    await callPerplexityStream(model, prompt, (chunk: string) => {
      res.write(`event: token\n`);
      res.write(`data: ${chunk.trim()}\n\n`);
    });
    res.write(`event: done\ndata: [DONE]\n\n`);
    res.end();
  } catch (err) {
    log.error('perplexity SSE stream error', { error: (err as Error).message });
    res.write(`event: error\ndata: ${err}\n\n`);
    res.end();
  }
});

// ---- GitHub OAuth flow ----------------------------------------------------
app.get('/auth/github/start', (req, res, next) => {
  try {
    const userId = (req.query.user_id as string) || 'default';
    const scope = (req.query.scope as string) || 'repo read:user';
    const returnTo = req.query.return_to as string | undefined;
    const url = githubAuth.beginOAuth(userId, scope, returnTo);
    res.redirect(302, url);
  } catch (err) {
    next(err);
  }
});

app.get('/auth/github/callback', async (req, res, next) => {
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;
    if (!code || !state) throw new ValidationError('missing code or state');
    const { userId, returnTo } = await githubAuth.completeOAuth(code, state);
    if (returnTo) {
      res.redirect(302, returnTo);
      return;
    }
    res.json({ status: 'ok', user_id: userId });
  } catch (err) {
    next(err);
  }
});

app.post('/auth/github/revoke', async (req, res, next) => {
  try {
    const userId = req.body?.user_id;
    if (!userId) throw new ValidationError('user_id required');
    await githubAuth.revoke(userId);
    res.json({ status: 'revoked' });
  } catch (err) {
    next(err);
  }
});

// ---- Health check ---------------------------------------------------------
app.get('/', (_req, res) => res.send('MCP server up'));
app.get('/healthz', (_req, res) =>
  res.json({
    status: 'ok',
    adapter: githubAdapter.name,
    oauth_configured: githubAuth.isOAuthConfigured(),
    pat_configured: Boolean(config.github.defaultToken)
  })
);

// ---- Error handler --------------------------------------------------------
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    log.warn('handled error', { code: err.code, message: err.message, status: err.status });
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : 'unknown error';
  log.error('unhandled error', { error: message });
  res.status(500).json({ error: { code: 'internal_error', message } });
});

app.listen(config.port, () => log.info(`MCP server listening on :${config.port}`));
