export function greetTool(args: { name: string }): { greeting: string } {
  return { greeting: `Hello, ${args.name}!` };
}
