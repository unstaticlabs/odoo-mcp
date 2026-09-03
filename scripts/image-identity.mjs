#!/usr/bin/env node
import { readFileSync } from "node:fs";

export const IMAGE_SOURCE = "https://github.com/unstaticlabs/odoo-mcp.git";
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

const fail = (message) => { throw new Error(`image identity: ${message}`); };

export function validateImageLabels(labels, { commit, inputDigest }) {
  if (!SHA.test(commit)) fail("commit must be a full Git SHA");
  if (!DIGEST.test(inputDigest)) fail("component input digest is invalid");
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) fail("OCI labels are missing");
  if (labels["org.opencontainers.image.source"] !== IMAGE_SOURCE) fail("source repository differs");
  if (labels["org.opencontainers.image.revision"] !== commit) fail("source revision differs");
  if (labels["com.unstaticlabs.component.input-sha256"] !== inputDigest) fail("component input digest differs");
  return true;
}

function main() {
  const values = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) values[args[index]?.replace(/^--/, "")] = args[index + 1];
  if (!values.config || !values.commit || !values.input) fail("config, commit and input are required");
  const config = JSON.parse(readFileSync(values.config, "utf8"));
  validateImageLabels(config.Labels ?? config.config?.Labels, {
    commit: values.commit,
    inputDigest: values.input,
  });
  process.stdout.write("MCP OCI image identity: valid\n");
}

if (process.argv[1]?.endsWith("image-identity.mjs")) main();
