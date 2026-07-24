import assert from "node:assert/strict";
import test from "node:test";
import { ModelRoutingEngine } from "../model-router/src/core/ModelRoutingEngine.ts";
import { evaluateRollout } from "../model-router/src/core/rollout.ts";
import { criticalArmHasEvidence } from "../model-router/src/core/constraints.ts";
import { DEFAULT_ROUTER_CONFIG } from "../model-router/src/config/defaults.ts";
import { SqliteRouterStore } from "../model-router/src/storage/SqliteRouterStore.ts";
import type { RouteRequest, RoutingCandidate } from "../model-router/src/core/types.ts";

const candidates: RoutingCandidate[] = [
	{ provider: "local-llamacpp", id: "local-model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0, output: 0 }, authenticated: true, available: true },
	{ provider: "anthropic", id: "claude-sonnet-4-6", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 16_384, cost: { input: 3, output: 15 }, authenticated: true, available: true },
];

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
	return {
		host: "sdk",
		prompt: "Find files that mention TODO. Return paths only.",
		taskName: "lookup",
		writeMode: "read_only",
		modality: "text",
		candidates,
		currentModel: "anthropic/claude-sonnet-4-6",
		currentThinkingLevel: "low",
		...overrides,
	};
}

function engine() {
	const store = new SqliteRouterStore({ path: ":memory:" });
	return { store, router: new ModelRoutingEngine({ store, newRouteId: (() => { let id = 0; return () => `route-${++id}`; })() }) };
}

test("shadow recommends without changing the baseline, while forced routing applies", async () => {
	const { router } = engine();
	const shadow = await router.route(request());
	assert.equal(shadow.stage, "shadow");
	assert.equal(shadow.applied, false);
	assert.equal(shadow.executedModel, "anthropic/claude-sonnet-4-6");
	assert.equal(shadow.selectedModel, "local-llamacpp/local-model");
	const forced = await router.route(request({ forceMode: "auto" }));
	assert.equal(forced.arm, "forced");
	assert.equal(forced.applied, true);
	assert.equal(forced.executedModel, "local-llamacpp/local-model");
	await router.close();
});

test("explicit model and thinking override every learned recommendation", async () => {
	const { router } = engine();
	const result = await router.route(request({ explicitModel: "anthropic/claude-sonnet-4-6", explicitThinkingLevel: "xhigh", forceMode: "auto" }));
	assert.equal(result.selectedModel, "anthropic/claude-sonnet-4-6");
	assert.equal(result.selectedThinkingLevel, "xhigh");
	assert.equal(result.executedModel, "anthropic/claude-sonnet-4-6");
	await router.close();
});

test("host failures do not penalize model reliability and provider failures open a circuit", async () => {
	const { router, store } = engine();
	const first = await router.route(request({ forceMode: "auto", explicitModel: "local-llamacpp/local-model", explicitThinkingLevel: "off" }));
	await router.observe({ routeId: first.routeId, outcome: "failed", failureDomain: "host", latencyMs: 5 });
	const firstCandidate = first.candidates.find((item) => item.model === first.executedModel)!;
	const statsAfterHost = store.listArmStatistics();
	assert.equal(statsAfterHost.ok, true);
	if (statsAfterHost.ok) assert.equal(statsAfterHost.value.find((item) => item.modelFingerprint === firstCandidate.fingerprint)?.attributableCount, 0);
	for (let index = 0; index < 3; index += 1) {
		const decision = await router.route(request({ forceMode: "auto", explicitModel: "local-llamacpp/local-model", explicitThinkingLevel: "off" }));
		await router.observe({ routeId: decision.routeId, outcome: "failed", failureDomain: "provider" });
	}
	const circuit = store.getCircuitBreaker(firstCandidate.fingerprint);
	assert.equal(circuit.ok && Boolean(circuit.value?.openedAt), true);
	await router.close();
});

