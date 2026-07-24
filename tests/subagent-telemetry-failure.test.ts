import assert from "node:assert/strict";
import test from "node:test";
import { AggregationTemporality, InMemoryMetricExporter } from "../subagent/node_modules/@opentelemetry/sdk-metrics/build/src/index.js";
import { loadSubagentTelemetryConfig } from "../subagent/telemetry/Config.ts";
import { createOpenTelemetrySubagentTelemetry, OpenTelemetrySubagentTelemetry } from "../subagent/telemetry/OpenTelemetry.ts";
import { HmacTelemetryPrivacy, TELEMETRY_KEY_BYTES } from "../subagent/telemetry/Privacy.ts";

class ToggleExporter {
	fail = true;
	exported = 0;
	export(items: any, callback: (result: any) => void): void {
		this.exported += Array.isArray(items) ? items.length : 1;
		callback(this.fail ? { code: 1, error: new Error("collector unavailable CANARY") } : { code: 0 });
	}
	shutdown(): Promise<void> { return Promise.resolve(); }
	forceFlush(): Promise<void> { return Promise.resolve(); }
}

class ToggleMetricExporter extends InMemoryMetricExporter {
	fail = true;
	constructor() { super(AggregationTemporality.CUMULATIVE); }
	override export(items: any, callback: (result: any) => void): void {
		if (this.fail) callback({ code: 1, error: new Error("collector unavailable CANARY") });
		else super.export(items, callback);
	}
}

test("exporter failures are non-fatal, visible in health, and recover by signal", async () => {
	const config = loadSubagentTelemetryConfig({ env: { PI_SUBAGENT_OTEL_ENABLED: "1", PI_SUBAGENT_OTEL_METRIC_INTERVAL_MS: "60000" } });
	const trace = new ToggleExporter();
	const metrics = new ToggleMetricExporter();
	const logs = new ToggleExporter();
	const telemetry = new OpenTelemetrySubagentTelemetry(config, new HmacTelemetryPrivacy({ key: Buffer.alloc(TELEMETRY_KEY_BYTES, 2), scope: "process" }), { trace, metrics, logs });
	const now = Date.now();
	telemetry.startSession({ projectPath: "/repo", startedAt: now });
	telemetry.endSession({ endedAt: now + 1 });
	await assert.doesNotReject(telemetry.forceFlush());
	assert.equal(telemetry.getHealth().degraded, true);
	assert.equal(telemetry.getHealth().lastErrorCategory, "exporter");
	assert(telemetry.getHealth().droppedRecords > 0);

	trace.fail = false;
	metrics.fail = false;
	logs.fail = false;
	telemetry.startSession({ projectPath: "/repo", startedAt: now + 2 });
	telemetry.endSession({ endedAt: now + 3 });
	await telemetry.forceFlush();
	assert.equal(telemetry.getHealth().degraded, false);
	assert(telemetry.getHealth().lastSuccessfulExportAt);
	await telemetry.shutdown(1_000);
});

test("telemetry factory is no-op while disabled and does not instantiate exporters", async () => {
	const config = loadSubagentTelemetryConfig({ env: {} });
	let touched = false;
	const exporter = new Proxy({}, { get() { touched = true; throw new Error("must not touch exporter"); } });
	const telemetry = await createOpenTelemetrySubagentTelemetry(config, { exporters: { trace: exporter, metrics: exporter, logs: exporter } });
	assert.equal(telemetry.getHealth().enabled, false);
	assert.equal(touched, false);
	await telemetry.forceFlush();
	await telemetry.shutdown(1);
});

test("shutdown is bounded when exporters never finish shutdown", async () => {
	const config = loadSubagentTelemetryConfig({ env: { PI_SUBAGENT_OTEL_ENABLED: "1", PI_SUBAGENT_OTEL_METRIC_INTERVAL_MS: "60000" } });
	const never = {
		export(_items: any, callback: (result: any) => void) { callback({ code: 0 }); },
		shutdown() { return new Promise<void>(() => {}); },
		forceFlush() { return Promise.resolve(); },
	};
	const metrics = new ToggleMetricExporter();
	metrics.fail = false;
	const telemetry = new OpenTelemetrySubagentTelemetry(config, new HmacTelemetryPrivacy({ key: Buffer.alloc(TELEMETRY_KEY_BYTES, 4), scope: "process" }), { trace: never, metrics, logs: never });
	const started = Date.now();
	await telemetry.shutdown(25);
	assert(Date.now() - started < 500);
	assert.equal(telemetry.getHealth().degraded, true);
});
