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
  condition_retryable?: boolean;
  outcome?: "succeeded" | "not_applied" | "unknown";
  retry_guidance?: "safe" | "after_correction" | "reconcile_first" | "never";
  stage?: "preflight" | "request_rejected" | "completion_ambiguous" | "response_processing";
  known?: {
    request_sent: "yes" | "no" | "unknown";
    response_received: "yes" | "no" | "unknown";
    result_received: "yes" | "no" | "unknown";
    target_model?: string;
    record_ids?: number[];
    grant_id?: string;
  };
  reconciliation?: {
    required: true;
    suggested_tool: string;
    target_model: string;
    record_ids?: number[];
    fields?: string[];
    instructions: string;
  };
  recovery?: string;
}

export function toolError(failure: ToolFailure, context: RequestContext) {
  const value = {
    error: {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable ?? false,
      ...(failure.condition_retryable === undefined ? {} : { condition_retryable: failure.condition_retryable }),
      outcome: failure.outcome ?? "not_applied",
      ...(failure.retry_guidance ? { retry_guidance: failure.retry_guidance } : {}),
      ...(failure.stage ? { stage: failure.stage } : {}),
      ...(failure.known ? { known: failure.known } : {}),
      ...(failure.reconciliation ? { reconciliation: failure.reconciliation } : {}),
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
