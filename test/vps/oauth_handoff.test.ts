import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthService, oauthClientLabel } from "../../src/auth/oauth.js";
import { CredentialVault } from "../../src/auth/vault.js";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import { loadRuntimeConfig } from "../../src/runtime/config.js";
import { createObservability } from "../../src/runtime/observability.js";
import { requestContext } from "./fixtures.js";

const ORIGIN = "http://127.0.0.1:3000";
const AGENT_KEY = "agent-key-that-must-stay-on-the-server";
const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closeCallbacks.splice(0)) await close();
});

function configuration(extra: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "odoo-mcp-handoff-"));
  closeCallbacks.push(async () => rmSync(directory, { recursive: true, force: true }));
  return loadRuntimeConfig({
    ODOO_PUBLIC_ORIGIN: "https://odoo.example",
    ODOO_INTERNAL_ORIGIN: "http://odoo:8069",
    ODOO_DATABASE: "usl",
    MCP_PUBLIC_ORIGIN: ORIGIN,
    MCP_OAUTH_ENABLED: "true",
    MCP_OAUTH_ODOO_HANDOFF: "true",
    MCP_OAUTH_DATABASE: join(directory, "oauth.sqlite"),
    BETTER_AUTH_SECRET: "a-development-secret-that-is-long-enough-for-tests",
    MCP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ...extra
  });
}

/** An Odoo that accepts the Agent key and serves a complete access surface. */
function odooFetcher(): typeof fetch {
  const access = requestContext();
  const methods = [...new Set([...access.availablePublicMethods!.values()].flatMap((names) => [...names]))];
  return async (input) => {
    const url = String(input);
    if (url.includes("/json/2/usl.agent/current_identity")) return Response.json(access.agentIdentity);
    if (url.endsWith("/doc-bearer/index.json")) return Response.json({
      modules: ["base", "api_doc", "usl_access_control"],
      models: [...access.availableModelAccess!.keys()].map((model) => ({
        model,
        access: access.availableModelAccess!.get(model),
        methods
      }))
    });
    return Response.json({ message: "unexpected test request" }, { status: 404 });
  };
}

async function handoffService(exchange: typeof fetch, extra: Record<string, string> = {}) {
  const config = configuration(extra);
  const client = new OdooClient(8, 1024 * 1024, odooFetcher());
  const services = {
    client,
    registry: createCapabilityRegistry(client),
    enabledFeatures: new Set<string>(),
    observability: createObservability(config.analytics),
    accessCache: new AgentAccessSnapshotCache(client)
  };
  const service = createOAuthService(config, services, { fetch: exchange })!;
  closeCallbacks.push(async () => {
    await services.accessCache.close();
    service.close();
    await services.observability.close();
  });
  await service.ready;
  service.vault.database.prepare(`INSERT INTO oauthClient
    (id, clientId, name, tokenEndpointAuthMethod, redirectUris, grantTypes)
    VALUES ('handoff-fixture', 'handoff-fixture', 'Synthetic Hub', 'none', ?, ?)`)
    .run('["https://client.example/callback"]', '["authorization_code","refresh_token"]');
  return { config, service };
}

/** Ask Better Auth for a real signed login redirect. */
async function signedEnrollmentUrl(service: Awaited<ReturnType<typeof handoffService>>["service"]): Promise<URL> {
  const authorize = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: "handoff-fixture",
    redirect_uri: "https://client.example/callback",
    scope: "openid odoo",
    state: "client-state",
    code_challenge: createHash("sha256").update("client-verifier").digest("base64url"),
    code_challenge_method: "S256"
  }).toString();
  const response = await service.authFetch(new Request(authorize, { redirect: "manual" }));
  const location = response.headers.get("Location");
  expect(location, `authorize answered ${response.status}`).toBeTruthy();
  const destination = new URL(location!, ORIGIN);
  expect(destination.pathname).toBe("/oauth/enroll");
  return destination;
}

async function startedHandoff(service: Awaited<ReturnType<typeof handoffService>>["service"]) {
  const enrollment = await signedEnrollmentUrl(service);
  const response = await service.enrollmentFetch(new Request(enrollment));
  expect(response.status).toBe(302);
  const odoo = new URL(response.headers.get("Location")!);
  const cookie = response.headers.get("Set-Cookie")!.split(";")[0]!;
  return { enrollment, response, odoo, cookie, state: odoo.searchParams.get("state")! };
}

function callback(state: string, cookie: string | null, parameters: Record<string, string>): Request {
  const url = new URL(`${ORIGIN}/oauth/enroll/callback`);
  url.search = new URLSearchParams({ state, ...parameters }).toString();
  return new Request(url, { headers: cookie ? { Cookie: cookie } : {} });
}

const ODOO_CODE = "c".repeat(43);

