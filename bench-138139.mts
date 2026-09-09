// Temporary before/after benchmark for #138139 (not committed).
import { performance } from "node:perf_hooks";
import { providerConfigMatchesRuntimeSnapshot } from "./src/agents/model-auth-provider-config.js";
import { selectApplicableRuntimeConfig } from "./src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "./src/config/types.js";

const CATALOG_ROWS = 400;
const AGENTS = 11;
const PROVIDERS = 8;

function createLargeConfig(): OpenClawConfig {
  const providers: Record<string, unknown> = {};
  for (let p = 0; p < PROVIDERS; p += 1) {
    const id = p === 0 ? "openrouter" : `provider-${p}`;
    providers[id] = {
      baseUrl: `https://provider-${p}.example/v1`,
      apiKey: `sk-synthetic-${p}`,
      models: Array.from({ length: p === 0 ? CATALOG_ROWS : 8 }, (_, index) => ({
        id: `${id}-model-${index}`,
        name: `Synthetic ${index}`,
        reasoning: index % 2 === 0,
        input: ["text"],
        cost: { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      })),
    };
  }
  const agents: Record<string, unknown> = {};
  for (let a = 0; a < AGENTS; a += 1) {
    agents[`agent-${a}`] = { model: "openrouter-model-0", workspace: `/tmp/agent-${a}` };
  }
  return { models: { providers }, agents } as OpenClawConfig;
}

function timeIt(label: string, iterations: number, fn: () => void): void {
  for (let i = 0; i < 3; i += 1) {
    fn();
  }
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    fn();
  }
  const elapsed = performance.now() - started;
  console.log(
    JSON.stringify({
      label,
      iterations,
      elapsedMs: Number(elapsed.toFixed(2)),
      perCallMs: Number((elapsed / iterations).toFixed(3)),
    }),
  );
}

const runtime = createLargeConfig();
const input = structuredClone(runtime);
const source = structuredClone(runtime);

timeIt("provider-compare/equivalent-clones", 100, () => {
  if (
    !providerConfigMatchesRuntimeSnapshot({
      inputConfig: input,
      runtimeConfig: runtime,
      provider: "openrouter",
    })
  ) {
    throw new Error("expected equivalent providers to match");
  }
});

timeIt("select-applicable/equivalent-distinct", 100, () => {
  if (
    selectApplicableRuntimeConfig({
      inputConfig: input,
      runtimeConfig: runtime,
      runtimeSourceConfig: source,
    }) !== runtime
  ) {
    throw new Error("expected runtime selection");
  }
});

timeIt("provider-compare/early-difference", 100, () => {
  const mutated = structuredClone(runtime);
  (mutated.models!.providers!.openrouter.models as { id: string }[])[0]!.id = "different";
  if (
    providerConfigMatchesRuntimeSnapshot({
      inputConfig: mutated,
      runtimeConfig: runtime,
      provider: "openrouter",
    })
  ) {
    throw new Error("expected providers to differ");
  }
});
