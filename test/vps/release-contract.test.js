import { describe, expect, it } from "vitest";
import { createRelease, loadCompatibility } from "../../scripts/release-contract.mjs";
import { IMAGE_SOURCE, validateImageLabels } from "../../scripts/image-identity.mjs";

const commit = "a".repeat(40);
const input = "d".repeat(64);
const labels = {
  "org.opencontainers.image.source": IMAGE_SOURCE,
  "org.opencontainers.image.revision": commit,
  "com.unstaticlabs.component.input-sha256": input,
};

describe("MCP release contract", () => {
  it("binds compatibility and qualification to an immutable image", () => {
    const release = createRelease({
      commit,
      image: `ghcr.io/unstaticlabs/odoo-mcp@sha256:${"b".repeat(64)}`,
      input,
      evidence: "c".repeat(64),
    });
    expect(release.schema).toBe("usl-odoo-mcp-oci-release/v2");
    expect(release.compatibility.sha256).toBe(loadCompatibility().digest);
    expect(release.image).toEqual({
      digest_reference: `ghcr.io/unstaticlabs/odoo-mcp@sha256:${"b".repeat(64)}`,
      source_repository: IMAGE_SOURCE,
      source_commit: commit,
      input_sha256: input,
    });
    expect(release.compatibility.required_actions).toContain("usl.document.mcp_create_download_grant");
    expect(release.compatibility.required_actions).toContain("usl.document.mcp_revoke_download_grant");
    expect(release.compatibility.oauth_vault.schema_version).toBe(1);
    expect(release.compatibility.required_agent_identity).toMatchObject({
      method: "usl.agent.current_identity",
      principal_kind: "agent",
      schema_version: 3,
    });
  });

  it("rejects mutable image tags", () => {
    expect(() => createRelease({
      commit, image: "ghcr.io/unstaticlabs/odoo-mcp:latest", input, evidence: "c".repeat(64),
    })).toThrow(/immutable digest/);
  });

  it("accepts only the exact source, revision and component inputs", () => {
    expect(validateImageLabels(labels, { commit, inputDigest: input })).toBe(true);
    expect(() => validateImageLabels({ ...labels, "org.opencontainers.image.revision": "b".repeat(40) }, { commit, inputDigest: input })).toThrow(/revision differs/);
    expect(() => validateImageLabels({ ...labels, "org.opencontainers.image.source": "https://example.invalid/repository.git" }, { commit, inputDigest: input })).toThrow(/repository differs/);
    expect(() => validateImageLabels({ ...labels, "com.unstaticlabs.component.input-sha256": "e".repeat(64) }, { commit, inputDigest: input })).toThrow(/input digest differs/);
  });
});
