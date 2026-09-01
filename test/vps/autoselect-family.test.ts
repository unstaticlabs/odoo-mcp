import { getDefaultAutoSelectFamily } from "node:net";
import { describe, expect, it } from "vitest";
import "../../src/auth/oauth.js";

// Guards the CIMD workaround in src/auth/oauth.ts. The @better-auth/cimd
// node transport pins one DNS answer through a scalar `lookup` callback,
// and an autoselecting socket (Node >= 20 default) rejects that shape with
// ERR_INVALID_IP_ADDRESS — which kills every hosted CIMD authorization.
// If this test fails, the module-scope setDefaultAutoSelectFamily(false)
// was removed before the upstream transport learned the `all` contract.
describe("cimd socket family workaround", () => {
  it("loading the oauth module disables socket family autoselection", () => {
    expect(getDefaultAutoSelectFamily()).toBe(false);
  });
});
