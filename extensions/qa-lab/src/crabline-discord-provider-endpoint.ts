import fs from "node:fs";
import path from "node:path";
import {
  setDiscordProviderEndpointDescriptor,
  type DiscordProviderEndpointDescriptor,
} from "@openclaw/discord/test-api.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CRABLINE_DISCORD_PROVIDER_ENDPOINT_ARTIFACT } from "./crabline-discord-provider-endpoint-artifact.js";

const QA_TEMP_ROOT_ENV = "OPENCLAW_QA_TEMP_ROOT";
const DESCRIPTOR_KEYS = ["gatewayBotUrl", "gatewayOrigin", "restApiBaseUrl"];

function readDescriptor(value: unknown): DiscordProviderEndpointDescriptor {
  if (
    !isRecord(value) ||
    Object.keys(value).toSorted().join("\0") !== DESCRIPTOR_KEYS.join("\0") ||
    typeof value.restApiBaseUrl !== "string" ||
    typeof value.gatewayBotUrl !== "string" ||
    typeof value.gatewayOrigin !== "string"
  ) {
    throw new Error("Crabline Discord provider endpoint artifact is invalid");
  }
  return {
    restApiBaseUrl: value.restApiBaseUrl,
    gatewayBotUrl: value.gatewayBotUrl,
    gatewayOrigin: value.gatewayOrigin,
  };
}

export function registerCrablineDiscordProviderEndpoint(api: OpenClawPluginApi): void {
  if (api.registrationMode !== "full") {
    return;
  }
  const tempRoot = process.env[QA_TEMP_ROOT_ENV]?.trim();
  if (!tempRoot) {
    return;
  }
  const artifactPath = path.join(tempRoot, CRABLINE_DISCORD_PROVIDER_ENDPOINT_ARTIFACT);
  let serialized: string;
  try {
    serialized = fs.readFileSync(artifactPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const descriptor = readDescriptor(JSON.parse(serialized));
  // Install before channel startup; Discord seals this process-lifetime bootstrap on activation.
  setDiscordProviderEndpointDescriptor(descriptor);
}
