import { z } from "zod";
import type { RequestContext } from "./context.js";

export const ResultMetaSchema = z.object({
  request_id: z.string(),
  correlation_id: z.string(),
  capability_id: z.string(),
  capability_version: z.string(),
  profile: z.string(),
  target_id: z.string()
}).strict();

export const WarningSchema = z.array(z.string());

export function envelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({ data, warnings: WarningSchema, meta: ResultMetaSchema }).strict();
}

export function resultEnvelope<T>(
  context: RequestContext,
  capabilityId: string,
  data: T,
  warnings: string[] = []
) {
  return {
    data,
    warnings,
    meta: {
      request_id: context.requestId,
      correlation_id: context.correlationId,
      capability_id: capabilityId,
      capability_version: "1",
      profile: context.profile,
      target_id: context.principal.targetId
    }
  };
}

export function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

export interface ToolFailure {
  code: string;
  message: string;
  retryable?: boolean;
  outcome?: "succeeded" | "not_applied" | "unknown";
  recovery?: string;
}

export function toolError(failure: ToolFailure, context: RequestContext) {
  const value = {
    error: {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable ?? false,
      outcome: failure.outcome ?? "not_applied",
      ...(failure.recovery ? { recovery: failure.recovery } : {}),
      request_id: context.requestId,
      correlation_id: context.correlationId
    }
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}
