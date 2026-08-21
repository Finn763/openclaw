#!/usr/bin/env node

import { appendFileSync, lstatSync, readFileSync } from "node:fs";

const MAX_MANIFEST_BYTES = 8 * 1024;
const EXPECTED_SCHEMA = "openclaw.repo-e2e-capabilities/v1";
const EXPECTED_ROOT_KEYS = ["repoE2eShards", "schema", "schemaVersion"];
const EXPECTED_SHARD_KEYS = [
  "agentPluginGateway",
  "gatewayShards",
  "realGatewayUi",
  "runtimeBuildProfile",
  "sandboxArtifact",
  "uiShards",
];

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: validate-repo-e2e-capability.mjs --manifest <path> --github-output <path> --github-step-summary <path>",
      );
    }
    values.set(name, value);
  }
  for (const required of ["--manifest", "--github-output", "--github-step-summary"]) {
    if (!values.has(required)) {
      throw new Error(`${required} is required`);
    }
  }
  return values;
}

function hasExactKeys(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).toSorted();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function validateManifest(manifestPath) {
  let stat;
  try {
    stat = lstatSync(manifestPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { available: false, reason: "missing" };
    }
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
    return { available: false, reason: "invalid" };
  }

  let value;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { available: false, reason: "invalid" };
  }
  if (!hasExactKeys(value, EXPECTED_ROOT_KEYS)) {
    return { available: false, reason: "invalid" };
  }
  if (value.schema !== EXPECTED_SCHEMA || value.schemaVersion !== 1) {
    return { available: false, reason: "unsupported" };
  }
  if (!hasExactKeys(value.repoE2eShards, EXPECTED_SHARD_KEYS)) {
    return { available: false, reason: "invalid" };
  }

  const capability = value.repoE2eShards;
  const valid =
    capability.agentPluginGateway === true &&
    capability.gatewayShards === 4 &&
    capability.realGatewayUi === true &&
    capability.runtimeBuildProfile === "repoE2eRuntime" &&
    capability.sandboxArtifact === true &&
    capability.uiShards === 4;
  return valid
    ? { available: true, reason: "contract-v1" }
    : { available: false, reason: "unsupported" };
}

const args = parseArgs(process.argv.slice(2));
const result = validateManifest(args.get("--manifest"));
const mode = result.available ? "sharded" : "legacy";
appendFileSync(
  args.get("--github-output"),
  `repo_e2e_shards_available=${result.available}\nrepo_e2e_capability_reason=${result.reason}\n`,
);
appendFileSync(
  args.get("--github-step-summary"),
  `Repo E2E mode: \`${mode}\`\nRepo E2E capability: \`${result.reason}\`\n`,
);
