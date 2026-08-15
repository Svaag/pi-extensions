import assert from "node:assert/strict";
import test from "node:test";
import { buildInheritedContext, buildVisibleSessionContext, redactSecrets, sanitizeContextText } from "../subagent/core/ContextSanitizer.ts";

test("redactSecrets removes common token assignments", () => {
	const text = "OPENAI_API_KEY=sk-testsecret123456789 TOKEN: ghp_abcdefghijklmnopqrstuvwxyz";
	const redacted = redactSecrets(text);
	assert(!redacted.includes("sk-testsecret"));
	assert(!redacted.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
	assert(redacted.includes("[REDACTED"));
});

test("sanitizeContextText caps inherited context", () => {
	const text = `prefix ${"x".repeat(5000)} suffix`;
	const out = sanitizeContextText(text, 1000);
	assert(out.length <= 1000);
	assert(out.includes("omitted"));
});

test("buildInheritedContext returns empty for fresh mode", () => {
	assert.equal(buildInheritedContext({ mode: "fresh", contextSummary: "secret" }), "");
});

test("buildInheritedContext supports full_sanitized follow-up context", () => {
	const context = buildInheritedContext({ mode: "full_sanitized", contextSummary: "TOKEN=secret-value useful finding" });
	assert.match(context, /useful finding/);
	assert.doesNotMatch(context, /secret-value/);
});

test("buildVisibleSessionContext excludes tools and sanitizes the full visible conversation", () => {
	const context = buildVisibleSessionContext([
		{ message: { role: "user", content: [{ type: "text", text: "First request TOKEN=secret-value" }] } },
		{ message: { role: "toolResult", content: [{ type: "text", text: "private tool output" }] } },
		{ message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden reasoning" }, { type: "text", text: "First answer" }] } },
		{ message: { role: "user", content: [{ type: "text", text: "Second request" }] } },
		{ message: { role: "assistant", content: [{ type: "text", text: "Second answer" }] } },
	], { mode: "full_sanitized" });
	assert.match(context, /First request/);
	assert.match(context, /Second answer/);
	assert.doesNotMatch(context, /secret-value|private tool output/);
});

test("buildVisibleSessionContext selects the requested number of user turns", () => {
	const entries = [
		{ message: { role: "user", content: "First request" } },
		{ message: { role: "assistant", content: "First answer" } },
		{ message: { role: "user", content: "Second request" } },
		{ message: { role: "assistant", content: "Second answer" } },
	];
	const context = buildVisibleSessionContext(entries, { mode: "last_n_turns", contextTurns: 1 });
	assert.doesNotMatch(context, /First request|First answer/);
	assert.match(context, /Second request/);
	assert.match(context, /Second answer/);
});
