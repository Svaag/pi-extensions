import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ROUTER_CONFIG } from "../model-router/src/config/defaults.ts";
import { createStoreJudgeBudgetCallbacks, QualityJudge } from "../model-router/src/judge/QualityJudge.ts";
import { SqliteRouterStore } from "../model-router/src/storage/SqliteRouterStore.ts";

function config(overrides: Partial<typeof DEFAULT_ROUTER_CONFIG.judge> = {}) {
	return { ...DEFAULT_ROUTER_CONFIG.judge, enabled: true, model: "judge/provider-model", ...overrides };
}

const valid = JSON.stringify({ correctness: 1, completeness: 0.8, relevance: 0.9, safety: 1 });

test("judge applies strict sampling, exclusions, model validation, and weighted labels", async () => {
	let invoked = 0;
	const judge = new QualityJudge({
		config: config(),
		sampleValue: () => 0,
		invoke: async ({ prompt }) => { invoked += 1; assert(!prompt.includes("tool_result")); return { text: valid, costUsd: 0.001 }; },
	});
	const base = { routeId: "route", evaluatedModel: "target/model", complexityTier: "simple" as const, sensitive: false, prompt: "request", output: "answer" };
	const labelled = await judge.evaluate(base);
	assert.equal(labelled.status, "labelled");
	assert.equal(labelled.label?.source, "judge");
	assert.equal(labelled.label?.weight, 0.35);
	assert.equal(invoked, 1);
	assert.equal((await judge.evaluate({ ...base, routeId: "critical", complexityTier: "critical" })).reason, "critical");
	assert.equal((await judge.evaluate({ ...base, routeId: "sensitive", sensitive: true })).reason, "sensitive");
	const same = new QualityJudge({ config: config({ model: "target/model" }), sampleValue: () => 0, invoke: async () => valid });
	assert.equal((await same.evaluate(base)).reason, "same_model");
});

test("judge caps sample rate, per-call cost, daily persistent budget, and invalid output", async () => {
	const notSampled = new QualityJudge({ config: config({ sampleRate: 1 }), sampleValue: () => 0.06, invoke: async () => valid });
	assert.equal((await notSampled.evaluate({ routeId: "r", evaluatedModel: "target", complexityTier: "simple", sensitive: false, prompt: "p", output: "o" })).reason, "not_sampled");

	const expensive = new QualityJudge({ config: config(), sampleValue: () => 0, invoke: async () => valid });
	assert.equal((await expensive.evaluate({ routeId: "r", evaluatedModel: "target", complexityTier: "simple", sensitive: false, prompt: "p", output: "o", estimatedCostUsd: 0.006 })).reason, "per_evaluation_budget");

	const store = new SqliteRouterStore({ path: ":memory:" });
	store.initialize();
	const budget = createStoreJudgeBudgetCallbacks(store, 0.005);
	const persistent = new QualityJudge({ config: config({ maxDailyCostUsd: 0.005 }), sampleValue: () => 0, budget, invoke: async () => valid });
	const request = { routeId: "one", evaluatedModel: "target", complexityTier: "simple" as const, sensitive: false, prompt: "p", output: "o", estimatedCostUsd: 0.005 };
	assert.equal((await persistent.evaluate(request)).status, "labelled");
	assert.equal((await persistent.evaluate({ ...request, routeId: "two" })).reason, "daily_budget");
	store.close();

	const invalid = new QualityJudge({ config: config(), sampleValue: () => 0, invoke: async () => "```json\n{}\n```" });
	assert.equal((await invalid.evaluate(request)).reason, "invalid_json");
});

test("judge calibration disables updates after biased overlapping labels", async () => {
	const judge = new QualityJudge({ config: config(), sampleValue: () => 0, invoke: async () => valid });
	for (let index = 0; index < 30; index += 1) judge.recordCalibration(1, 0);
	const state = judge.getCalibrationState();
	assert.equal(state.pairCount, 30);
	assert.equal(state.updatesEnabled, false);
	assert.equal(state.disabledReason, "mae");
	const result = await judge.evaluate({ routeId: "r", evaluatedModel: "target", complexityTier: "simple", sensitive: false, prompt: "p", output: "o" });
	assert.equal(result.status, "diagnostic");
	assert.equal(result.label, undefined);
});
