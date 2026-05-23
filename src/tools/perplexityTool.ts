import { ToolDefinition } from '../adapters/types';
import fetch from 'node-fetch';
import { getConfig } from '../config';

export const perplexitySearchTool: ToolDefinition = {
  name: 'perplexity.search',
  description: 'Search using Perplexity AI and return a cited answer.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      model: { type: 'string', description: 'Perplexity model override', default: 'sonar' }
    },
    required: ['query']
  },
  async execute(args: { query: string; model?: string }) {
    const cfg = getConfig();
    const resp = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.perplexityApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: args.model ?? cfg.perplexityModel,
        messages: [{ role: 'user', content: args.query }]
      })
    });
    if (!resp.ok) throw new Error(`Perplexity error ${resp.status}`);
    return resp.json();
  }
};

export const perplexityStreamTool: ToolDefinition = {
  name: 'perplexity.search.stream',
  description: 'Streaming version of perplexity.search (returns full text).',
  inputSchema: perplexitySearchTool.inputSchema,
  async execute(args: { query: string; model?: string }) {
    return perplexitySearchTool.execute(args);
  }
};
