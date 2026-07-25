import { downgradeSubagentThinking, parentThinkingLevel } from "../subagent/tools/common.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("downgradeSubagentThinking", () => {
	it("returns explicit level unchanged", () => {
		// When explicit is set, returns resolvedLevel unchanged (no downgrade).
		assert.equal(downgradeSubagentThinking("max", "max", "high"), "max");
		assert.equal(downgradeSubagentThinking("max", "max", "max"), "max");
		assert.equal(downgradeSubagentThinking("medium", "low", "off"), "low");
	});

	it("downgrades by 2 steps from resolved level when no explicit set", () => {
		// max(6) -> high(4)
		assert.equal(downgradeSubagentThinking("max", "max", undefined), "high");
		// xhigh(5) -> medium(3)
		assert.equal(downgradeSubagentThinking("xhigh", "xhigh", undefined), "medium");
		// high(4) -> low(2)
		assert.equal(downgradeSubagentThinking("high", "high", undefined), "low");
		// medium(3) -> minimal(1)
		assert.equal(downgradeSubagentThinking("medium", "medium", undefined), "minimal");
		// low(2) -> off(0)
		assert.equal(downgradeSubagentThinking("low", "low", undefined), "off");
	});

	it("downgrades from parent level when resolved is undefined", () => {
		assert.equal(downgradeSubagentThinking("max", undefined, undefined), "high");
		assert.equal(downgradeSubagentThinking("xhigh", undefined, undefined), "medium");
	});

	it("clamps at off", () => {
		assert.equal(downgradeSubagentThinking("off", "off", undefined), "off");
		assert.equal(downgradeSubagentThinking("minimal", "minimal", undefined), "off");
	});

	it("returns undefined when both parent and resolved are undefined", () => {
		assert.equal(downgradeSubagentThinking(undefined, undefined, undefined), undefined);
	});

	it("returns resolved level when explicit is set even if mismatch", () => {
		assert.equal(downgradeSubagentThinking("max", "low", "high"), "low");
	});
});

describe("parentThinkingLevel", () => {
	it("reads thinkingLevel from context", () => {
		assert.equal(parentThinkingLevel({ thinkingLevel: "max" }), "max");
		assert.equal(parentThinkingLevel({ thinkingLevel: "low" }), "low");
	});

	it("returns undefined for missing or invalid", () => {
		assert.equal(parentThinkingLevel({}), undefined);
		assert.equal(parentThinkingLevel({ thinkingLevel: 123 }), undefined);
		assert.equal(parentThinkingLevel(null), undefined);
	});
});