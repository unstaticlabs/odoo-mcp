export type EventName =
  | "analytics.configuration"
  | "auth.resolved"
  | "auth.enrollment.completed"
  | "auth.enrollment.revoked"
  | "mcp.request.started"
  | "mcp.request.completed"
  | "mcp.tools.listed"
  | "mcp.capabilities.searched"
  | "mcp.tool.started"
  | "mcp.tool.completed"
  | "odoo.call.started"
  | "odoo.call.completed"
  | "mcp.request.cancelled";

export type EventValue = string | number | boolean | null | undefined;
export type EventDimensions = Record<string, EventValue>;

export interface RuntimeEventObserver {
  captureRuntimeEvent(event: EventName, dimensions: EventDimensions): void;
}

export function emitEvent(
  event: EventName,
  dimensions: EventDimensions,
  observer?: RuntimeEventObserver
): void {
  const payload: Record<string, EventValue> = {
    timestamp: new Date().toISOString(),
    schema_version: "1",
    event,
    ...dimensions
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  try {
    observer?.captureRuntimeEvent(event, payload);
  } catch {
    // Observability is fail-open and must never affect the MCP operation.
  }
}
