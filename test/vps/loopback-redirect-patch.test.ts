import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Guards scripts/patch-better-auth-loopback.mjs. The postinstall patch makes
// the authorize-time redirect matcher treat "localhost" as loopback, the way
// the registration-time check in the same package already does. Without it a
// client registered with http://localhost/callback (Claude Code, the Claude
// desktop app) never matches its http://localhost:<port>/callback request
// and every terminal authorization fails with invalid_redirect. If this
// test fails, npm ci ran without the postinstall hook, or the dependency
// changed under the patch.
const DIST = join(process.cwd(), "node_modules/@better-auth/oauth-provider/dist");
const BUGGY = "isLoopbackIP(reg.hostname) && reg.hostname === req.hostname";
const PATCHED = '(isLoopbackIP(reg.hostname) || reg.hostname === "localhost") && reg.hostname === req.hostname';

function occurrences(needle: string): number {
  return readdirSync(DIST)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => readFileSync(join(DIST, name), "utf8").split(needle).length - 1)
    .reduce((sum, count) => sum + count, 0);
}

describe("better-auth loopback redirect patch", () => {
  it("the installed oauth-provider carries the localhost loopback rule", () => {
    expect(occurrences(PATCHED)).toBe(1);
    expect(occurrences(BUGGY)).toBe(0);
  });
});
