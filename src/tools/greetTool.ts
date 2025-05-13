import type { McpTool } from '../server';

interface GreetInput {
  name?: string;
}
interface GreetOutput {
  greeting: string;
}

export const greetTool: McpTool<GreetInput, GreetOutput> = {
  name: 'greet',
  description: 'Sends a friendly greeting.',
  schema: {
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name to greet', default: 'friend' }
      },
      required: []
    },
    output: {
      type: 'object',
      properties: { greeting: { type: 'string' } }
    }
  },
  async invoke({ name }) {
    return { greeting: `Hello ${name ?? 'friend'}!` };
  }
};
