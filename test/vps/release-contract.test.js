import { describe, expect, it } from "vitest";
import { createRelease, loadCompatibility } from "../../scripts/release-contract.mjs";

describe("MCP release contract", () => {
  it("binds compatibility and qualification to an immutable image", () => {
    const release = createRelease({
      commit: "a".repeat(40),
      image: `ghcr.io/unstaticlabs/odoo-mcp@sha256:${"b".repeat(64)}`,
      evidence: "c".repeat(64),
    });
    expect(release.schema).toBe("usl-odoo-mcp-oci-release/v2");
    expect(release.compatibility.sha256).toBe(loadCompatibility().digest);
    expect(release.compatibility.oauth_vault.schema_version).toBe(1);
    expect(release.compatibility.required_agent_identity).toMatchObject({
      method: "usl.agent.current_identity",
      principal_kind: "agent",
      schema_version: 3,
    });
  });

  it("rejects mutable image tags", () => {
    expect(() => createRelease({
      commit: "a".repeat(40), image: "ghcr.io/unstaticlabs/odoo-mcp:latest", evidence: "c".repeat(64),
    })).toThrow(/immutable digest/);
  });
});
