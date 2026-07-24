import assert from "node:assert/strict";
import test from "node:test";
import { SqliteRouterStore } from "../model-router/src/storage/SqliteRouterStore.ts";
import { ROUTER_MIGRATIONS } from "../model-router/src/storage/migrations.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMetricHistogram, histogramQuantile, observeMetric } from "../model-router/src/storage/histograms.ts";
import type { RouteDecision } from "../model-router/src/core/types.ts";

function decision(overrides: Partial<RouteDecision> = {}): RouteDecision {
	return {
		schemaVersion: 1,
		routeId: "route-1",
		policyVersion: "1",
		createdAt: 1_700_000_000_000,
		stage: "shadow",
		host: "sdk",
		granularity: "run",
		profile: "balanced",
		applied: false,
		arm: "control",
		reason: "contains /private/repo and secret prompt",
		intent: "lookup",
		complexityTier: "trivial",
		complexityScore: 0.1,
		riskScore: 0.1,
		confidence: 0.8,
		selectedModel: "test/model",
		selectedThinkingLevel: "off",
		executedModel: "test/model",
		executedThinkingLevel: "off",
		baselineModel: "test/model",
		baselineThinkingLevel: "off",
		estimatedInputTokens: 100,
		estimatedOutputTokens: 50,
		candidates: [{ model: "test/model", thinkingLevel: "off", fingerprint: "fp", eligible: true, score: 1, quality: 0.5, reliability: 0.97, speed: 1, observations: 0, notes: ["secret"] }],
		constraints: [{ model: "test/model", thinkingLevel: "off", eligible: true, reasons: ["private path"], qualityFloor: 0.2, reliabilityFloor: 0.9 }],
		explanation: "raw prompt must not persist",
		cohortKey: "sdk|lookup|trivial|xs|text|no-tools|read",
		forced: false,
		...overrides,
	};
}

test("SQLite store migrates, strips content, aggregates rollout, and tracks budgets", () => {
	const store = new SqliteRouterStore({ path: ":memory:", now: () => 1_700_000_000_000 });
	assert.equal(store.initialize().ok, true);
	assert.equal(store.health().available, true);
	assert.equal(store.saveDecision(decision()).ok, true);
	assert.equal(store.saveObservation({ routeId: "route-1", outcome: "succeeded", latencyMs: 100, costUsd: 0, quality: { score: 1, source: "user", weight: 1 } }).ok, true);
	const restored = store.getDecision("route-1");
	assert.equal(restored.ok, true);
	if (!restored.ok) return;
	assert.equal(restored.value?.explanation, "Routing explanation is intentionally not persisted.");
	assert.deepEqual(restored.value?.candidates[0]?.notes, []);
	assert.deepEqual(restored.value?.constraints[0]?.reasons, []);
	const aggregate = store.getRolloutAggregate("sdk:run:balanced");
	assert.equal(aggregate.ok, true);
	if (aggregate.ok) {
		assert.equal(aggregate.value.control.completed, 1);
		assert.equal(aggregate.value.control.qualityLabels, 1);
		assert.equal(aggregate.value.control.costPerSuccessUsd, 0);
	}
	const reserved = store.reserveJudgeBudget({ day: "2026-07-24", amountUsd: 0.2, maxDailyUsd: 0.25 });
	assert.equal(reserved.ok && Boolean(reserved.value), true);
	const denied = store.reserveJudgeBudget({ day: "2026-07-24", amountUsd: 0.1, maxDailyUsd: 0.25 });
	assert.equal(denied.ok && denied.value === undefined, true);
	assert.equal(store.close().ok, true);
});

test("histogram quantiles and decay-safe observations are bounded", () => {
	let histogram = createMetricHistogram({ armKey: "a", metric: "latency_ms" }, [100, 200], 1);
	histogram = observeMetric(histogram, 50, 1, 2);
	histogram = observeMetric(histogram, 150, 1, 3);
	histogram = observeMetric(histogram, 500, 1, 4);
	assert.equal(histogramQuantile(histogram, 0.5), 200);
	assert.equal(histogramQuantile(histogram, 0.95), 200);
});

test("SQLite migrates an existing v1 store transactionally", async () => {
	const directory = await mkdtemp(join(tmpdir(), "model-router-migration-"));
	const path = join(directory, "router.db");
	try {
		const legacy = new DatabaseSync(path);
		legacy.exec(ROUTER_MIGRATIONS[0]!.sql);
		legacy.exec("PRAGMA user_version = 1");
		legacy.close();
		const store = new SqliteRouterStore({ path });
		assert.equal(store.initialize().ok, true);
		const check = new DatabaseSync(path);
		const version = check.prepare("PRAGMA user_version").get() as { user_version: number };
		const columns = check.prepare("PRAGMA table_info(route_decisions)").all() as Array<{ name: string }>;
		assert.equal(version.user_version, 2);
		assert(columns.some((column) => column.name === "scope_key"));
		assert(columns.some((column) => column.name === "route_arm"));
		check.close();
		store.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("SQLite corruption/path failure is non-throwing", () => {
	const store = new SqliteRouterStore({ path: "/dev/null/router.db" });
	const result = store.initialize();
	assert.equal(result.ok, false);
	assert.equal(store.health().available, false);
});
