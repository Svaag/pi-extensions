import assert from "node:assert/strict";
import test from "node:test";
import { addOptionalMetric, aggregateAssistantUsage, mergeCumulativeAgentMetrics } from "../subagent/telemetry/Usage.ts";

test("aggregateAssistantUsage sums provider token and cost fields", () => {
	const usage = aggregateAssistantUsage([
		{ role: "user", content: "ignored" },
		{ role: "assistant", usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 5, totalTokens: 175, cost: { total: 0.012 } } },
		{ role: "toolResult", usage: { input: 999 } },
		{ role: "assistant", usage: { input: 80, output: 10, cacheRead: 0, cacheWrite: 2, totalTokens: 92, cost: { total: 0.008 } } },
	]);
	assert.deepEqual(usage, {
		providerRequests: 2,
		inputTokens: 180,
		outputTokens: 30,
		cacheReadTokens: 50,
		cacheWriteTokens: 7,
		totalTokens: 267,
		costUsd: 0.02,
	});
});

test("aggregateAssistantUsage leaves unavailable usage unknown", () => {
	assert.deepEqual(aggregateAssistantUsage([{ role: "assistant" }]), {
		providerRequests: 0,
		inputTokens: undefined,
		outputTokens: undefined,
		cacheReadTokens: undefined,
		cacheWriteTokens: undefined,
		totalTokens: undefined,
		costUsd: undefined,
	});
	assert.equal(addOptionalMetric(undefined, undefined), undefined);
});

test("mergeCumulativeAgentMetrics accumulates turns and preserves one-time timings", () => {
	const first = mergeCumulativeAgentMetrics(undefined, {
		durationMs: 100,
		queueDurationMs: 10,
		startupDurationMs: 5,
		firstProgressMs: 20,
		turns: 1,
		toolCalls: 2,
		providerRequests: 3,
		inputTokens: 100,
		outputTokens: 20,
		costUsd: 0.01,
	}, { outputChars: 50 });
	const second = mergeCumulativeAgentMetrics(first, {
		durationMs: 80,
		queueDurationMs: 999,
		startupDurationMs: 999,
		firstProgressMs: 12,
		turns: 1,
		toolCalls: 1,
		providerRequests: 1,
		inputTokens: 40,
		outputTokens: 10,
		costUsd: 0.005,
	}, { outputChars: 90 });
	assert.equal(second.durationMs, 180);
	assert.equal(second.queueDurationMs, 10);
	assert.equal(second.startupDurationMs, 5);
	assert.equal(second.firstProgressMs, 12);
	assert.equal(second.turns, 2);
	assert.equal(second.toolCalls, 3);
	assert.equal(second.providerRequests, 4);
	assert.equal(second.inputTokens, 140);
	assert.equal(second.outputTokens, 30);
	assert.equal(second.costUsd, 0.015);
	assert.equal(second.outputChars, 90);
});
