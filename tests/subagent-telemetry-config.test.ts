import assert from "node:assert/strict";
import test from "node:test";
import { loadSubagentTelemetryConfig, safeEndpointOrigin, TELEMETRY_CONFIG_DEFAULTS } from "../subagent/telemetry/Config.ts";
import { NOOP_SUBAGENT_TELEMETRY, NoopSubagentTelemetry } from "../subagent/telemetry/NoopTelemetry.ts";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { ...overrides };
}

test("telemetry config is disabled and loopback-only by default", () => {
	const config = loadSubagentTelemetryConfig({ env: env() });
	assert.equal(config.enabled, false);
	assert.equal(config.requestedEnabled, false);
	assert.equal(config.issues.length, 0);
	assert.equal(config.traces.endpoint.toString(), "http://127.0.0.1:4318/v1/traces");
	assert.equal(config.metrics.endpoint.toString(), "http://127.0.0.1:4318/v1/metrics");
	assert.equal(config.logs.endpoint.toString(), "http://127.0.0.1:4318/v1/logs");
	assert.equal(config.prometheusUrl.toString(), `${TELEMETRY_CONFIG_DEFAULTS.prometheusUrl}/`);
	assert.equal(config.jaegerUrl.toString(), `${TELEMETRY_CONFIG_DEFAULTS.jaegerUrl}/`);
});

test("telemetry config resolves per-signal endpoint and header precedence", () => {
	const config = loadSubagentTelemetryConfig({
		env: env({
			PI_SUBAGENT_OTEL_ENABLED: "yes",
			PI_SUBAGENT_OTEL_ENDPOINT: "http://localhost:4318/collector/",
			OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:9999/custom-traces",
			OTEL_EXPORTER_OTLP_HEADERS: "authorization=shared%20token,x-scope=dev",
			OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=trace%20token",
			PI_SUBAGENT_OTEL_QUERY_HEADERS: JSON.stringify({ authorization: "query token" }),
		}),
	});
	assert.equal(config.enabled, true);
	assert.equal(config.traces.endpoint.toString(), "http://127.0.0.1:9999/custom-traces");
	assert.equal(config.metrics.endpoint.toString(), "http://localhost:4318/collector/v1/metrics");
	assert.deepEqual(config.traces.headers, { authorization: "trace token" });
	assert.deepEqual(config.metrics.headers, { authorization: "shared token", "x-scope": "dev" });
	assert.deepEqual(config.queryHeaders, { authorization: "query token" });
	assert.equal(safeEndpointOrigin(config.traces.endpoint), "http://127.0.0.1:9999");
});

test("telemetry config fails closed for remote HTTP or unapproved remote endpoints", () => {
	const unapproved = loadSubagentTelemetryConfig({
		env: env({ PI_SUBAGENT_OTEL_ENABLED: "1", PI_SUBAGENT_OTEL_ENDPOINT: "https://collector.example.test" }),
	});
	assert.equal(unapproved.requestedEnabled, true);
	assert.equal(unapproved.enabled, false);
	assert(unapproved.issues.some((item) => item.code === "remote_not_allowed"));

	const insecure = loadSubagentTelemetryConfig({
		env: env({
			PI_SUBAGENT_OTEL_ENABLED: "1",
			PI_SUBAGENT_OTEL_ALLOW_REMOTE: "1",
			PI_SUBAGENT_OTEL_ENDPOINT: "http://collector.example.test",
		}),
	});
	assert.equal(insecure.enabled, false);
	assert(insecure.issues.some((item) => item.code === "remote_requires_https"));

	const approved = loadSubagentTelemetryConfig({
		env: env({
			PI_SUBAGENT_OTEL_ENABLED: "1",
			PI_SUBAGENT_OTEL_ALLOW_REMOTE: "1",
			PI_SUBAGENT_OTEL_ENDPOINT: "https://collector.example.test/base",
			PI_SUBAGENT_PROMETHEUS_URL: "https://prometheus.example.test",
			PI_SUBAGENT_JAEGER_URL: "https://jaeger.example.test",
		}),
	});
	assert.equal(approved.enabled, true);
	assert.equal(approved.traces.endpoint.toString(), "https://collector.example.test/base/v1/traces");
});

test("telemetry config rejects invalid numbers, service names, credentials, and secret header shapes without echoing values", () => {
	const secret = "CANARY-DO-NOT-ECHO";
	const config = loadSubagentTelemetryConfig({
		env: env({
			PI_SUBAGENT_OTEL_ENABLED: "1",
			PI_SUBAGENT_OTEL_TRACE_SAMPLE_RATIO: "2",
			PI_SUBAGENT_OTEL_METRIC_INTERVAL_MS: "10",
			PI_SUBAGENT_OTEL_SERVICE_NAME: "bad service name",
			PI_SUBAGENT_OTEL_ENDPOINT: `http://user:${secret}@localhost:4318`,
			PI_SUBAGENT_OTEL_QUERY_HEADERS: JSON.stringify({ authorization: { secret } }),
		}),
	});
	assert.equal(config.enabled, false);
	assert(config.issues.some((item) => item.code === "invalid_sample_ratio"));
	assert(config.issues.some((item) => item.code === "invalid_metric_interval"));
	assert(config.issues.some((item) => item.code === "invalid_service_name"));
	assert(config.issues.some((item) => item.code === "endpoint_credentials"));
	assert(config.issues.some((item) => item.code === "invalid_headers"));
	assert(!JSON.stringify(config.issues).includes(secret));
});

test("no-op telemetry is side-effect-free and returns disabled health", async () => {
	const telemetry = new NoopSubagentTelemetry();
	telemetry.startSession({ projectPath: "/secret/repo" });
	telemetry.agentFirstProgress("agent_1");
	telemetry.endSession({ reason: "shutdown" });
	assert.deepEqual(telemetry.getHealth(), NOOP_SUBAGENT_TELEMETRY.getHealth());
	assert.equal(telemetry.getHealth().enabled, false);
	await telemetry.forceFlush();
	await telemetry.shutdown(1);
});
