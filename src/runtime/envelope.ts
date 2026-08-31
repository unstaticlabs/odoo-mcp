import { z } from "zod";
import type { RequestContext } from "./context.js";

export const ResultMetaSchema = z.object({
  request_id: z.string(),
  correlation_id: z.string(),
  capability_id: z.string(),
  capability_version: z.string(),
  profile: z.string(),
  target_id: z.string()
});

export const WarningSchema = z.array(z.string());

export function envelopeSchema<T extends z.ZodType>(data: T): z.ZodObject<{
  data: T;
  warnings: z.ZodArray<z.ZodString>;
  meta: typeof ResultMetaSchema;
}> {
  return z.object({ data, warnings: WarningSchema, meta: ResultMetaSchema });
}

export function resultEnvelope<T>(
  context: RequestContext,
  capabilityId: string,
  data: T,
  warnings: string[] = []
): { data: T; warnings: string[]; meta: z.infer<typeof ResultMetaSchema> } {
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

export function toolError(code: string, message: string, recovery: string | undefined, context: RequestContext) {
  const value = {
    error: {
      code,
      message,
      retryable: false,
      outcome: "not_applied",
      ...(recovery ? { recovery } : {}),
      request_id: context.requestId,
      correlation_id: context.correlationId
    }
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}
