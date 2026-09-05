import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";


const root = resolve(import.meta.dirname, "../..");
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const release = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");


describe("CI workflow contracts", () => {
  it("keeps check as the pull-request gate and shares Buildx layers", () => {
    expect(ci).toContain("  check:\n");
    expect(ci).toContain("docker/build-push-action@");
    expect(ci).toContain("cache-from: type=gha,scope=odoo-mcp");
    expect(ci).toContain("cache-to: type=gha,mode=max,scope=odoo-mcp");
  });

  it("tests before publish without repeating host-side qualification", () => {
    const testJob = release.split("  test:\n", 2)[1]!.split("\n  publish:\n", 1)[0]!;
    const publishJob = release.split("\n  publish:\n", 2)[1]!;

    for (const command of (
      ["npm ci", "npm run typecheck", "npm test", "npm run build", "node dist/evals/cli.js validate"]
    )) {
      expect(testJob).toContain(command);
      expect(publishJob).not.toContain(command);
    }
    expect(publishJob).toContain("needs: test");
    expect(publishJob).toContain("needs.test.outputs.evidence_sha256");
    expect(publishJob).toContain("cache-from: type=gha,scope=odoo-mcp");
  });
});
