import { ToolDefinition } from '../adapters/types';

export const greetTool: ToolDefinition = {
  name: 'greet',
  description: 'Returns a greeting for the given name.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name to greet' }
    },
    required: ['name']
  },
  async execute(args: { name: string }) {
    return { greeting: `Hello, ${args.name}!` };
  }
};
