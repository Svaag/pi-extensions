import assert from "node:assert/strict";
import test from "node:test";
import { SubagentRouterAdapter } from "../model-router/src/adapters/subagent/SubagentRouterAdapter.ts";
import { ModelRoutingEngine } from "../model-router/src/core/ModelRoutingEngine.ts";
import { SqliteRouterStore } from "../model-router/src/storage/SqliteRouterStore.ts";

const models: any[] = [
	{ provider: "local-llamacpp", id: "local-model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0, output: 0 } },
	{ provider: "anthropic", id: "claude-sonnet-4-6", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 16_384, cost: { input: 3, output: 15 } },
];

function setup() {
	const store = new SqliteRouterStore({ path: ":memory:" });
	const engine = new ModelRoutingEngine({ store });
	const modelSource = {
		snapshot: async () => ({
			candidates: models.map((model) => ({ ...model, authenticated: true, available: true })),
			modelsByRef: new Map(models.map((model) => [`${model.provider}/${model.id}`, model])),
			patterns: ["*"], warnings: [],
		}),
	};
	return { store, engine, adapter: new SubagentRouterAdapter({ engine, modelSource }) };
}

const base: any = {
	cwd: "/repo", projectTrusted: true,
	modelRegistry: {}, currentModel: models[1], currentThinkingLevel: "low",
	taskName: "lookup", prompt: "Find TODO files", writeMode: "read_only",
};

test("Subagent adapter respects rollout stage for auto and explicit modes", async () => {
	const { adapter, engine } = setup();
	const managed = await adapter.resolve(base);
	assert.equal(managed.decision.rolloutStage, "shadow");
	assert.equal(managed.decision.applied, false);
	assert.equal(managed.model, "anthropic/claude-sonnet-4-6");
	assert(managed.decision.routeId);
	const auto = await adapter.resolve({ ...base, routingMode: "auto" });
	assert.equal(auto.decision.rolloutStage, "shadow");
	assert.equal(auto.decision.applied, false);
	assert.equal(auto.model, "anthropic/claude-sonnet-4-6");
	const explained = await adapter.resolve({ ...base, routingMode: "explain" });
	assert.equal(explained.decision.applied, false);
	assert.equal(explained.decision.reason, "explain_only");
	await engine.close();
});

test("batch forks create unique observable routes while preserving one model choice", async () => {
	const { adapter, store, engine } = setup();
	const job = await adapter.resolve({ ...base, batch: { source: "csv", itemCount: 2 }, routingMode: "auto" });
	const first = await adapter.forkBatchDecision(job.decision);
	const second = await adapter.forkBatchDecision(job.decision);
	assert(first.routeId && second.routeId && first.routeId !== second.routeId);
	assert.equal(first.batchDecisionId, job.decision.routeId);
	assert.equal(first.executedModel, job.decision.executedModel);
	await adapter.observeTerminal({ routeId: first.routeId, outcome: "succeeded", latencyMs: 10, costUsd: 0 });
	await adapter.observeTerminal({ routeId: second.routeId, outcome: "failed", failureDomain: "host", latencyMs: 5 });
	const summary = store.getSummary();
	assert.equal(summary.ok && summary.value.totalObservations, 2);
	const stats = store.listArmStatistics();
	assert.equal(stats.ok, true);
	if (stats.ok) {
		const global = stats.value.filter((item) => !item.projectHash);
		assert(global.some((item) => item.completedCount > 1.9));
		assert(global.some((item) => item.attributableCount > 0.9 && item.attributableCount < 1.1));
	}
	await engine.close();
});
