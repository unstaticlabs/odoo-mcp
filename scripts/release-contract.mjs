#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(`release contract: ${message}`); };
const sortedUnique = (value) => Array.isArray(value) && value.length > 0
  && value.every((item) => typeof item === "string" && item.length > 0)
  && JSON.stringify(value) === JSON.stringify([...new Set(value)].sort());

export function loadCompatibility(root = process.cwd()) {
  const path = resolve(root, "release/compatibility.json");
  const raw = readFileSync(path, "utf8");
  const value = JSON.parse(raw);
  const expected = ["oauth_vault", "required_actions", "required_agent_identity", "required_modules", "required_public_methods", "schema", "server_version", "supported_odoo_series"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) fail("compatibility fields differ");
  if (value.schema !== "usl-odoo-mcp-compatibility/v2") fail("compatibility schema is invalid");
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (value.server_version !== pkg.version) fail("server version differs from package.json");
  for (const key of ["supported_odoo_series", "required_modules", "required_public_methods", "required_actions"]) {
    if (!sortedUnique(value[key])) fail(`${key} must be sorted and unique`);
  }
  const identity = value.required_agent_identity;
  const identityKeys = ["fields", "method", "principal_kind", "schema_version"];
  if (!identity || JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(identityKeys)) fail("required_agent_identity fields differ");
  if (identity.method !== "usl.agent.current_identity" || identity.principal_kind !== "agent" || !Number.isInteger(identity.schema_version) || identity.schema_version < 1) fail("required_agent_identity is invalid");
  if (!sortedUnique(identity.fields) || !identity.fields.includes("owner") || !identity.fields.includes("effective_applications")) fail("required_agent_identity fields are invalid");
  const sourceActions = new Set();
  for (const name of readdirSync(resolve(root, "src/capabilities"))) {
    if (!name.endsWith(".ts")) continue;
    const source = readFileSync(resolve(root, "src/capabilities", name), "utf8");
    const pattern = /client\.call(?:<[^;]*?>)?\(context,\s*"([^"]+)",\s*"([^"]+)"/gs;
    for (const match of source.matchAll(pattern)) sourceActions.add(`${match[1]}.${match[2]}`);
  }
  const missingActions = [...sourceActions].filter((action) => !value.required_actions.includes(action)).sort();
  if (missingActions.length) fail(`literal capability actions are missing: ${missingActions.join(", ")}`);
  if (value.oauth_vault?.schema_version !== 1 || value.oauth_vault?.migration !== "npm run oauth:migrate") fail("OAuth vault migration contract is invalid");
  return { value, raw, digest: sha256(raw) };
}

export function createRelease({ commit, image, evidence }, root = process.cwd()) {
  if (!/^[0-9a-f]{40}$/.test(commit)) fail("commit must be a full Git SHA");
  if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(image)) fail("image must use an immutable digest");
  if (!/^[0-9a-f]{64}$/.test(evidence)) fail("qualification evidence digest is invalid");
  const compatibility = loadCompatibility(root);
  return {
    schema: "usl-odoo-mcp-oci-release/v2",
    source: { repository: "https://github.com/unstaticlabs/odoo-mcp.git", ref: "refs/heads/main", commit },
    image: { digest_reference: image },
    compatibility: { ...compatibility.value, sha256: compatibility.digest },
    qualification: { evidence_sha256: evidence },
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--check") {
    process.stdout.write(`${loadCompatibility().digest}\n`);
    return;
  }
  const values = {};
  for (let index = 0; index < args.length; index += 2) values[args[index]?.replace(/^--/, "")] = args[index + 1];
  if (!values.commit || !values.image || !values.evidence || !values.output) fail("commit, image, evidence and output are required");
  writeFileSync(values.output, `${JSON.stringify(createRelease(values), null, 2)}\n`, { mode: 0o644 });
}

if (process.argv[1]?.endsWith("release-contract.mjs")) main();
