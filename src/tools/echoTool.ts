import { ToolDefinition } from '../adapters/types';

export const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echoes the input message back.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Message to echo' }
    },
    required: ['message']
  },
  async execute(args: { message: string }) {
    return { echo: args.message };
  }
};
