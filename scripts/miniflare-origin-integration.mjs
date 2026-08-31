import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const activeByOrigin = new Map();
const maxActiveByOrigin = new Map();
let activeTotal = 0;
let maxActiveTotal = 0;

function resetConcurrencyEvidence() {
  activeTotal = 0;
  maxActiveTotal = 0;
  activeByOrigin.clear();
  maxActiveByOrigin.clear();
}

const bundle = await build({
  entryPoints: ["src/origin-coordinator-miniflare-worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  external: ["cloudflare:workers"],
  write: false
});

const miniflare = new Miniflare({
  compatibilityDate: "2026-07-01",
  modules: true,
  script: bundle.outputFiles[0].text,
  durableObjects: {
    OdooOriginCoordinator: {
      className: "OdooOriginCoordinator",
      useSQLite: true
    }
  },
  serviceBindings: {
    TestOdooOutbound: async (request) => {
      const origin = new URL(request.url).origin;
      const originActive = (activeByOrigin.get(origin) ?? 0) + 1;
      activeByOrigin.set(origin, originActive);
      maxActiveByOrigin.set(origin, Math.max(maxActiveByOrigin.get(origin) ?? 0, originActive));
      activeTotal += 1;
      maxActiveTotal = Math.max(maxActiveTotal, activeTotal);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeByOrigin.set(origin, originActive - 1);
      activeTotal -= 1;
      return Response.json({ result: request.headers.get("X-Odoo-Database") });
    }
  }
});

function dispatch(target, marker) {
  return miniflare.dispatchFetch("http://mcp.test/coordinate", {
    method: "POST",
    headers: {
      "X-Test-Odoo-Target": target,
      "X-Test-Marker": marker
    }
  });
}

try {
  await miniflare.ready;
  const originA = "https://odoo-a.example";
  const originB = "https://odoo-b.example";
  const target = `${originA}/json/2/res.partner/search_read`;
  const sameOriginResponses = await Promise.all([
    dispatch(target, "one"),
    dispatch(target, "two"),
    dispatch(target, "three")
  ]);
  assert.deepEqual(
    sameOriginResponses.map((response) => response.status),
    [200, 200, 200],
    `unexpected coordinator responses: ${await Promise.all(sameOriginResponses.map((response) => response.clone().text()))}`
  );
  assert.equal(maxActiveByOrigin.get(originA), 1);

  resetConcurrencyEvidence();
  const independentResponses = await Promise.all([
    dispatch(`${originA}/json/2/res.partner/search_read`, "a"),
    dispatch(`${originB}/json/2/res.partner/search_read`, "b")
  ]);
  assert.deepEqual(
    independentResponses.map((response) => response.status),
    [200, 200],
    `unexpected coordinator responses: ${await Promise.all(independentResponses.map((response) => response.clone().text()))}`
  );
  assert.equal(maxActiveByOrigin.get(originA), 1);
  assert.equal(maxActiveByOrigin.get(originB), 1);
  assert.equal(maxActiveTotal, 2);
  console.log("Miniflare origin coordination integration passed");
} finally {
  await miniflare.dispose();
}
