import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiModelSource } from "../model-router/src/adapters/pi/PiModelSource.ts";
import { PiRunRouter } from "../model-router/src/adapters/pi/PiRunRouter.ts";
import { ModelRoutingEngine } from "../model-router/src/core/ModelRoutingEngine.ts";
import { SqliteRouterStore } from "../model-router/src/storage/SqliteRouterStore.ts";

const models: any[] = [
	{ provider: "local-llamacpp", id: "local-model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0, output: 0 } },
	{ provider: "anthropic", id: "claude-sonnet-4-6", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 16_384, cost: { input: 3, output: 15 } },
];

test("Pi run adapter shadows, applies auto stage, aggregates observations, and honors pins", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-run-router-"));
	try {
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["local-llamacpp/*", "anthropic/*"] }));
		const store = new SqliteRouterStore({ path: ":memory:" });
		const engine = new ModelRoutingEngine({ store });
		let current = models[1];
		let thinking = "low";
		let setModelCalls = 0;
		const entries: any[] = [];
		const pi: any = {
			getActiveTools: () => ["read"],
			setModel: async (model: any) => { setModelCalls += 1; current = model; return true; },
			setThinkingLevel: (level: string) => { thinking = level; },
			getThinkingLevel: () => thinking,
			appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		};
		const registry = {
			getAvailable: async () => models,
			getApiKeyAndHeaders: async () => ({ ok: true }),
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		};
		const context: any = {
			cwd: "/repo", mode: "tui", hasUI: false,
			get model() { return current; }, get thinkingLevel() { return thinking; },
			modelRegistry: registry, isProjectTrusted: () => true, getContextUsage: () => ({ tokens: 1_000 }),
			sessionManager: { getBranch: () => [] },
		};
		const router = new PiRunRouter({ pi, engine, modelSource: new PiModelSource({ agentDir }), mode: "managed" });
		router.onSessionStart(context);
		await router.beforeAgentStart({ prompt: "Find TODO files" }, context);
		assert.equal(setModelCalls, 0);
		const rollout = store.getRollout("pi_run:run:balanced");
		assert.equal(rollout.ok, true);
		if (rollout.ok && rollout.value) store.setRollout({ ...rollout.value, stage: "auto" });
		await router.onAgentSettled();
		await router.beforeAgentStart({ prompt: "Find TODO files" }, context);
		assert.equal(setModelCalls, 1);
		assert.equal(current.id, "local-model");
		router.onMessageUpdate({ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } });
		router.onTurnEnd({ message: { role: "assistant", provider: "local-llamacpp", model: "local-model", timestamp: 1, stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 10, output: 2, cost: { total: 0 } } } });
		await router.onAgentSettled();
		const summary = store.getSummary();
		assert.equal(summary.ok && summary.value.totalObservations, 2);
		router.onModelSelect(models[1], "set");
		assert.equal(router.getModelPin(), "anthropic/claude-sonnet-4-6");
		router.unpin(context);
		assert.equal(router.getModelPin(), undefined);
		assert(entries.some((entry) => entry.customType === "model-router.route.v1"));
		await router.close();
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
