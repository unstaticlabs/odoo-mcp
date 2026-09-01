// Patches @better-auth/oauth-provider@1.7.2 after every install.
//
// The authorize-time redirect_uri matcher (findRegisteredRedirectUri) applies
// the RFC 8252 port-agnostic loopback rule only when isLoopbackIP(hostname)
// is true. isLoopbackIP("localhost") is false, so a client registered with
// http://localhost/callback — Claude Code and the Claude desktop app publish
// exactly that in https://claude.ai/oauth/claude-code-client-metadata — never
// matches its http://localhost:<random-port>/callback request, and every
// terminal authorization fails with invalid_redirect. The registration-time
// check in the same file already treats "localhost" as loopback
// (`isLoopbackIP(url.hostname) || url.hostname === "localhost"`); this patch
// copies that rule into the matcher and changes nothing else.
//
// The patch REFUSES to guess: it requires exactly one occurrence of the buggy
// expression across the package's dist files and fails the install when the
// count is off, so a dependency bump cannot silently ship unpatched or
// double-patched code. Remove this file, its package.json postinstall hook,
// and the Dockerfile `COPY scripts` line when upstream fixes the matcher.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUGGY = "isLoopbackIP(reg.hostname) && reg.hostname === req.hostname";
const PATCHED = '(isLoopbackIP(reg.hostname) || reg.hostname === "localhost") && reg.hostname === req.hostname';

const dist = join(process.cwd(), "node_modules/@better-auth/oauth-provider/dist");
let files;
try {
  files = readdirSync(dist).filter((name) => name.endsWith(".mjs"));
} catch {
  console.error(`patch-better-auth-loopback: ${dist} is not readable — is @better-auth/oauth-provider installed?`);
  process.exit(1);
}

let buggy = 0;
let patched = 0;
const targets = [];
for (const name of files) {
  const path = join(dist, name);
  const text = readFileSync(path, "utf8");
  patched += text.split(PATCHED).length - 1;
  const count = text.split(BUGGY).length - 1;
  if (count > 0) targets.push({ path, text, count });
  buggy += count;
}

if (buggy === 0 && patched === 1) {
  process.exit(0);
}
if (buggy !== 1 || patched !== 0) {
  console.error(
    `patch-better-auth-loopback: expected exactly one buggy site and no patched site, found buggy=${buggy} patched=${patched}.\n` +
      "The @better-auth/oauth-provider dist changed. Check whether upstream fixed findRegisteredRedirectUri; " +
      "then update or remove this patch.",
  );
  process.exit(1);
}

const target = targets[0];
writeFileSync(target.path, target.text.replace(BUGGY, PATCHED));
console.log(`patch-better-auth-loopback: patched ${target.path}`);
