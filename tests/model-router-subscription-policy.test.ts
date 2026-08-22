import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ROUTER_CONFIG } from "../model-router/src/config/defaults.ts";
import { mergeRouterConfig } from "../model-router/src/config/load.ts";
import { billingClass, familyIdFor, filterFamilyCandidates, pickSubscriptionArm } from "../model-router/src/core/families.ts";
import { ModelRoutingEngine } from "../model-router/src/core/ModelRoutingEngine.ts";
import type { RouteRequest, RoutingCandidate } from "../model-router/src/core/types.ts";
import { SqliteRouterStore } from "../model-router/src/storage/SqliteRouterStore.ts";

const subscriptionPolicy = {
	enabled: true,
	ranking: ["codex", "claude", "grok", "kimi", "glm"],
	includedProviders: ["openai-codex", "kimi-coding", "zai-official", "anthropic", "xai"],
	meteredProviders: ["venice", "openrouter"],
	familyCooldownMs: 900_000,
	families: {
		codex: {
			preferred: "openai-codex/gpt-5.6-sol",
			members: [
				"openai-codex/gpt-5.6-sol",
				"openai-codex/gpt-5.6-luna",
				"openai-codex/gpt-5.6-terra",
				"openai-codex/gpt-daybreak-blue-latest",
			],
		},
		claude: {
			preferred: "anthropic/claude-sonnet-5",
			members: ["anthropic/claude-sonnet-*"],
		},
		grok: {
			preferred: "xai/grok-4.6",
			members: ["xai/grok-4.6", "xai/grok-4.5"],
		},
		kimi: {
			preferred: "kimi-coding/k3",
			members: ["kimi-coding/k3", "kimi-coding/k3-256k", "openrouter/moonshotai/kimi-k3"],
		},
		glm: {
			preferred: "zai-official/glm-5.3",
			members: ["zai-official/glm-5.3", "zai-official/glm-5.2", "venice/zai-org-glm-5-2", "openrouter/z-ai/glm-5.2"],
		},
	},
};

function subscriptionConfig(overrides: Record<string, unknown> = {}) {
	return mergeRouterConfig(DEFAULT_ROUTER_CONFIG, {
		profile: "subscription_first",
		subscriptionPolicy,
		...overrides,
	});
}

function model(partial: RoutingCandidate): RoutingCandidate {
	return {
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 16_384,
		authenticated: true,
		available: true,
		...partial,
	};
}

const catalog: RoutingCandidate[] = [
	model({ provider: "openai-codex", id: "gpt-5.6-sol", input: ["text", "image"] }),
	model({ provider: "openai-codex", id: "gpt-5.6-luna", input: ["text", "image"] }),
	model({ provider: "openai-codex", id: "gpt-5.6-terra", input: ["text", "image"] }),
	model({ provider: "anthropic", id: "claude-sonnet-5", input: ["text", "image"] }),
	model({ provider: "xai", id: "grok-4.6", input: ["text", "image"] }),
	model({ provider: "kimi-coding", id: "k3", contextWindow: 32_000 }),
	model({ provider: "kimi-coding", id: "k3-256k", contextWindow: 256_000 }),
	model({ provider: "openrouter", id: "moonshotai/kimi-k3", contextWindow: 128_000, cost: { input: 1, output: 3 } }),
	model({ provider: "zai-official", id: "glm-5.3" }),
	model({ provider: "venice", id: "zai-org-glm-5-2", cost: { input: 1.4, output: 4.4 } }),
	model({ provider: "openrouter", id: "z-ai/glm-5.2", cost: { input: 1, output: 3 } }),
	model({ provider: "openrouter", id: "minimax/minimax-m3", cost: { input: 0.1, output: 0.1 } }),
	model({ provider: "openrouter", id: "anthropic/claude-sonnet-5", input: ["text", "image"], cost: { input: 3, output: 15 } }),
	model({ provider: "local-llamacpp", id: "local-model", reasoning: false, cost: { input: 0, output: 0 } }),
];

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
	return {
		host: "sdk",
		prompt: "Find files that mention TODO. Return paths only.",
		taskName: "lookup",
		writeMode: "read_only",
		modality: "text",
		candidates: catalog,
		currentModel: "xai/grok-4.6",
		currentThinkingLevel: "xhigh",
		profile: "subscription_first",
		...overrides,
	};
}

