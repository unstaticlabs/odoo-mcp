import { MutationExecutionError, correlationIdForKey, resolveIdempotencyKey, type MutationExecution } from "./mutation";
import type { OdooConnection } from "./odoo";
import type { MutationOperationOptions, OdooQueue } from "./odoo-queue";

/** Add the new mutation-scope contract to legacy unit-test queue doubles. Never used in production. */
export function withTestMutationScope<T extends { enqueue: (...args: any[]) => Promise<any> }>(queue: T): OdooQueue {
  return Object.assign(queue, {
    async runMutation<R>(
      conn: OdooConnection,
      operation: MutationOperationOptions,
      callback: (scope: unknown) => Promise<R>
    ) {
      const key = resolveIdempotencyKey(operation.idempotencyKey);
      const execution: MutationExecution = {
        idempotency_key: key,
        idempotency_mode: "odoo_atomic",
        replayed: false,
        correlation_id: await correlationIdForKey(key),
        outcome: "unknown"
      };
      let applied = 0;
      const scope = {
        execution,
        get appliedCalls() {
          return applied;
        },
        async call(model: string, method: string, args: Record<string, unknown>) {
          const callArgs = operation.odooContext
            ? { ...args, context: { ...((args.context as Record<string, unknown> | undefined) ?? {}), ...operation.odooContext } }
            : args;
          const result = await queue.enqueue(conn, model, method, callArgs);
          applied++;
          return result;
        }
      };
      try {
        const result = await callback(scope);
        execution.outcome = "succeeded";
        return { result, execution };
      } catch (error) {
        execution.outcome = applied > 0 ? "unknown" : "not_applied";
        throw new MutationExecutionError(error, execution);
      }
    }
  }) as unknown as OdooQueue;
}
