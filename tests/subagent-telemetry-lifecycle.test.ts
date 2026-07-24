import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryLogRecordExporter } from "../subagent/node_modules/@opentelemetry/sdk-logs/build/src/index.js";
import { AggregationTemporality, InMemoryMetricExporter } from "../subagent/node_modules/@opentelemetry/sdk-metrics/build/src/index.js";
import { InMemorySpanExporter } from "../subagent/node_modules/@opentelemetry/sdk-trace-node/build/src/index.js";
import { loadSubagentTelemetryConfig } from "../subagent/telemetry/Config.ts";
import { OpenTelemetrySubagentTelemetry } from "../subagent/telemetry/OpenTelemetry.ts";
import { HmacTelemetryPrivacy, TELEMETRY_KEY_BYTES } from "../subagent/telemetry/Privacy.ts";

function harness() {
	const config = loadSubagentTelemetryConfig({ env: { PI_SUBAGENT_OTEL_ENABLED: "1", PI_SUBAGENT_OTEL_METRIC_INTERVAL_MS: "1000" } });
	const traces = new InMemorySpanExporter();
	const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
	const logs = new InMemoryLogRecordExporter();
	const telemetry = new OpenTelemetrySubagentTelemetry(
		config,
		new HmacTelemetryPrivacy({ key: Buffer.alloc(TELEMETRY_KEY_BYTES, 9), scope: "process" }),
		{ trace: traces, metrics, logs },
	);
	return { telemetry, traces, metrics, logs };
}

test("OpenTelemetry lifecycle produces correlated metadata-only spans, logs, and metrics", async () => {
	const h = harness();
	const now = Date.now();
	const canary = "/private/CANARY/source.ts";
	try {
		h.telemetry.startSession({ sessionId: "session-secret", projectPath: canary, startedAt: now });
		h.telemetry.batchStarted({ jobId: "job_1", nameHashSource: "private batch", projectPath: canary, source: "jsonl", maxConcurrency: 2, itemCount: 1, createdAt: now + 1 });
		h.telemetry.agentQueued({
			agentId: "agent_1", parentAgentId: null, jobId: "job_1", taskPath: canary,
			projectPath: canary, model: "openai/gpt-test", thinkingLevel: "low", routingMode: "auto",
			routingProfile: "balanced", intent: "debug", complexityTier: "moderate", complexityScore: 0.5,
			writeMode: "read_only", contextMode: "fresh", promptChars: 123, createdAt: now + 2,
		});
		h.telemetry.agentStarted({ agentId: "agent_1", status: "running", processState: "live_running", controllable: true, at: now + 3 });
		h.telemetry.processSpawned({ agentId: "agent_1", at: now + 4, pid: 123 });
		h.telemetry.turnStarted({ agentId: "agent_1", turnId: "turn_1", kind: "initial", at: now + 5 });
		h.telemetry.agentFirstProgress("agent_1", now + 6);
		h.telemetry.rpcStarted({ agentId: "agent_1", turnId: "turn_1", requestId: "rpc_1", command: "prompt", at: now + 5 });
		h.telemetry.rpcCompleted({ agentId: "agent_1", turnId: "turn_1", requestId: "rpc_1", command: "prompt", outcome: "succeeded", durationMs: 2, at: now + 7 });
		h.telemetry.toolStarted({ agentId: "agent_1", turnId: "turn_1", toolCallId: "tool_1", toolName: "read", at: now + 7 });
		h.telemetry.toolCompleted({ agentId: "agent_1", turnId: "turn_1", toolCallId: "tool_1", toolName: "read", outcome: "succeeded", durationMs: 2, resultChars: 500, resultTruncated: false, at: now + 9 });
		h.telemetry.recovery({ agentId: "agent_1", turnId: "turn_1", type: "compaction", phase: "started", at: now + 9 });
		h.telemetry.recovery({ agentId: "agent_1", turnId: "turn_1", type: "compaction", phase: "completed", outcome: "succeeded", durationMs: 1, at: now + 10 });
		h.telemetry.turnCompleted({ agentId: "agent_1", turnId: "turn_1", kind: "initial", outcome: "succeeded", durationMs: 10, outputChars: 20, toolCalls: 1, providerRequests: 1, compactions: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.01, at: now + 15 });
		h.telemetry.agentCompleted({ agentId: "agent_1", status: "succeeded", processState: "live_idle", controllable: true, outcome: "succeeded", durationMs: 10, queueDurationMs: 1, startupDurationMs: 1, firstProgressMs: 1, outputChars: 20, at: now + 15 });
		h.telemetry.batchItem({ jobId: "job_1", itemId: "private-row-id", agentId: "agent_1", phase: "completed", outcome: "succeeded", durationMs: 13, at: now + 15 });
		h.telemetry.processExited({ agentId: "agent_1", status: "succeeded", processState: "exited", controllable: false, exitCode: 0, at: now + 16 });
		h.telemetry.batchCompleted({ jobId: "job_1", outcome: "succeeded", durationMs: 16, total: 1, succeeded: 1, failed: 0, cancelled: 0, lost: 0, at: now + 17 });
		h.telemetry.endSession({ endedAt: now + 18, reason: "shutdown" });
		await h.telemetry.forceFlush();

		const spans = h.traces.getFinishedSpans();
		const byName = new Map(spans.map((span) => [span.name, span]));
		for (const name of ["pi.subagent.session", "pi.subagent.batch", "pi.subagent.process", "pi.subagent.turn", "pi.subagent.rpc", "pi.subagent.tool", "pi.subagent.context_recovery"]) assert(byName.has(name), `missing ${name}`);
		assert.equal(byName.get("pi.subagent.batch")?.parentSpanContext?.spanId, byName.get("pi.subagent.session")?.spanContext().spanId);
		assert.equal(byName.get("pi.subagent.process")?.parentSpanContext?.spanId, byName.get("pi.subagent.batch")?.spanContext().spanId);
		assert.equal(byName.get("pi.subagent.turn")?.parentSpanContext?.spanId, byName.get("pi.subagent.process")?.spanContext().spanId);
		assert.equal(byName.get("pi.subagent.rpc")?.parentSpanContext?.spanId, byName.get("pi.subagent.turn")?.spanContext().spanId);
		assert.equal(byName.get("pi.subagent.tool")?.parentSpanContext?.spanId, byName.get("pi.subagent.turn")?.spanContext().spanId);
		assert.equal(byName.get("pi.subagent.context_recovery")?.parentSpanContext?.spanId, byName.get("pi.subagent.turn")?.spanContext().spanId);

		const exported = JSON.stringify({
			spans: spans.map((span) => ({ name: span.name, attributes: span.attributes, events: span.events })),
			logs: h.logs.getFinishedLogRecords().map((record) => ({ eventName: record.eventName, body: record.body, attributes: record.attributes })),
		});
		assert(!exported.includes(canary));
		assert(!exported.includes("private batch"));
		assert(!exported.includes("private-row-id"));
		assert.match(exported, /project.id/);

		const resourceMetrics = h.metrics.getMetrics();
		const metricNames = resourceMetrics.flatMap((resource: any) => resource.scopeMetrics.flatMap((scope: any) => scope.metrics.map((metric: any) => metric.descriptor.name)));
		assert(metricNames.includes("pi.subagent.agent.completed"));
		assert(metricNames.includes("pi.subagent.tokens"));
		assert(metricNames.includes("pi.subagent.cost"));
		assert.equal(h.telemetry.getHealth().degraded, false);
	} finally {
		await h.telemetry.shutdown(1_000);
	}
});
