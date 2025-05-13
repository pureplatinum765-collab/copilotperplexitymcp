import type { McpTool } from '../server';

/** Input object Copilot passes to the tool */
interface PerplexityInput {
  prompt: string;
  /** Optional: specify a different Perplexity model */
  model?: string;
}

/** Output object returned to Copilot */
interface PerplexityOutput {
  answer: string;
  citations?: unknown[];
}

/** Fallback model if caller doesn’t supply one and no env var is set */
const DEFAULT_MODEL =
  process.env.PERPLEXITY_MODEL /* override via App Setting */ ??
  'sonar';        /* hard‑coded default */

/** Helper to call the Perplexity API */
async function callPerplexity(model: string, prompt: string) {
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
    throw new Error(
      `Perplexity error ${resp.status}: ${await resp.text()}`
    );
  }
  return resp.json();
}

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
        model:  { type: 'string', description: 'Perplexity model ID' }
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

  async invoke({ prompt, model }) {
    const chosenModel = model || DEFAULT_MODEL;

    /* Attempt once with requested/default model */
    try {
      const data = await callPerplexity(chosenModel, prompt);
      return {
        answer:    data.choices?.[0]?.message?.content ?? '',
        citations: data.choices?.[0]?.citations ?? []
      };
    } catch (err: any) {
      /* If model was auto‑selected and failed, fall back to sonar */
      if (!model && chosenModel !== 'sonar') {
        const data = await callPerplexity('sonar', prompt);
        return {
          answer:    data.choices?.[0]?.message?.content ?? '',
          citations: data.choices?.[0]?.citations ?? []
        };
      }
      throw err;
    }
  }
};
