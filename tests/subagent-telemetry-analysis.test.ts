import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { formatTelemetryAnalysis, TELEMETRY_QUERY_IDS, TelemetryAnalysisClient } from "../subagent/telemetry/AnalysisClient.ts";
import { loadSubagentTelemetryConfig } from "../subagent/telemetry/Config.ts";

function metricValue(query: string): number {
	if (query.includes("messages_total")) return 0.9;
	if (query.includes("first_progress")) return 12;
	if (query.includes("queue_duration")) return 6;
	if (query.includes("agent_duration")) return 20;
	if (query.includes("timeout|lost")) return 0.02;
	if (query.includes("rpc_requests") && query.includes("failed")) return 0.01;
	if (query.includes("context_recovery")) return 0.8;
	if (query.includes("cost_USD") && query.includes("agent_completed")) return 0.2;
	if (query.includes("cost_USD")) return 2;
	if (query.includes("tokens_total")) return 1_000;
	if (query.includes("outcome=\"succeeded\"")) return 0.9;
	return 20;
}

async function withServer(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (origin: string) => Promise<void>): Promise<void> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
	try {
		await run(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

test("analysis client uses fixed queries, compares periods, sanitizes traces, and reports SLOs", async () => {
	const canary = "/private/CANARY/path.ts";
	const seenQueries: string[] = [];
	await withServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		response.setHeader("content-type", "application/json");
		if (url.pathname === "/api/v1/query") {
			const query = url.searchParams.get("query") ?? "";
			seenQueries.push(query);
			const time = Number(url.searchParams.get("time"));
			const previous = Date.now() / 1_000 - time > 1_800;
			const value = metricValue(query) * (previous ? 0.5 : 1);
			response.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [time, String(value)] }] } }));
			return;
		}
		if (url.pathname === "/api/traces") {
			response.end(JSON.stringify({ data: [{
				traceID: "0123456789abcdef0123456789abcdef",
				spans: [
					{ operationName: "pi.subagent.process", startTime: 1_000_000, duration: 20_000, tags: [{ key: "outcome", value: "failed" }, { key: "error_category", value: "timeout" }, { key: "cwd", value: canary }] },
					{ operationName: "untrusted.operation", startTime: 1_000_000, duration: 99_000, tags: [{ key: "error.message", value: canary }] },
				],
			}] }));
			return;
		}
		if (url.pathname === "/api/v1/status/buildinfo") {
			response.end(JSON.stringify({ status: "success", data: {} }));
			return;
		}
		if (url.pathname === "/api/services") {
			response.end(JSON.stringify({ data: ["pi-subagent-extension"] }));
			return;
		}
		response.statusCode = 404;
		response.end("{}");
	}, async (origin) => {
		const config = loadSubagentTelemetryConfig({ env: {
			PI_SUBAGENT_OTEL_ENABLED: "1",
			PI_SUBAGENT_PROMETHEUS_URL: origin,
			PI_SUBAGENT_JAEGER_URL: origin,
		} });
		const client = new TelemetryAnalysisClient(config);
		const snapshot = await client.analyze({ window: "1h", focus: "all", comparePreviousPeriod: true, maxTraceExamples: 5 });
		assert.equal(snapshot.prometheusAvailable, true);
		assert.equal(snapshot.jaegerAvailable, true);
		assert.equal(snapshot.metrics.length, TELEMETRY_QUERY_IDS.length);
		assert(snapshot.metrics.every((metric) => metric.available && metric.previousValue !== undefined));
		assert(snapshot.violations.some((violation) => violation.id === "success_rate"));
		assert(snapshot.violations.some((violation) => violation.id === "queue_duration_p95"));
		assert.equal(snapshot.traceExamples[0].outcome, "failed");
		assert.equal(snapshot.traceExamples[0].errorCategory, "timeout");
		assert.deepEqual(snapshot.traceExamples[0].operations, ["pi.subagent.process"]);
		assert(!JSON.stringify(snapshot).includes(canary));
		assert(seenQueries.length === TELEMETRY_QUERY_IDS.length * 2);
		assert(seenQueries.every((query) => !query.includes(canary)));
		const availability = await client.probe();
		assert.deepEqual(availability, { prometheus: true, jaeger: true });
		const text = formatTelemetryAnalysis(snapshot, 2_000);
		assert(text.includes("Pi Subagent Telemetry Analysis"));
		assert(text.length <= 2_000);
	});
});

test("analysis client degrades to bounded unavailable results and skips previous 7d period", async () => {
	let prometheusQueries = 0;
	await withServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname === "/api/v1/query") prometheusQueries += 1;
		response.statusCode = 503;
		response.end("unavailable");
	}, async (origin) => {
		const config = loadSubagentTelemetryConfig({ env: { PI_SUBAGENT_PROMETHEUS_URL: origin, PI_SUBAGENT_JAEGER_URL: origin } });
		const client = new TelemetryAnalysisClient(config);
		const snapshot = await client.analyze({ window: "7d", focus: "reliability", comparePreviousPeriod: true, maxTraceExamples: 1 });
		assert.equal(snapshot.prometheusAvailable, false);
		assert.equal(snapshot.jaegerAvailable, false);
		assert(snapshot.metrics.every((metric) => !metric.available));
		assert(snapshot.warnings.some((warning) => warning.includes("seven-day")));
		assert.equal(prometheusQueries, snapshot.metrics.length);
		assert(formatTelemetryAnalysis(snapshot, 512).length <= 512);
	});
});
