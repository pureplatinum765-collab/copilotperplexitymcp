import type { McpTool } from '../server';

interface EchoInput {
  text: string;
}
interface EchoOutput {
  text: string;
}

export const echoTool: McpTool<EchoInput, EchoOutput> = {
  name: 'echo',
  description: 'Returns the same text you send.',
  schema: {
    input: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    },
    output: {
      type: 'object',
      properties: { text: { type: 'string' } }
    }
  },
  async invoke(input) {
    return { text: input.text };
  }
};
