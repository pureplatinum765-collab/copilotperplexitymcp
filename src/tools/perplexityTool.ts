import type { McpTool } from '../server';

interface PerplexityInput {
  prompt: string;
  model?: string;           // e.g. sonar-small-online
}
interface PerplexityOutput {
  answer: string;
  citations?: unknown[];
}

export const perplexityTool: McpTool<PerplexityInput, PerplexityOutput> = {
  name: 'perplexity.search',
  description: 'Queries Perplexity AI for an answer with citations.',
  schema: {
    input: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        model:  { type: 'string', default: 'sonar-small-online' }
      },
      required: ['prompt']
    },
    output: {
      type: 'object',
      properties: {
        answer:    { type: 'string' },
        citations: { type: 'array', items: {} }
      }
    }
  },
  async invoke({ prompt, model = 'sonar-small-online' }) {
    const resp = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      throw new Error(`Perplexity API error ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json();
    return {
      answer:    data.choices?.[0]?.message?.content ?? '',
      citations: data.choices?.[0]?.citations ?? []
    };
  }
};
