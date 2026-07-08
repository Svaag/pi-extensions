import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_ROUTER_CONFIG, type RouterConfig } from "../subagent/core/RouterConfig.ts";
import { parseClassifierDecision, routeSubagentModel } from "../subagent/core/SmartRouter.ts";
import type { ModelLike } from "../subagent/core/ScopedModels.ts";
import { discoverAgents } from "../subagent/agents.ts";

const MODELS: ModelLike[] = [
	{
		provider: "local-llamacpp",
		id: "local-model",
		name: "Local llama.cpp",
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		provider: "openrouter",
		id: "google/gemini-3.5-flash",
		name: "Gemini Flash",
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 8192,
		cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
	},
	{
		provider: "openrouter",
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		reasoning: true,
		contextWindow: 1048576,
		maxTokens: 32768,
		cost: { input: 1.73, output: 3.796, cacheRead: 0, cacheWrite: 0 },
	},
	{
		provider: "anthropic",
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 16384,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	},
	{
		provider: "anthropic",
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 16384,
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	},
	{
		provider: "openai-codex",
		id: "gpt-5.5",
		name: "GPT 5.5 Codex",
		reasoning: true,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 6.25, output: 37.5, cacheRead: 0.625, cacheWrite: 0 },
	},
];

function config(): RouterConfig {
	return {
		...DEFAULT_ROUTER_CONFIG,
		classifier: { ...DEFAULT_ROUTER_CONFIG.classifier, enabled: false },
		modelProfiles: {},
	};
}

function registry(models = MODELS) {
	return { getAvailable: async () => models };
}

async function withAgentDir(patterns: string[], fn: (agentDir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "pi-router-test-"));
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "settings.json"), JSON.stringify({ enabledModels: patterns }), "utf8");
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function route(agentDir: string, overrides: any = {}) {
	return routeSubagentModel({
		cwd: "/repo",
		config: overrides.config ?? config(),
		modelRegistry: registry(overrides.models),
		currentModel: MODELS[5],
		taskName: overrides.taskName ?? "lookup",
		prompt: overrides.prompt ?? "Find where authentication routes are defined. Return file paths only.",
		contextMode: overrides.contextMode,
		contextSummary: overrides.contextSummary,
		writeMode: overrides.writeMode ?? "read_only",
		routingMode: overrides.routingMode ?? "auto",
		routingProfile: overrides.routingProfile,
		explicitModel: overrides.explicitModel,
		explicitThinkingLevel: overrides.explicitThinkingLevel,
		classifier: overrides.classifier,
		scopedModelOptions: { agentDir },
	});
}

test("subagent routing defaults to the current parent model when mode is omitted", async () => {
	await withAgentDir(["local-llamacpp/local-model", "openrouter/deepseek/deepseek-v4-pro"], async (agentDir) => {
		const result = await routeSubagentModel({
			cwd: "/repo",
			config: config(),
			modelRegistry: registry(),
			currentModel: MODELS[5],
			taskName: "lookup",
			prompt: "Find where authentication routes are defined. Return file paths only.",
			writeMode: "read_only",
			scopedModelOptions: { agentDir },
		});
		assert.equal(result.model, "openai-codex/gpt-5.5");
		assert.equal(result.thinkingLevel, undefined);
		assert.equal(result.decision.reason, "disabled");
		assert.match(result.decision.explanation, /current parent Pi model/);
	});
});

test("smart router sends simple lookup to low-cost scoped model with off/minimal thinking when auto is requested", async () => {
	await withAgentDir(["local-llamacpp/local-model", "anthropic/claude-sonnet-*", "openai-codex/gpt-*"], async (agentDir) => {
		const result = await route(agentDir);
		assert.equal(result.model, "local-llamacpp/local-model");
		assert.equal(result.thinkingLevel, "off");
		assert.equal(result.decision.intent, "lookup");
		assert.equal(result.decision.complexityTier, "trivial");
		assert(result.decision.complexityScore < 0.2);
		assert.equal(result.decision.reason, "selected");
	});
});