function engine(overrides: Record<string, unknown> = {}) {
	const store = new SqliteRouterStore({ path: ":memory:" });
	return {
		store,
		router: new ModelRoutingEngine({
			store,
			config: subscriptionConfig(overrides),
			newRouteId: (() => { let id = 0; return () => `route-${++id}`; })(),
		}),
	};
}

test("mergeRouterConfig sanitizes subscriptionPolicy and accepts the new profile", () => {
	const patched = mergeRouterConfig(DEFAULT_ROUTER_CONFIG, {
		profile: "subscription_first",
		subscriptionPolicy: {
			enabled: true,
			ranking: ["codex", "unknown", "claude"],
			includedProviders: [" openai-codex ", "openai-codex", ""],
			meteredProviders: ["venice"],
			familyCooldownMs: -5,
			families: {
				codex: { preferred: " openai-codex/gpt-5.6-sol ", members: ["openai-codex/gpt-5.6-sol", "", 1] },
				orphan: { members: [] },
			},
		},
	});
	assert.equal(patched.profile, "subscription_first");
	assert.deepEqual(patched.subscriptionPolicy.ranking, ["codex"]);
	assert.deepEqual(patched.subscriptionPolicy.includedProviders, ["openai-codex"]);
	assert.equal(patched.subscriptionPolicy.families.codex?.preferred, "openai-codex/gpt-5.6-sol");
	assert.deepEqual(patched.subscriptionPolicy.families.codex?.members, ["openai-codex/gpt-5.6-sol"]);
	assert.equal(patched.subscriptionPolicy.families.orphan, undefined);
	assert.equal(patched.subscriptionPolicy.familyCooldownMs, 900_000);
	assert.ok(patched.profiles.subscription_first);
});

test("family matcher assigns the highest-ranked overlapping family and drops extras", () => {
	const policy = subscriptionConfig().subscriptionPolicy;
	assert.equal(familyIdFor({ provider: "openai-codex", id: "gpt-5.6-sol" }, policy), "codex");
	assert.equal(familyIdFor({ provider: "anthropic", id: "claude-sonnet-5" }, policy), "claude");
	assert.equal(familyIdFor({ provider: "openrouter", id: "anthropic/claude-sonnet-5" }, policy), undefined);
	assert.equal(familyIdFor({ provider: "openrouter", id: "minimax/minimax-m3" }, policy), undefined);
	assert.equal(billingClass({ provider: "openrouter" }, policy), "metered");
	assert.equal(billingClass({ provider: "anthropic" }, policy), "included");
	assert.equal(billingClass({ provider: "openrouter" }, { ...policy, includedProviders: [...policy.includedProviders, "openrouter"] }), "metered");
	assert.deepEqual(filterFamilyCandidates(catalog, policy).map((item) => `${item.provider}/${item.id}`).includes("local-llamacpp/local-model"), false);
	const pick = pickSubscriptionArm(catalog.map((item) => ({ model: `${item.provider}/${item.id}`, provider: item.provider, eligible: true })), policy);
	assert.equal(pick?.arm.model, "openai-codex/gpt-5.6-sol");
	assert.equal(pick?.billing, "included");
});

test("included Codex beats included Claude and every metered endpoint", async () => {
	const { router } = engine();
	const decision = await router.route(request());
	assert.equal(decision.applied, true);
	assert.equal(decision.arm, "forced");
	assert.equal(decision.executedModel, "openai-codex/gpt-5.6-sol");
	assert.match(decision.explanation, /family:codex/);
	assert.match(decision.explanation, /billing:included/);
	await router.close();
});

test("after Codex is ineligible Claude wins", async () => {
	const { router } = engine();
	const decision = await router.route(request({
		candidates: catalog.filter((item) => item.provider !== "openai-codex"),
	}));
	assert.equal(decision.executedModel, "anthropic/claude-sonnet-5");
	await router.close();
});

test("no included family left selects OpenRouter Kimi before Venice GLM", async () => {
	const { router } = engine();
	const decision = await router.route(request({
		candidates: catalog.filter((item) => item.provider === "openrouter" || item.provider === "venice" || item.provider === "local-llamacpp"),
	}));
	assert.equal(decision.executedModel, "openrouter/moonshotai/kimi-k3");
	assert.match(decision.explanation, /billing:metered/);
	await router.close();
});

