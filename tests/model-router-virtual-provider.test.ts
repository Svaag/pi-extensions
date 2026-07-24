import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "../model-router/node_modules/@earendil-works/pi-ai/dist/index.js";
import { registerVirtualRouterProvider } from "../model-router/src/adapters/pi/VirtualRouterProvider.ts";
import { ModelRoutingEngine } from "../model-router/src/core/ModelRoutingEngine.ts";
import { SqliteRouterStore } from "../model-router/src/storage/SqliteRouterStore.ts";

const targetModels: any[] = [
	{ provider: "local-llamacpp", id: "local-model", api: "openai-completions", baseUrl: "http://local", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
	{ provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages", baseUrl: "http://anthropic", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 16_384, cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } },
];

function candidate(model: any) {
	return { ...model, authenticated: true, available: true };
}

function assistant(model: any, stopReason: "stop" | "error") {
	return {
		role: "assistant", content: stopReason === "stop" ? [{ type: "text", text: "ok" }] : [], api: model.api,
		provider: model.provider, model: model.id,
		usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason, timestamp: Date.now(), errorMessage: stopReason === "error" ? "upstream unavailable" : undefined,
	};
}

function inner(model: any, fail: boolean, visibleBeforeFailure = false) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message = assistant(model, fail ? "error" : "stop");
		stream.push({ type: "start", partial: message });
		if (visibleBeforeFailure || !fail) {
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: message });
		}
		if (fail) stream.push({ type: "error", reason: "error", error: message });
		else stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
}

function setup(visibleBeforeFailure = false) {
	let provider: any;
	const pi = { registerProvider(_name: string, config: any) { provider = config; } } as any;
	const store = new SqliteRouterStore({ path: ":memory:" });
	const engine = new ModelRoutingEngine({ store });
	let calls = 0;
	const registry = {
		find(provider: string, id: string) { return targetModels.find((item) => item.provider === provider && item.id === id); },
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
	};
	const runtime: any = {
		engine,
		modelSource: { snapshot: async () => ({ candidates: targetModels.map(candidate), modelsByRef: new Map(), patterns: ["*"], warnings: [] }) },
		context: { cwd: "/repo", isProjectTrusted: () => true, modelRegistry: registry },
	};
	registerVirtualRouterProvider(pi, () => runtime, {
		delegate(model: any) { calls += 1; return calls === 1 ? inner(model, true, visibleBeforeFailure) : inner(model, false); },
	});
	return { provider, store, engine, calls: () => calls };
}

const context: any = { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "Find TODO files" }] }], tools: [] };

test("virtual provider retries once before visible output and emits only fallback stream", async () => {
	const setupResult = setup(false);
	const routerModel = { provider: "model-router", id: "balanced", api: "model-router-routing", reasoning: true } as any;
	const events: any[] = [];
	for await (const event of setupResult.provider.streamSimple(routerModel, context, { reasoning: "low" })) events.push(event);
	assert.equal(setupResult.calls(), 2);
	assert.equal(events.filter((event) => event.type === "start").length, 1);
	assert.equal(events.at(-1)?.type, "done");
	const summary = setupResult.store.getSummary();
	assert.equal(summary.ok && summary.value.totalObservations, 2);
	await setupResult.engine.close();
});

test("virtual provider never replays after visible content", async () => {
	const setupResult = setup(true);
	const routerModel = { provider: "model-router", id: "balanced", api: "model-router-routing", reasoning: true } as any;
	const events: any[] = [];
	for await (const event of setupResult.provider.streamSimple(routerModel, context, {})) events.push(event);
	assert.equal(setupResult.calls(), 1);
	assert(events.some((event) => event.type === "text_delta"));
	assert.equal(events.at(-1)?.type, "error");
	await setupResult.engine.close();
});