test("smart router routes security review to Sonnet-class quality", async () => {
	await withAgentDir([
		"local-llamacpp/local-model",
		"openrouter/deepseek/deepseek-v4-pro",
		"anthropic/claude-sonnet-*",
		"anthropic/claude-opus-*",
		"openai-codex/gpt-*",
	], async (agentDir) => {
		const result = await route(agentDir, {
			taskName: "security-review",
			prompt: "Review the authentication and permission checks for security vulnerabilities, race conditions, and secret handling issues.",
		});
		assert.equal(result.model, "anthropic/claude-sonnet-4-6");
		assert(["low", "medium", "high"].includes(result.thinkingLevel ?? ""));
		assert.equal(result.decision.intent, "review");
		assert(["moderate", "complex", "critical"].includes(result.decision.complexityTier));
	});
});

test("smart router avoids weak/local models for write-capable implementation", async () => {
	await withAgentDir(["local-llamacpp/local-model", "openrouter/google/gemini-*-flash", "anthropic/claude-sonnet-*"], async (agentDir) => {
		const result = await route(agentDir, {
			taskName: "implement-payment-migration",
			prompt: "Implement the payment schema migration and update all permission checks safely.",
			writeMode: "disjoint_scope",
		});
		assert.equal(result.model, "anthropic/claude-sonnet-4-6");
		assert.equal(result.decision.intent, "implement");
		assert(["moderate", "complex", "critical"].includes(result.decision.complexityTier));
	});
});

test("smart router exposes critical complexity tier for high-risk multi-step work", async () => {
	await withAgentDir([
		"local-llamacpp/local-model",
		"openrouter/deepseek/deepseek-v4-pro",
		"anthropic/claude-sonnet-*",
		"anthropic/claude-opus-*",
		"openai-codex/gpt-*",
	], async (agentDir) => {
		const result = await route(agentDir, {
			taskName: "critical-payment-auth-migration",
			contextMode: "summary",
			contextSummary: "Prior architecture and incident context. ".repeat(1200),
			prompt: "Implement a multi-step production payment wallet authentication and permission schema migration across all usages. Review security, secrets, data loss, concurrency, race conditions, rollback, and architecture risks before making changes.",
			writeMode: "disjoint_scope",
		});
		assert.equal(result.decision.complexityTier, "critical");
		assert(result.decision.complexityScore >= 0.78);
		assert(["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-8", "openai-codex/gpt-5.5"].includes(result.model ?? ""));
		assert(["high", "xhigh"].includes(result.thinkingLevel ?? ""));
	});
});

test("smart router recomputes complexity tier after classifier refinement", async () => {
	await withAgentDir(["local-llamacpp/local-model", "anthropic/claude-sonnet-*"], async (agentDir) => {
		const result = await route(agentDir, {
			taskName: "ambiguous",
			prompt: "Handle this task after checking repository context.",
			config: { ...config(), classifier: { ...DEFAULT_ROUTER_CONFIG.classifier, enabled: "auto" } },
			classifier: async () => ({
				intent: "implement",
				risk: 1,
				complexity: 1,
				confidence: 0.9,
				reason: "classifier saw critical implementation risk",
			}),
		});
		assert.equal(result.decision.classifierUsed, true);
		assert.equal(result.decision.classifierModel, "local-llamacpp/local-model");
		assert.equal(result.decision.intent, "implement");
		assert.equal(result.decision.complexityTier, "critical");
		assert.equal(result.model, "anthropic/claude-sonnet-4-6");
	});
});

test("smart router honors configured complexity thresholds", async () => {
	await withAgentDir(["local-llamacpp/local-model", "anthropic/claude-sonnet-*"], async (agentDir) => {
		const customConfig: RouterConfig = {
			...config(),
			complexity: {
				thresholds: { trivialMax: 0.01, simpleMax: 0.5, moderateMax: 0.7, complexMax: 0.9 },
				tierQualityFloor: { ...DEFAULT_ROUTER_CONFIG.complexity.tierQualityFloor },
			},
		};
		const result = await route(agentDir, { config: customConfig, prompt: "List files that mention TODO." });
		assert.equal(result.decision.complexityTier, "simple");
	});
});

