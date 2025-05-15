import type { McpTool } from '../server';

/** Input object Copilot passes to the tool */
interface PerplexityInput {
  prompt: string;
  model?: string;
}

/** Output object returned to Copilot */
interface PerplexityOutput {
  answer: string;
  citations?: unknown[];
}

/** Fallback model if caller doesn’t supply one and no env var is set */
const DEFAULT_MODEL =
  process.env.PERPLEXITY_MODEL ?? 'sonar';

/** Standard (non-streaming) call to Perplexity API */
async function callPerplexity(model: string, prompt: string) {
  const resp = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!resp.ok) {
    throw new Error(
      `Perplexity error ${resp.status}: ${await resp.text()}`
    );
  }

  return resp.json();
}

/** Streaming call to Perplexity API — emits raw token strings */
export async function callPerplexityStream(
  model: string,
  prompt: string,
  onChunk: (chunk: string) => void
) {
  const resp = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!resp.ok || !resp.body) {
    throw new Error(`Perplexity stream error ${resp.status}: ${await resp.text()}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // Save incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;

      const jsonStr = line.slice(6).trim();
      if (jsonStr === '[DONE]') continue;

      try {
        const parsed = JSON.parse(jsonStr);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          onChunk(delta); //  Emit only clean content string
        }
      } catch {
        // Skip bad chunks
      }
    }
  }
}

/** MCP-compatible tool for Perplexity (non-streaming) */
export const perplexityTool: McpTool<
  PerplexityInput,
  PerplexityOutput
> = {
  name: 'perplexity.search',
  description: 'Queries Perplexity AI for an answer with citations.',
  schema: {
    input: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        model: { type: 'string', description: 'Perplexity model ID' }
      },
      required: ['prompt']
    },
    output: {
      type: 'object',
      properties: {
        answer: { type: 'string' },
        citations: { type: 'array', items: {} }
      }
    }
  },

  async invoke({ prompt, model }) {
    const chosenModel = model || DEFAULT_MODEL;

    try {
      const data = await callPerplexity(chosenModel, prompt);
      return {
        answer: data.choices?.[0]?.message?.content ?? '',
        citations: data.choices?.[0]?.citations ?? []
      };
    } catch (err: any) {
      if (!model && chosenModel !== 'sonar') {
        const data = await callPerplexity('sonar', prompt);
        return {
          answer: data.choices?.[0]?.message?.content ?? '',
          citations: data.choices?.[0]?.citations ?? []
        };
      }
      throw err;
    }
  }
};
