// Synchronous static-catalog fallback for context-window resolution.
//
// The discovered-token cache is only populated by the async catalog load
// (`ensureContextWindowCacheLoaded`); read-only callers that set
// `allowAsyncLoad: false` (TUI session display, flush budget math) would
// otherwise resolve nothing and fall back to the generic 200k default even
// when the published lifecycle snapshot already carries the exact static
// catalog row for the model (e.g. deepseek-v4-flash at 1M).
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeProviderId } from "./model-ref-shared.js";
import { getPreparedModelCatalogSnapshot } from "./prepared-model-catalog.js";

function bareModelId(id: string): string {
  const trimmed = id.trim();
  const slash = trimmed.indexOf("/");
  return slash > 0 ? trimmed.slice(slash + 1).trim() : trimmed;
}

export function lookupPreparedStaticContextTokens(params: {
  config?: OpenClawConfig;
  provider?: string;
  model?: string;
}): number | undefined {
  const provider = normalizeProviderId(params.provider ?? "");
  const model = bareModelId(params.model ?? "");
  if (!provider || !model) {
    return undefined;
  }
  let catalog;
  try {
    catalog = getPreparedModelCatalogSnapshot({ config: params.config });
  } catch {
    return undefined;
  }
  if (!catalog) {
    return undefined;
  }
  const normalizedModel = normalizeLowercaseStringOrEmpty(model);
  for (const rows of [catalog.entries, catalog.staticEntries ?? []]) {
    for (const entry of rows) {
      const entryProvider = normalizeProviderId(entry.provider ?? "");
      if (!entryProvider || entryProvider !== provider) {
        continue;
      }
      if (normalizeLowercaseStringOrEmpty(bareModelId(entry.id)) !== normalizedModel) {
        continue;
      }
      const value =
        typeof entry.contextTokens === "number" && entry.contextTokens > 0
          ? Math.trunc(entry.contextTokens)
          : typeof entry.contextWindow === "number" && entry.contextWindow > 0
            ? Math.trunc(entry.contextWindow)
            : undefined;
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}
