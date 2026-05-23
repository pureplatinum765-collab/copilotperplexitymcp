import { loadConfig } from '../config';

export async function perplexitySearchTool(
  args: { query: string; model?: string }
): Promise<unknown> {
  const cfg = loadConfig();
  const resp = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.perplexity.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: args.model ?? cfg.perplexity.defaultModel,
      messages: [{ role: 'user', content: args.query }]
    })
  });
  if (!resp.ok) throw new Error(`Perplexity error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

export const perplexityStreamTool = perplexitySearchTool;
