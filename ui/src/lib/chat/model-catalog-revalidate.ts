import { resolveGatewayStartupRetryAfterMs } from "@openclaw/gateway-protocol/startup-unavailable";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { loadModels, type ModelCatalogScope } from "./model-catalog-store.ts";

// Match the Gateway client's default request deadline. The catalog-store test
// pins this value to DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS so contract drift fails CI.
const MODEL_CATALOG_REQUEST_TIMEOUT_MS = 30_000;

export async function revalidateModels(
  client: GatewayBrowserClient,
  opts: ModelCatalogScope & { startupRetryWindowMs?: number },
): Promise<ModelCatalogEntry[]> {
  const retryWindowMs = opts.startupRetryWindowMs;
  if (retryWindowMs === undefined) {
    return loadModels(client, { ...opts, rejectOnFailure: true }, true);
  }
  const deadlineAt = Date.now() + retryWindowMs;
  let latestError: Error | undefined;
  for (;;) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw latestError ?? new Error("Model catalog retry deadline elapsed");
    }
    try {
      return await loadModels(
        client,
        { ...opts, rejectOnFailure: true },
        true,
        Math.min(remainingMs, MODEL_CATALOG_REQUEST_TIMEOUT_MS),
      );
    } catch (error) {
      const requestError =
        error instanceof Error
          ? error
          : new Error("Model catalog request failed", { cause: error });
      const retryAfterMs = resolveGatewayStartupRetryAfterMs(requestError);
      if (retryAfterMs === null) {
        throw requestError;
      }
      latestError = requestError;
      const delayMs = Math.min(retryAfterMs, deadlineAt - Date.now());
      if (delayMs <= 0) {
        throw requestError;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
}
