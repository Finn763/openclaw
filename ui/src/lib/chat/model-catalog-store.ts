// Control UI model metadata boundary.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;

type ModelCatalogCacheEntry = {
  expiresAt: number;
  models: ModelCatalogEntry[];
  inFlight?: Promise<ModelCatalogEntry[]>;
  inFlightRefresh?: boolean;
  inFlightRejects?: boolean;
};

const modelCatalogCache = new WeakMap<GatewayBrowserClient, Map<string, ModelCatalogCacheEntry>>();

export function invalidateModelCatalogStore(client: GatewayBrowserClient): void {
  modelCatalogCache.delete(client);
}

export type ModelCatalogScope = {
  agentId: string;
  preparedOnly?: boolean;
};

type LoadModelsOptions = ModelCatalogScope & {
  refresh?: boolean;
  rejectOnFailure?: boolean;
};

function modelCatalogCacheFor(client: GatewayBrowserClient): Map<string, ModelCatalogCacheEntry> {
  let cache = modelCatalogCache.get(client);
  if (!cache) {
    cache = new Map();
    modelCatalogCache.set(client, cache);
  }
  return cache;
}

export function peekModels(
  client: GatewayBrowserClient,
  opts: ModelCatalogScope,
): ModelCatalogEntry[] | undefined {
  const cached = modelCatalogCacheFor(client).get(modelCatalogCacheKey(opts));
  return cached && cached.expiresAt > Date.now() ? cached.models : undefined;
}

function modelCatalogCacheKey(opts: ModelCatalogScope): string {
  return `${opts.agentId.trim()}\0${opts.preparedOnly ? "prepared" : "exact"}`;
}

export async function loadModels(
  client: GatewayBrowserClient,
  opts: LoadModelsOptions,
  bypassCache = opts.refresh === true,
  requestTimeoutMs?: number,
): Promise<ModelCatalogEntry[]> {
  const cache = modelCatalogCacheFor(client);
  const agentId = opts.agentId.trim();
  const rejectOnFailure = opts.rejectOnFailure === true;
  const cacheKey = modelCatalogCacheKey(opts);
  const preparedCacheKey = `${agentId}\0prepared`;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (!bypassCache && cached?.models && cached.expiresAt > now) {
    return cached.models;
  }
  if (
    cached?.inFlight &&
    cached.inFlightRejects === rejectOnFailure &&
    (!opts.refresh || cached.inFlightRefresh === true)
  ) {
    return cached.inFlight;
  }

  // The cache write happens here, gated on inFlight identity: a refresh call
  // replaces inFlight, so an older request resolving late cannot clobber the
  // fresher result with pre-mutation catalog data.
  const requestParams = {
    view: "configured",
    agentId,
    ...(opts.preparedOnly ? { preparedOnly: true } : {}),
    ...(opts.refresh ? { refresh: true } : {}),
  };
  const request =
    requestTimeoutMs === undefined
      ? client.request<{ models: ModelCatalogEntry[] }>("models.list", requestParams)
      : client.request<{ models: ModelCatalogEntry[] }>("models.list", requestParams, {
          timeoutMs: requestTimeoutMs,
        });
  const inFlight: Promise<ModelCatalogEntry[]> = request
    .then((result) => ({ models: result.models ?? [], fresh: true }))
    .catch((error: unknown) => {
      if (rejectOnFailure) {
        throw error;
      }
      // Failed loads fall back without extending the TTL so the next call retries.
      return { models: cached?.models ?? [], fresh: false };
    })
    .then((result) => {
      const latest = cache.get(cacheKey);
      if (!latest || latest.inFlight === inFlight) {
        const entry = {
          expiresAt: result.fresh ? Date.now() + MODEL_CATALOG_CACHE_TTL_MS : 0,
          models: result.models,
        };
        cache.set(cacheKey, entry);
        if (result.fresh && opts.preparedOnly !== true) {
          // An exact catalog supersedes the prepared projection. Reusing it for
          // automatic reads prevents route re-entry from restoring stale data.
          cache.set(preparedCacheKey, entry);
        }
      }
      return result.models;
    })
    .finally(() => {
      const latest = cache.get(cacheKey);
      if (latest?.inFlight === inFlight) {
        delete latest.inFlight;
      }
    });
  cache.set(cacheKey, {
    expiresAt: cached?.expiresAt ?? 0,
    models: cached?.models ?? [],
    inFlight,
    inFlightRejects: rejectOnFailure,
    ...(opts.refresh ? { inFlightRefresh: true } : {}),
  });
  return inFlight;
}
