export function echoTool(args: { message: string }): { echo: string } {
  return { echo: args.message };
}
