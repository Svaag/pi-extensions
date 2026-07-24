import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { RouterTelemetryAnalysisClient, ROUTER_TELEMETRY_QUERY_IDS } from "../model-router/src/telemetry/AnalysisClient.ts";

async function withServer(value: number, run: (origin: string, queries: string[]) => Promise<void>) {
	const queries: string[] = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		response.setHeader("content-type", "application/json");
		if (url.pathname === "/api/v1/query") {
			queries.push(url.searchParams.get("query") ?? "");
			response.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [Date.now() / 1000, String(value)] }] } }));
			return;
		}
		response.end(JSON.stringify({ data: [] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server unavailable");
	try { await run(`http://127.0.0.1:${address.port}`, queries); }
	finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("router telemetry fixed catalog reports zero samples as unavailable and blocks rollout", async () => {
	await withServer(0, async (origin, queries) => {
		const snapshot = await new RouterTelemetryAnalysisClient({ prometheusUrl: new URL(origin), jaegerUrl: new URL(origin) }).analyze({ focus: "all", comparePreviousPeriod: false, maxTraceExamples: 0 });
		assert.equal(snapshot.violations.length, 0);
		assert.equal(snapshot.rolloutReadiness.ready, false);
		assert(snapshot.warnings.some((warning) => warning.includes("Insufficient data")));
		assert(snapshot.metrics.filter((metric) => metric.unit === "ratio" || metric.unit === "score").every((metric) => !metric.available && metric.error === "zero_denominator"));
		assert(queries.length >= ROUTER_TELEMETRY_QUERY_IDS.length);
		assert(queries.every((query) => !query.includes("/private/") && !query.includes("prompt")));
	});
});