describe("Odoo enrollment handoff", () => {
  it("redirects a signed authorization to the Odoo page without the manual form", async () => {
    const { service } = await handoffService(vi.fn<typeof fetch>());
    const { response, odoo } = await startedHandoff(service);

    expect(`${odoo.origin}${odoo.pathname}`).toBe("https://odoo.example/usl/agent-access/connect");
    expect(odoo.searchParams.get("return_url")).toBe(`${ORIGIN}/oauth/enroll/callback`);
    expect(odoo.searchParams.get("client_name")).toBe("Synthetic Hub");
    expect(odoo.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(odoo.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...odoo.searchParams.keys()].sort()).toEqual(["client_name", "code_challenge", "return_url", "state"]);
    expect(response.headers.get("Set-Cookie")).toMatch(/^odoo_enroll=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("exchanges the code on the server, stores the key, and continues the OAuth flow", async () => {
    const exchange = vi.fn<typeof fetch>(async () => Response.json({ api_key: AGENT_KEY }));
    const { config, service } = await handoffService(exchange);
    const { odoo, cookie, state } = await startedHandoff(service);

    const response = await service.enrollmentFetch(callback(state, cookie, { code: ODOO_CODE }));

    expect(response.status).toBe(302);
    const location = response.headers.get("Location")!;
    expect(new URL(location, ORIGIN).pathname).toMatch(/^\/oauth\/consent$|^\/callback$/);
    expect(response.headers.getSetCookie().join("\n")).toContain("session_token");
    // The key travels only in the server-to-server response.
    expect(location).not.toContain(AGENT_KEY);
    expect(response.headers.getSetCookie().join("\n")).not.toContain(AGENT_KEY);
    expect(await response.text()).toBe("");

    expect(exchange).toHaveBeenCalledTimes(1);
    const [target, init] = exchange.mock.calls[0]!;
    expect(String(target)).toBe("http://odoo:8069/usl/agent-access/token");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("X-Odoo-Database")).toBe("usl");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("code")).toBe(ODOO_CODE);
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"))
      .toBe(odoo.searchParams.get("code_challenge"));

    const enrollmentId = service.vault.stableEnrollmentId("default", "usl", requestContext().agentIdentity!.user_id);
    expect(service.vault.resolve(enrollmentId)).toMatchObject({ apiKey: AGENT_KEY, authMode: "oauth" });
    service.vault.database.pragma("wal_checkpoint(TRUNCATE)");
    expect(readFileSync(config.oauth!.databasePath).includes(Buffer.from(AGENT_KEY))).toBe(false);
  });

  it("accepts a state one time only", async () => {
    const exchange = vi.fn<typeof fetch>(async () => Response.json({ api_key: AGENT_KEY }));
    const { service } = await handoffService(exchange);
    const { cookie, state } = await startedHandoff(service);

    expect((await service.enrollmentFetch(callback(state, cookie, { code: ODOO_CODE }))).status).toBe(302);
    const replay = await service.enrollmentFetch(callback(state, cookie, { code: ODOO_CODE }));

    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("Connection request expired");
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("refuses a callback from a browser that did not start the handoff", async () => {
    const exchange = vi.fn<typeof fetch>(async () => Response.json({ api_key: AGENT_KEY }));
    const { service } = await handoffService(exchange);
    const { cookie, state } = await startedHandoff(service);

    for (const foreign of [null, `odoo_enroll=${"x".repeat(43)}`]) {
      const response = await service.enrollmentFetch(callback(state, foreign, { code: ODOO_CODE }));
      expect(response.status).toBe(400);
    }
    expect(exchange).not.toHaveBeenCalled();
    // The refused attempts did not use up the handoff of the real browser.
    expect((await service.enrollmentFetch(callback(state, cookie, { code: ODOO_CODE }))).status).toBe(302);
  });

  it("refuses an expired handoff", async () => {
    const exchange = vi.fn<typeof fetch>();
    const { service } = await handoffService(exchange);
    const { cookie, state } = await startedHandoff(service);
    service.vault.database.prepare("UPDATE odoo_enrollment_handoff SET expires_at = 1").run();

    const response = await service.enrollmentFetch(callback(state, cookie, { code: ODOO_CODE }));

    expect(response.status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("offers a retry and the manual form after a cancel in Odoo", async () => {
    const exchange = vi.fn<typeof fetch>();
    const { service } = await handoffService(exchange);
    const { enrollment, cookie, state } = await startedHandoff(service);

    const response = await service.enrollmentFetch(callback(state, cookie, { error: "access_denied" }));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Connection cancelled");
    expect(body).toContain(`href="/oauth/enroll?${enrollment.search.slice(1).replaceAll("&", "&#38;")}"`);
    expect(body).toContain('href="/oauth/enroll/manual?');
    expect(exchange).not.toHaveBeenCalled();
    expect(service.vault.database.prepare("SELECT count(*) AS count FROM odoo_enrollment").get()).toEqual({ count: 0 });
  });

  it("opens the manual form when the user asks for it in Odoo", async () => {
    const { service } = await handoffService(vi.fn<typeof fetch>());
    const { enrollment, cookie, state } = await startedHandoff(service);

    const response = await service.enrollmentFetch(callback(state, cookie, { error: "manual_entry" }));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/oauth/enroll/manual${enrollment.search}`);
    const manual = await service.enrollmentFetch(new Request(new URL(response.headers.get("Location")!, ORIGIN)));
    expect(manual.status).toBe(200);
    const form = await manual.text();
    expect(form).toContain('name="apiKey"');
    expect(form).toContain("fetch('/oauth/enroll'");
  });

  it("reports a refused code without storing an enrollment", async () => {
    const exchange = vi.fn<typeof fetch>(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    const { service } = await handoffService(exchange);
    const { cookie, state } = await startedHandoff(service);

    const response = await service.enrollmentFetch(callback(state, cookie, { code: ODOO_CODE }));

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Odoo did not accept the connection code");
    expect(service.vault.database.prepare("SELECT count(*) AS count FROM odoo_enrollment").get()).toEqual({ count: 0 });
  });

  it("shows the manual form for a query that this server did not sign", async () => {
    const { service } = await handoffService(vi.fn<typeof fetch>());
    const enrollment = await signedEnrollmentUrl(service);
    enrollment.searchParams.set("client_id", "another-client");

    for (const url of [enrollment, new URL(`${ORIGIN}/oauth/enroll`)]) {
      const response = await service.enrollmentFetch(new Request(url));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('name="apiKey"');
    }
    expect(service.vault.database.prepare("SELECT count(*) AS count FROM odoo_enrollment_handoff").get()).toEqual({ count: 0 });
  });

  it("keeps the manual form as the default when the handoff is not enabled", async () => {
    const { service } = await handoffService(vi.fn<typeof fetch>(), { MCP_OAUTH_ODOO_HANDOFF: "false" });
    const response = await service.enrollmentFetch(new Request(await signedEnrollmentUrl(service)));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="apiKey"');
  });
});

describe("Odoo enrollment handoff storage", () => {
  it("stores no usable state, binding, or verifier", () => {
    const config = configuration();
    const vault = new CredentialVault(config.oauth!, config);
    const pending = vault.createHandoff("client_id=test", 600);
    vault.database.pragma("wal_checkpoint(TRUNCATE)");
    const stored = readFileSync(config.oauth!.databasePath);

    expect(stored.includes(Buffer.from(pending.state))).toBe(false);
    expect(stored.includes(Buffer.from(pending.binding))).toBe(false);
    const consumed = vault.consumeHandoff(pending.state, pending.binding)!;
    expect(stored.includes(Buffer.from(consumed.codeVerifier))).toBe(false);
    expect(createHash("sha256").update(consumed.codeVerifier).digest("base64url")).toBe(pending.codeChallenge);
    expect(consumed.oauthQuery).toBe("client_id=test");
    expect(vault.consumeHandoff(pending.state, pending.binding)).toBeNull();
    vault.close();
  });

  it("keeps one browser binding across parallel handoffs", () => {
    const config = configuration();
    const vault = new CredentialVault(config.oauth!, config);
    const first = vault.createHandoff("client_id=one", 600);
    const second = vault.createHandoff("client_id=two", 600, first.binding);

    expect(second.binding).toBe(first.binding);
    expect(vault.consumeHandoff(first.state, first.binding)?.oauthQuery).toBe("client_id=one");
    expect(vault.consumeHandoff(second.state, first.binding)?.oauthQuery).toBe("client_id=two");
    vault.close();
  });
});

describe("Odoo enrollment handoff configuration", () => {
  it("requires OAuth and exactly one Odoo database", () => {
    expect(configuration().oauth!.odooHandoff).toEqual({
      targetId: "default",
      publicOrigin: "https://odoo.example",
      internalOrigin: "http://odoo:8069",
      database: "usl"
    });
    expect(configuration({ MCP_OAUTH_ODOO_HANDOFF: "false" }).oauth!.odooHandoff).toBeNull();
    expect(() => loadRuntimeConfig({
      ODOO_PUBLIC_ORIGIN: "https://odoo.example",
      ODOO_DATABASE: "usl",
      MCP_OAUTH_ODOO_HANDOFF: "true"
    })).toThrow("MCP_OAUTH_ENABLED");
    expect(() => configuration({
      ODOO_TARGETS_JSON: JSON.stringify([{
        id: "primary",
        publicOrigin: "https://odoo.example",
        internalOrigin: "http://odoo:8069",
        databases: ["one", "two"]
      }])
    })).toThrow("exactly one Odoo target");
  });

  it("names the client from its registration, then from its identifier", () => {
    expect(oauthClientLabel("https://hub.example/client.json", "  Hub\u0000 Name ")).toBe("Hub Name");
    expect(oauthClientLabel("https://hub.example/client.json", null)).toBe("hub.example");
    expect(oauthClientLabel("local-client", null)).toBe("local-client");
    expect(oauthClientLabel(null, null)).toBe("MCP client");
    expect(oauthClientLabel("x".repeat(200), null)).toHaveLength(80);
  });
});