test("smart router profile preferredTiers influences otherwise tied candidates", async () => {
	const models: ModelLike[] = [
		{ provider: "test", id: "moderate", name: "Moderate Tier", reasoning: false, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		{ provider: "test", id: "simple", name: "Simple Tier", reasoning: false, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
	];
	await withAgentDir(["test/moderate", "test/simple"], async (agentDir) => {
		const customConfig: RouterConfig = {
			...config(),
			complexity: {
				thresholds: { trivialMax: 0.01, simpleMax: 0.5, moderateMax: 0.7, complexMax: 0.9 },
				tierQualityFloor: { ...DEFAULT_ROUTER_CONFIG.complexity.tierQualityFloor },
			},
			modelProfiles: {
				"test/moderate": { quality: 0.55, speed: 0.5, preferredIntents: ["lookup"], preferredTiers: ["moderate"] },
				"test/simple": { quality: 0.55, speed: 0.5, preferredIntents: ["lookup"], preferredTiers: ["simple"] },
			},
		};
		const result = await route(agentDir, { config: customConfig, models, prompt: "List files that mention TODO." });
		assert.equal(result.decision.complexityTier, "simple");
		assert.equal(result.model, "test/simple");
	});
});

test("smart router preserves explicit model and thinking overrides", async () => {
	await withAgentDir(["local-llamacpp/local-model", "anthropic/claude-sonnet-*"], async (agentDir) => {
		const result = await route(agentDir, {
			explicitModel: "anthropic/claude-opus-4-8",
			explicitThinkingLevel: "minimal",
		});
		assert.equal(result.model, "anthropic/claude-opus-4-8");
		assert.equal(result.thinkingLevel, "minimal");
		assert.equal(result.decision.reason, "explicit_thinking");
	});
});

test("smart router falls back to current model when no scoped models exist", async () => {
	await withAgentDir([], async (agentDir) => {
		const result = await route(agentDir);
		assert.equal(result.model, "openai-codex/gpt-5.5");
		assert.equal(result.decision.reason, "fallback_current_model");
	});
});

test("smart router overkill penalty keeps trivial lookup off premium models", async () => {
	await withAgentDir(["anthropic/claude-opus-*", "openai-codex/gpt-*", "local-llamacpp/local-model"], async (agentDir) => {
		const result = await route(agentDir, { prompt: "List files that mention TODO." });
		assert.equal(result.model, "local-llamacpp/local-model");
	});
});

test("smart router ignores classifier failures and keeps deterministic result", async () => {
	await withAgentDir(["local-llamacpp/local-model", "anthropic/claude-sonnet-*"], async (agentDir) => {
		const result = await route(agentDir, {
			prompt: "Handle this task after checking the repository context.",
			classifier: async () => {
				throw new Error("classifier down");
			},
		});
		assert(result.model);
		assert.notEqual(result.decision.reason, "no_available_models");
	});
});

test("agent frontmatter parses thinking and router fields", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-frontmatter-test-"));
	try {
		await mkdir(join(dir, ".pi", "agents"), { recursive: true });
		await writeFile(join(dir, ".pi", "agents", "scout.md"), `---\nname: scout\ndescription: Scout\nmodel: local-llamacpp/local-model\nthinking: minimal\nrouter: explain\nroutingProfile: cost_first\n---\n\nScout prompt.\n`, "utf8");
		const agents = discoverAgents(dir, "project").agents;
		assert.equal(agents[0].thinkingLevel, "minimal");
		assert.equal(agents[0].routingMode, "explain");
		assert.equal(agents[0].routingProfile, "cost_first");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("parseClassifierDecision accepts strict JSON and rejects invalid intent", () => {
	assert.deepEqual(parseClassifierDecision('{"intent":"debug","risk":0.4,"complexity":0.5,"confidence":0.8,"reason":"failing tests"}')?.intent, "debug");
	assert.equal(parseClassifierDecision('{"intent":"nonsense","risk":0,"complexity":0,"confidence":1,"reason":"x"}'), undefined);
});