test("preferred Codex is sol; luna only if sol fails context", async () => {
	const { router } = engine();
	const fitted = await router.route(request());
	assert.equal(fitted.executedModel, "openai-codex/gpt-5.6-sol");
	const overflow = await router.route(request({
		estimatedContextTokens: 250_000,
		estimatedOutputTokens: 1_000,
		candidates: catalog.map((item) => {
			if (item.id === "gpt-5.6-sol") return { ...item, contextWindow: 8_000 };
			if (item.provider === "openai-codex") return { ...item, contextWindow: 272_000 };
			return item;
		}),
	}));
	assert.equal(overflow.executedModel, "openai-codex/gpt-5.6-luna");
	await router.close();
});

test("kimi-coding/k3 wins when it fits and k3-256k wins when it does not", async () => {
	const kimiOnly = catalog.filter((item) => item.provider === "kimi-coding" || item.provider === "openrouter" && item.id.includes("kimi"));
	const { router } = engine();
	const fitted = await router.route(request({ candidates: kimiOnly, estimatedContextTokens: 10_000, estimatedOutputTokens: 1_000 }));
	assert.equal(fitted.executedModel, "kimi-coding/k3");
	const overflow = await router.route(request({ candidates: kimiOnly, estimatedContextTokens: 80_000, estimatedOutputTokens: 1_000 }));
	assert.equal(overflow.executedModel, "kimi-coding/k3-256k");
	await router.close();
});

test("image requests drop text-only GLM and still pick an image-capable included family", async () => {
	const { router } = engine();
	const decision = await router.route(request({
		modality: "image",
		candidates: catalog.filter((item) => item.provider === "zai-official" || item.provider === "anthropic" || item.provider === "local-llamacpp"),
	}));
	assert.equal(decision.executedModel, "anthropic/claude-sonnet-5");
	await router.close();
});

test("OpenRouter Claude is not the subscription Claude family", async () => {
	const { router } = engine();
	const decision = await router.route(request({
		candidates: catalog.filter((item) => item.provider === "openrouter" || item.provider === "local-llamacpp"),
	}));
	assert.notEqual(decision.executedModel, "openrouter/anthropic/claude-sonnet-5");
	assert.equal(decision.executedModel, "openrouter/moonshotai/kimi-k3");
	assert.match(decision.explanation, /billing:metered/);
	await router.close();
});

test("non-family cheap extras never win under subscription_first", async () => {
	const { router } = engine();
	const decision = await router.route(request({
		candidates: catalog.filter((item) => item.provider === "openrouter" || item.provider === "local-llamacpp" || item.provider === "venice"),
	}));
	assert.notEqual(decision.executedModel, "openrouter/minimax/minimax-m3");
	assert.notEqual(decision.executedModel, "local-llamacpp/local-model");
	assert.equal(decision.executedModel, "openrouter/moonshotai/kimi-k3");
	await router.close();
});

test("quality floors do not eliminate a lower-ranked family on complex tasks", async () => {
	const { router } = engine();
	const decision = await router.route(request({
		prompt: "Implement a multi-step production payment wallet authentication schema migration across all usages. Review security, secrets, data loss, concurrency, race conditions, rollback, and architecture risks.",
		taskName: "production-auth-migration",
		writeMode: "disjoint_scope",
		candidates: catalog.filter((item) => item.provider === "zai-official" || item.provider === "venice" || item.provider === "local-llamacpp"),
	}));
	assert.equal(decision.complexityTier === "complex" || decision.complexityTier === "critical", true);
	assert.equal(decision.executedModel, "zai-official/glm-5.3");
	assert.equal(decision.applied, true);
	await router.close();
});

test("unconfigured subscription policy does not apply and keeps the current model", async () => {
	const store = new SqliteRouterStore({ path: ":memory:" });
	const router = new ModelRoutingEngine({
		store,
		config: mergeRouterConfig(DEFAULT_ROUTER_CONFIG, { profile: "subscription_first" }),
	});
	const decision = await router.route(request({ forceMode: "auto" }));
	assert.equal(decision.applied, false);
	assert.equal(decision.reason, "subscription_policy_unconfigured");
	assert.equal(decision.executedModel, "xai/grok-4.6");
	const status = await router.getStatus();
	assert.ok(status.health.warnings.includes("subscription_policy_unconfigured"));
	await router.close();
});
