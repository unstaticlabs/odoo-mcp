/**
 * Test-only helper (imported by *.test.ts files, never by production code).
 *
 * Tests reach into the SDK registry and call tool handlers directly, which bypasses the SDK
 * layer that validates `structuredContent` against the tool's `outputSchema` on every non-error
 * result (see McpServer callTool). This wrapper replays that exact contract so every existing
 * happy-path test also proves the declared schema matches the real payload: an outputSchema'd
 * tool returning a success result without valid structuredContent would fail in production with
 * an "Output validation error" — here it fails the test instead.
 */
export function validatedToolHandler(server: unknown, name: string) {
  const registry = (server as { _registeredTools: Record<string, any> })._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`tool not registered: ${name}`);
  const handler = tool.handler.bind(tool);
  return async (args: unknown) => {
    const result = await handler(args);
    if (!result?.isError) {
      if (!tool.outputSchema) throw new Error(`tool ${name} declares no outputSchema`);
      if (result.structuredContent === undefined) {
        throw new Error(`tool ${name} returned a success result without structuredContent (the SDK would reject this)`);
      }
      const parsed = tool.outputSchema.safeParse(result.structuredContent);
      if (!parsed.success) {
        throw new Error(`tool ${name} structuredContent failed its outputSchema: ${parsed.error}`);
      }
    }
    return result;
  };
}
