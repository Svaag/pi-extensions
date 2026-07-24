import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { filterConfiguredCandidates, profileCandidate, thinkingLevelsFor } from "../model-router/src/core/candidates.ts";
import { assessTaskComplexity, classifyTaskIntent, estimateRoutingTokens } from "../model-router/src/core/features.ts";
import { modelFingerprint } from "../model-router/src/core/modelFingerprint.ts";
import { DEFAULT_ROUTER_CONFIG } from "../model-router/src/config/defaults.ts";
import { loadRouterConfig, mergeRouterConfig } from "../model-router/src/config/load.ts";
import type { RoutingCandidate } from "../model-router/src/core/types.ts";

const local: RoutingCandidate = {
	provider: "local-llamacpp",
	id: "local-model",
	name: "Local llama.cpp",
	reasoning: false,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 8_192,
	cost: { input: 0, output: 0 },
	authenticated: true,
	available: true,
};

const sonnet: RoutingCandidate = {
	provider: "anthropic",
	id: "claude-sonnet-4-6",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 200_000,
	maxTokens: 16_384,
	cost: { input: 3, output: 15 },
	authenticated: true,
	available: true,
};

test("deterministic cold-start classification preserves lookup and critical tiers", () => {
	const lookup = { taskName: "lookup", prompt: "Find files that mention TODO. Return paths only.", writeMode: "read_only" };
	const lookupClass = classifyTaskIntent(lookup);
	const lookupTier = assessTaskComplexity(lookup, lookupClass, DEFAULT_ROUTER_CONFIG.complexity.thresholds);
	assert.equal(lookupClass.intent, "lookup");
	assert.equal(lookupTier.complexityTier, "trivial");

	const critical = {
		taskName: "production-auth-migration",
		prompt: "Implement a multi-step production payment wallet authentication schema migration across all usages. Review security, secrets, data loss, concurrency, race conditions, rollback, and architecture risks.",
		contextMode: "summary",
		contextSummary: "Prior architecture context. ".repeat(1_200),
		writeMode: "disjoint_scope",
	};
	const criticalClass = classifyTaskIntent(critical);
	const criticalTier = assessTaskComplexity(critical, criticalClass, DEFAULT_ROUTER_CONFIG.complexity.thresholds);
	assert.equal(criticalClass.sensitive, true);
	assert.equal(criticalTier.complexityTier, "critical");
});

test("cold-start model priors retain legacy safety and thinking bounds", () => {
	assert.equal(profileCandidate(local, DEFAULT_ROUTER_CONFIG).quality, 0.2);
	assert.equal(profileCandidate(sonnet, DEFAULT_ROUTER_CONFIG).quality, 0.9);
	assert.deepEqual(thinkingLevelsFor(local, "complex"), ["off"]);
	assert.deepEqual(thinkingLevelsFor(sonnet, "critical"), ["medium", "high", "xhigh"]);
	assert.deepEqual(thinkingLevelsFor(sonnet, "simple", "max"), ["max"]);
});

test("candidate filter excludes unauthenticated and synthetic router models", () => {
	const candidates = filterConfiguredCandidates([
		local,
		{ ...sonnet, authenticated: false },
		{ provider: "model-router", id: "balanced", authenticated: true, available: true },
	], DEFAULT_ROUTER_CONFIG);
	assert.deepEqual(candidates.map((candidate) => candidate.id), ["local-model"]);
});

test("fingerprint excludes secret metadata and changes on capability changes", () => {
	const first = modelFingerprint({ ...sonnet, metadata: { apiKey: "one" } });
	const second = modelFingerprint({ ...sonnet, metadata: { apiKey: "two" } });
	const changed = modelFingerprint({ ...sonnet, contextWindow: 300_000 });
	assert.equal(first, second);
	assert.notEqual(first, changed);
});

test("config sanitizes rollout, judge, profile, and legacy settings", async () => {
	const patched = mergeRouterConfig(DEFAULT_ROUTER_CONFIG, {
		profile: "latency_first",
		judge: { sampleRate: 0.9 },
		rollout: { minimumObservationCompleteness: -1 },
	});
	assert.equal(patched.profile, "latency_first");
	assert.equal(patched.judge.sampleRate, 0.05);
	assert.equal(patched.rollout.minimumObservationCompleteness, 0.9);

	const agentDir = await mkdtemp(join(tmpdir(), "model-router-config-"));
	try {
		await writeFile(join(agentDir, "subagent-router.json"), JSON.stringify({ objective: "quality_first" }));
		const project = join(agentDir, "project");
		await mkdir(join(project, ".pi"), { recursive: true });
		await writeFile(join(project, ".pi", "model-router.json"), JSON.stringify({ profile: "cost_first" }));
		const loaded = loadRouterConfig(project, { agentDir, projectTrusted: true });
		assert.equal(loaded.config.profile, "cost_first");
		assert.equal(loaded.warnings.length, 1);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("token estimator never persists prompt and honors supplied values", () => {
	assert.deepEqual(estimateRoutingTokens({ prompt: "secret" }, "lookup", 123, 456), { inputTokens: 123, outputTokens: 456 });
});
