import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/timeouts";
import { resolveGatewayStartupRetryAfterMs } from "@openclaw/gateway-protocol/startup-unavailable";

export async function retryGatewayStartupRequest<T>(params: {
  retryWindowMs: number;
  request: (remainingMs: number) => Promise<T>;
  requestFailure: (error: unknown) => Error;
  timeoutMessage: string;
}): Promise<T> {
  const deadlineAt = Date.now() + params.retryWindowMs;
  let latestError: Error | undefined;
  for (;;) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw latestError ?? new Error(params.timeoutMessage);
    }
    try {
      return await params.request(Math.min(remainingMs, DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS));
    } catch (error) {
      const requestError = params.requestFailure(error);
      const retryAfterMs = resolveGatewayStartupRetryAfterMs(requestError);
      if (retryAfterMs === null) {
        throw requestError;
      }
      latestError = requestError;
      const retryRemainingMs = deadlineAt - Date.now();
      if (retryRemainingMs <= 0) {
        throw latestError;
      }
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, Math.min(retryAfterMs, retryRemainingMs));
      });
    }
  }
}
