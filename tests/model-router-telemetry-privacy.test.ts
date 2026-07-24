import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRouterTelemetryPrivacy, filterRouterMetricAttributes, filterRouterSpanAttributes } from "../model-router/src/telemetry/Privacy.ts";

test("router telemetry HMAC key is stable, private, and attribute allowlists discard content", async () => {
	const directory = await mkdtemp(join(tmpdir(), "router-privacy-"));
	try {
		const keyPath = join(directory, "key");
		const first = await createRouterTelemetryPrivacy({ keyPath });
		const second = await createRouterTelemetryPrivacy({ keyPath });
		assert.equal(first.hashIdentifier("project", "/private/repo"), second.hashIdentifier("project", "/private/repo"));
		assert(!first.hashIdentifier("project", "/private/repo").includes("private"));
		assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
		const metrics = filterRouterMetricAttributes({ host: "sdk", model: "test/model", prompt: "CANARY", cwd: "/private/repo", "error.message": "secret" });
		assert.deepEqual(metrics, { host: "sdk", model: "test/model" });
		const spans = filterRouterSpanAttributes({ "route.id": "abc", "project.id": first.hashIdentifier("project", "/private/repo"), output: "CANARY", "tool.arguments": "secret" });
		assert.equal(spans["route.id"], "abc");
		assert(!JSON.stringify(spans).includes("CANARY"));
		assert(!JSON.stringify(spans).includes("secret"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
