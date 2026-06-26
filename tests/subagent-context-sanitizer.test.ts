import assert from "node:assert/strict";
import test from "node:test";
import { buildInheritedContext, redactSecrets, sanitizeContextText } from "../subagent/core/ContextSanitizer.ts";

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

test("buildInheritedContext rejects unimplemented broad modes", () => {
	assert.throws(() => buildInheritedContext({ mode: "full_sanitized", contextSummary: "x" }), /not implemented/);
});
