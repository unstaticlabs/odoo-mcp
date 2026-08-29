import { DurableObject } from "cloudflare:workers";
import type { Env } from "./server";
import { OriginCoordinatorCore } from "./origin-coordinator-core";

/** Globally serializes physical JSON-2 calls for one normalized Odoo origin. */
export class OdooOriginCoordinator extends DurableObject<Env> {
  private readonly coordinator: OriginCoordinatorCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.coordinator = new OriginCoordinatorCore({ expectedOrigin: ctx.id.name });
  }

  fetch(request: Request): Promise<Response> {
    return this.coordinator.handle(request);
  }
}