test("quality feedback updates quality separately from operational success", async () => {
	const { router, store } = engine();
	const decision = await router.route(request({ forceMode: "auto" }));
	await router.observe({ routeId: decision.routeId, outcome: "succeeded", latencyMs: 100, costUsd: 0 });
	await router.recordQuality(decision.routeId, 0, "user");
	const stats = store.listArmStatistics();
	assert.equal(stats.ok, true);
	if (stats.ok) {
		const arm = stats.value.find((item) => item.model === decision.executedModel && !item.projectHash)!;
		assert(Math.abs(arm.attributableCount - 1) < 1e-6);
		assert(Math.abs(arm.qualityLabelCount - 1) < 1e-6);
		assert(Math.abs(arm.humanValidatorLabelCount - 1) < 1e-6);
	}
	await router.close();
});

test("rollout remains shadow at zero samples and promotes only when gates pass", () => {
	const state = { scopeKey: "sdk:run:balanced", stage: "shadow" as const, enteredAt: 0, updatedAt: 0, softRegressionWindows: 0 };
	const empty = {
		completed: 0, qualityLabels: 0, outcomesKnown: 0, costKnown: 0, latencyKnown: 0, candidateArms: 0,
		treatment: 0, control: 0, treatmentQualityLabels: 0, controlQualityLabels: 0,
		treatmentReliabilityAlpha: 1, treatmentReliabilityBeta: 1, controlReliabilityAlpha: 1, controlReliabilityBeta: 1,
		treatmentQualityAlpha: 1, treatmentQualityBeta: 1, controlQualityAlpha: 1, controlQualityBeta: 1,
		dataIntegrityOk: true,
	};
	assert.equal(evaluateRollout(state, empty, DEFAULT_ROUTER_CONFIG).nextStage, "shadow");
	const ready = { ...empty, completed: 100, qualityLabels: 10, outcomesKnown: 100, costKnown: 100, latencyKnown: 100, candidateArms: 2 };
	assert.equal(evaluateRollout(state, ready, DEFAULT_ROUTER_CONFIG).nextStage, "explore");
});

test("aggregate explore gates promote and two soft regression windows roll auto back", () => {
	const evidence = {
		completed: 200, qualityLabels: 40, outcomesKnown: 200, costKnown: 200, latencyKnown: 200, candidateArms: 2,
		treatment: 100, control: 100, treatmentQualityLabels: 20, controlQualityLabels: 20,
		treatmentReliabilityAlpha: 99, treatmentReliabilityBeta: 1, controlReliabilityAlpha: 94, controlReliabilityBeta: 6,
		treatmentQualityAlpha: 20, treatmentQualityBeta: 1, controlQualityAlpha: 14, controlQualityBeta: 6,
		treatmentCostPerSuccess: 0.8, controlCostPerSuccess: 1,
		treatmentP95LatencyMs: 900, controlP95LatencyMs: 1_000,
		dataIntegrityOk: true,
	};
	const explore = { scopeKey: "sdk:run:balanced", stage: "explore" as const, enteredAt: 0, updatedAt: 0, softRegressionWindows: 0 };
	assert.equal(evaluateRollout(explore, evidence, DEFAULT_ROUTER_CONFIG, 8 * 86_400_000).nextStage, "auto");
	const auto = { ...explore, stage: "auto" as const, softRegressionWindows: 1 };
	const regressed = { ...evidence, treatmentCostPerSuccess: 1.3, treatmentP95LatencyMs: 1_300 };
	assert.equal(evaluateRollout(auto, regressed, DEFAULT_ROUTER_CONFIG, 8 * 86_400_000).nextStage, "explore");
});

test("critical exploitation requires strict reliability and human/validator evidence", () => {
	const weak = { qualityMean: 0.99, reliabilityMean: 0.999, qualitySamples: 100, reliabilitySamples: 100, humanValidatorLabels: 0, costSamples: 1, latencySamples: 1 };
	assert.equal(criticalArmHasEvidence(weak, DEFAULT_ROUTER_CONFIG), false);
	assert.equal(criticalArmHasEvidence({ ...weak, humanValidatorLabels: 20 }, DEFAULT_ROUTER_CONFIG), true);
});
