import { dump as toYaml } from 'js-yaml';
import type { McpTool } from './server';

export function generateSwaggerYaml(tools: McpTool[], options?: { host?: string }) {
  const host = options?.host ?? 'localhost:8080';

  const swagger: any = {
    swagger: '2.0',
    info: {
      title: 'MCP Tool API',
      description: 'Auto-generated MCP tool definitions for Power Platform.',
      version: '1.0.0'
    },
    host,
    basePath: '/',
    schemes: ['https'],
    consumes: ['application/json'],
    produces: ['application/json'],
    paths: {},
    definitions: {},
    securityDefinitions: {},
    security: []
  };

  for (const tool of tools) {
    const path = `/invoke/${tool.name}`;
    swagger.paths[path] = {
      post: {
        tags: ['MCP'],
        summary: tool.description,
        operationId: tool.name.replace(/\./g, '_'),
        consumes: ['application/json'],
        produces: ['application/json'],
        parameters: [{
          name: 'body',
          in: 'body',
          required: true,
          schema: tool.schema.input
        }],
        responses: {
          200: {
            description: 'Successful response',
            schema: tool.schema.output
          },
          default: {
            description: 'Unexpected error',
            schema: {
              type: 'object',
              properties: {
                error: { type: 'string' }
              }
            }
          }
        }
      }
    };
  }

  return toYaml(swagger);
}
