import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	classifyTelemetryError,
	createTelemetryPrivacy,
	filterMetricAttributes,
	filterSpanLogAttributes,
	HmacTelemetryPrivacy,
	loadOrCreateTelemetryKey,
	normalizeTelemetryLabel,
	TELEMETRY_HASH_HEX_CHARS,
	TELEMETRY_KEY_BYTES,
} from "../subagent/telemetry/Privacy.ts";

test("telemetry privacy creates and reuses a 0600 machine key", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-telemetry-key-"));
	const keyPath = join(dir, "key");
	try {
		const first = await loadOrCreateTelemetryKey({ keyPath });
		const second = await loadOrCreateTelemetryKey({ keyPath });
		assert.equal(first.scope, "machine");
		assert.equal(second.scope, "machine");
		assert.equal(first.keyPath, keyPath);
		assert.deepEqual(first.key, second.key);
		assert.equal((await readFile(keyPath)).length, TELEMETRY_KEY_BYTES);
		if (process.platform !== "win32") assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("telemetry privacy falls back to a process key when the persisted key is invalid", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-telemetry-invalid-key-"));
	const keyPath = join(dir, "key");
	try {
		await writeFile(keyPath, "not-a-32-byte-key", { mode: 0o600 });
		const result = await loadOrCreateTelemetryKey({ keyPath });
		assert.equal(result.scope, "process");
		assert.equal(result.keyPath, undefined);
		assert.equal(result.key.length, TELEMETRY_KEY_BYTES);
		assert.equal(await readFile(keyPath, "utf8"), "not-a-32-byte-key");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("HMAC identifiers are stable by kind and never expose the input", () => {
	const privacy = new HmacTelemetryPrivacy({ key: Buffer.alloc(TELEMETRY_KEY_BYTES, 7), scope: "process" });
	const project = privacy.hashIdentifier("project", "/home/user/secret-project");
	assert.equal(project.length, TELEMETRY_HASH_HEX_CHARS);
	assert.equal(project, privacy.hashIdentifier("project", "/home/user/secret-project"));
	assert.notEqual(project, privacy.hashIdentifier("task", "/home/user/secret-project"));
	assert(!project.includes("secret-project"));
});

test("error sanitization exports category/type/hash but not the message", () => {
	const privacy = new HmacTelemetryPrivacy({ key: Buffer.alloc(TELEMETRY_KEY_BYTES, 3), scope: "process" });
	const canary = "CANARY secret provider payload";
	const sanitized = privacy.sanitizeError(new TypeError(`context window exceeded: ${canary}`));
	assert.equal(sanitized.category, "context_window");
	assert.equal(sanitized.type, "TypeError");
	assert.equal(sanitized.messageHash.length, TELEMETRY_HASH_HEX_CHARS);
	assert(!JSON.stringify(sanitized).includes(canary));
	assert.equal(classifyTelemetryError("RPC process closed"), "rpc_closed");
	assert.equal(classifyTelemetryError("Timed out after 300000 ms"), "timeout");
	assert.equal(classifyTelemetryError("Subagent child policy blocked this path"), "policy_block");
});

test("attribute filters enforce allowlists and bounded normalized values", () => {
	const canary = "/home/user/CANARY/private.ts";
	const metric = filterMetricAttributes({
		outcome: "succeeded",
		model: "provider/model with spaces",
		"agent.id": "must-not-be-a-metric-label",
		cwd: canary,
		cost: Number.NaN,
	});
	assert.deepEqual(metric, { outcome: "succeeded", model: "provider/model_with_spaces" });
	assert(!JSON.stringify(metric).includes(canary));

	const span = filterSpanLogAttributes({
		"agent.id": "agent_1",
		"project.id": "abc123",
		"prompt.chars": 42,
		prompt: canary,
		"error.message": canary,
	});
	assert.deepEqual(span, { "agent.id": "agent_1", "project.id": "abc123", "prompt.chars": 42 });
	assert.equal(normalizeTelemetryLabel("  !!!  "), "other");
	assert.equal(normalizeTelemetryLabel("x".repeat(100)).length, 80);
});

test("createTelemetryPrivacy honors an explicit key path", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-telemetry-privacy-"));
	try {
		const privacy = await createTelemetryPrivacy({ keyPath: join(dir, "custom-key") });
		assert.equal(privacy.hashScope, "machine");
		assert.equal(privacy.hashIdentifier("session", "session-1").length, TELEMETRY_HASH_HEX_CHARS);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
