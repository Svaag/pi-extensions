# SDK Integration

The package core has no Pi dependency. Hosts supply candidates, an optional store/telemetry sink, transient task features, and observations.

```ts
import {
  DEFAULT_ROUTER_CONFIG,
  ModelRoutingEngine,
  SqliteRouterStore,
} from "@svaag/pi-model-router";

const store = new SqliteRouterStore({
  path: "/safe/private/state/router.db",
  halfLifeDays: 30,
  rawRetentionDays: 90,
});

const engine = new ModelRoutingEngine({
  config: DEFAULT_ROUTER_CONFIG,
  store,
  // Supply an HMAC callback to enable privacy-safe project overlays.
  hashProject: project => machineHmac("project", project),
});

const decision = await engine.route({
  host: "sdk",
  granularity: "run",
  projectKey: transientProjectIdentity,
  taskName: "review-auth",
  prompt: transientPrompt,
  writeMode: "read_only",
  tools: ["read", "bash"],
  modality: "text",
  estimatedContextTokens: 12_000,
  currentModel: "provider/current-model",
  currentThinkingLevel: "medium",
  candidates: authenticatedEnabledCandidates,
});

const result = await executeWithModel(
  decision.executedModel,
  decision.executedThinkingLevel,
);

await engine.observe({
  routeId: decision.routeId,
  outcome: "succeeded",
  latencyMs: result.latencyMs,
  firstTokenMs: result.firstTokenMs,
  inputTokens: result.usage.input,
  outputTokens: result.usage.output,
  costUsd: result.usage.cost,
});

await engine.recordQuality(decision.routeId, validatorScore, "validator");
```

The prompt is consumed only by deterministic feature extraction and is absent from `RouteDecision` and storage. Do not put content in `metadata` or identifiers.

## Failure domains

Always classify failures when possible:

```ts
await engine.observe({
  routeId,
  outcome: "failed",
  failureDomain: "host" // does not penalize the model
});
```

Supported domains are `model`, `provider`, `host`, `rpc`, `tool`, `policy`, `user`, `router`, and `unknown`. Set `contextOverflow: true` with `failureDomain: "model"` for its half-weight reliability update.

## RoutedSessionAdapter

`@svaag/pi-model-router/sdk` wraps an arbitrary async host operation and guarantees an observation on success or error:

```ts
import { RoutedSessionAdapter } from "@svaag/pi-model-router/sdk";

const routed = new RoutedSessionAdapter({
  engine,
  execute: ({ model, thinkingLevel }) => hostPrompt(model, thinkingLevel),
  observe: (value, elapsedMs, decision) => ({
    routeId: decision.routeId,
    outcome: "succeeded",
    latencyMs: elapsedMs,
    inputTokens: value.usage.input,
    outputTokens: value.usage.output,
    costUsd: value.usage.cost,
  }),
  classifyError: (_error, elapsedMs, decision) => ({
    routeId: decision.routeId,
    outcome: "failed",
    failureDomain: "provider",
    latencyMs: elapsedMs,
  }),
});

await routed.run(routeRequest);
```

## Subagent adapter

Import `SubagentRouterAdapter` from `@svaag/pi-model-router/subagent`. It translates the promoted extension’s legacy routing decision shape, modes, batch forks, and terminal observations into the shared engine.

## Lifecycle

Call `engine.close()` on host shutdown. SQLite and telemetry failures are non-throwing and cause conservative shadow/current-model fallback.
