import { DurableObject } from "cloudflare:workers";
import { OriginCoordinatorCore } from "./origin-coordinator-core";

interface HarnessEnv {
  OdooOriginCoordinator: DurableObjectNamespace<OdooOriginCoordinator>;
  TestOdooOutbound: Fetcher;
}

/** Miniflare adapter around the same production coordinator core. */
export class OdooOriginCoordinator extends DurableObject<HarnessEnv> {
  private readonly coordinator: OriginCoordinatorCore;

  constructor(ctx: DurableObjectState, env: HarnessEnv) {
    super(ctx, env);
    this.coordinator = new OriginCoordinatorCore({
      expectedOrigin: ctx.id.name,
      fetchFn: (input, init) => env.TestOdooOutbound.fetch(input, init)
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.coordinator.handle(request);
  }
}

/** Test-only Worker entrypoint that routes a request through the production DO. */
export default {
  fetch(request: Request, env: HarnessEnv): Promise<Response> {
    const target = request.headers.get("X-Test-Odoo-Target");
    if (!target) return Promise.resolve(new Response("missing target", { status: 400 }));
    const targetUrl = new URL(target);
    const outbound = new Request(targetUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-only",
        "X-Odoo-Database": "test",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ marker: request.headers.get("X-Test-Marker") })
    });
    return env.OdooOriginCoordinator.getByName(targetUrl.origin).fetch(outbound);
  }
};
