/* Smoke: verifies the subagent router wiring (engine + OTel telemetry) exports
 * metadata-only metrics/traces to the local collector on 127.0.0.1:4318. */
import { ModelRoutingEngine } from "../model-router/src/core/ModelRoutingEngine.ts";
import { SqliteRouterStore } from "../model-router/src/storage/SqliteRouterStore.ts";
import { createOpenTelemetryRouterTelemetry, createRouterTelemetryPrivacy } from "../model-router/src/telemetry/index.ts";
import type { RoutingCandidate } from "../model-router/src/core/types.ts";

const candidates: RoutingCandidate[] = [
	{ provider: "local-llamacpp", id: "local-model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0, output: 0 }, authenticated: true, available: true },
	{ provider: "anthropic", id: "claude-sonnet-4-6", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 16_384, cost: { input: 3, output: 15 }, authenticated: true, available: true },
];

const privacy = await createRouterTelemetryPrivacy({ agentDir: `${process.env.HOME}/.pi/agent` });
const telemetry = await createOpenTelemetryRouterTelemetry({ enabled: true, requestedEnabled: true }, { privacy });
console.log("health before:", JSON.stringify(telemetry.getHealth()));

const store = new SqliteRouterStore({ path: ":memory:" });
const router = new ModelRoutingEngine({ store, telemetry });

const decision = await router.route({
	host: "sdk",
	prompt: "Smoke test route for telemetry verification. Return paths only.",
	taskName: "telemetry-smoke",
	writeMode: "read_only",
	modality: "text",
	candidates,
	currentModel: "anthropic/claude-sonnet-4-6",
	currentThinkingLevel: "low",
	forceMode: "auto",
});
console.log("routed:", decision.executedModel, "arm:", decision.arm);
await router.observe({ routeId: decision.routeId, outcome: "succeeded", latencyMs: 42, costUsd: 0 });

await telemetry.forceFlush();
console.log("health after flush:", JSON.stringify(telemetry.getHealth()));
await router.close();
console.log("done");
