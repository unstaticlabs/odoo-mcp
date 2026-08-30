export type EventName =
  | "auth.resolved"
  | "mcp.request.started"
  | "mcp.request.completed"
  | "mcp.tools.listed"
  | "mcp.capabilities.searched"
  | "mcp.tool.started"
  | "mcp.tool.completed"
  | "odoo.call.started"
  | "odoo.call.completed"
  | "mcp.request.cancelled";

type EventValue = string | number | boolean | null | undefined;

export function emitEvent(event: EventName, dimensions: Record<string, EventValue>): void {
  const payload: Record<string, EventValue> = {
    timestamp: new Date().toISOString(),
    schema_version: "1",
    event,
    ...dimensions
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}
