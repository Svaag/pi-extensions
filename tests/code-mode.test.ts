import assert from "node:assert/strict";
import test from "node:test";
import { ReplSession, type ReplToolBinding } from "../code-mode/repl.ts";
import {
	DEFAULT_EXEC_YIELD_TIME_MS,
	DEFAULT_MAX_OUTPUT_TOKENS,
	EXEC_TOOL_NAME,
	STRICT_MODE_PROMPT,
	WAIT_TOOL_DESCRIPTION,
	WAIT_TOOL_NAME,
	addUsage,
	budgetItems,
	buildExecDescription,
	buildNestedToolsSection,
	computeToolTransition,
	ensureJsonSerializable,
	isPlanModeExecuting,
	missingCellMessage,
	normalizeIdentifier,
	normalizeImageInput,
	parseExecSource,
	parseModeArg,
	parseModelRef,
	renderJsonSchemaToTs,
	resolveExecBudgets,
	runningNotice,
	stringifyForOutput,
	type ReplUsage,
} from "../code-mode/utils.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function echoTool(): ReplToolBinding {
	return {
		name: "echo",
		description: "Echo the args back as JSON",
		parameters: { type: "object" },
		run: async (args) => JSON.stringify(args),
	};
}

function fakeUsage(input: number): ReplUsage {
	return {
		input,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 5,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeSession(overrides: {
	tools?: ReplToolBinding[];
	llmQuery?: (prompt: string) => Promise<{ text: string; usage?: ReplUsage }>;
} = {}): ReplSession {
	return new ReplSession({
		tools: overrides.tools ?? [echoTool()],
		llmQuery: overrides.llmQuery ?? (async (prompt) => ({ text: `summary:${prompt}` })),
	});
}

function texts(outcome: { items: Array<{ type: string; text?: string }> }): string {
	return outcome.items
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

// ── parseExecSource ──────────────────────────────────────────────────────────

test("parseExecSource returns code unchanged without a pragma", () => {
	assert.deepEqual(parseExecSource("text('hi')"), { code: "text('hi')" });
});

test("parseExecSource parses a valid first-line pragma", () => {
	assert.deepEqual(parseExecSource('// @exec: {"yield_time_ms": 10}\ntext("hi")'), {
		code: 'text("hi")',
		yieldTimeMs: 10,
	});
	assert.deepEqual(
		parseExecSource('  // @exec: {"yield_time_ms": 10, "max_output_tokens": 5}\ntext("hi")'),
		{ code: 'text("hi")', yieldTimeMs: 10, maxOutputTokens: 5 },
	);
});

test("parseExecSource rejects empty source", () => {
	assert.throws(() => parseExecSource(""), /non-empty/);
	assert.throws(() => parseExecSource("   \n  "), /non-empty/);
});

test("parseExecSource rejects a pragma without code", () => {
	assert.throws(
		() => parseExecSource('// @exec: {"yield_time_ms": 10}'),
		/must be followed by JavaScript source/,
	);
});

test("parseExecSource rejects malformed pragmas", () => {
	assert.throws(() => parseExecSource("// @exec:\ntext(1)"), /must be a JSON object/);
	assert.throws(() => parseExecSource("// @exec: {nope}\ntext(1)"), /must be valid JSON/);
	assert.throws(() => parseExecSource('// @exec: [1]\ntext(1)'), /must be a JSON object/);
	assert.throws(() => parseExecSource('// @exec: {"yield_ms": 1}\ntext(1)'), /only supports/);
	assert.throws(() => parseExecSource('// @exec: {"yield_time_ms": -1}\ntext(1)'), /non-negative safe integer/);
	assert.throws(() => parseExecSource('// @exec: {"max_output_tokens": 1.5}\ntext(1)'), /non-negative safe integer/);
});

test("resolveExecBudgets precedence: args > pragma > defaults", () => {
	assert.deepEqual(resolveExecBudgets({}, {}), {
		yieldTimeMs: DEFAULT_EXEC_YIELD_TIME_MS,
		maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
	});
	assert.deepEqual(resolveExecBudgets({}, { yieldTimeMs: 5, maxOutputTokens: 6 }), {
		yieldTimeMs: 5,
		maxOutputTokens: 6,
	});
	assert.deepEqual(resolveExecBudgets({ yield_time_ms: 1 }, { yieldTimeMs: 5, maxOutputTokens: 6 }), {
		yieldTimeMs: 1,
		maxOutputTokens: 6,
	});
});

// ── normalizeIdentifier ──────────────────────────────────────────────────────

test("normalizeIdentifier rewrites invalid characters", () => {
	assert.equal(normalizeIdentifier("mcp__ologs__get_profile"), "mcp__ologs__get_profile");
	assert.equal(normalizeIdentifier("hidden-dynamic-tool"), "hidden_dynamic_tool");
	assert.equal(normalizeIdentifier("9lives"), "_lives");
	assert.equal(normalizeIdentifier(""), "_");
});

// ── renderJsonSchemaToTs ─────────────────────────────────────────────────────

test("renderJsonSchemaToTs renders flat objects with required/optional", () => {
	const schema = {
		type: "object",
		properties: { city: { type: "string" }, count: { type: "integer" } },
		required: ["city"],
		additionalProperties: false,
	};
	assert.equal(renderJsonSchemaToTs(schema), "{ city: string; count?: number; }");
});

test("renderJsonSchemaToTs renders property descriptions as comments", () => {
	const schema = {
		type: "object",
		properties: {
			weather: {
				type: "array",
				description: "look up weather for a given list of locations",
				items: {
					type: "object",
					properties: { location: { type: "string" } },
					required: ["location"],
					additionalProperties: false,
				},
			},
		},
		required: ["weather"],
		additionalProperties: false,
	};
	assert.equal(
		renderJsonSchemaToTs(schema),
		`{
  // look up weather for a given list of locations
  weather: Array<{ location: string; }>;
}`,
	);
});

test("renderJsonSchemaToTs renders enums, consts, and unions", () => {
	assert.equal(renderJsonSchemaToTs({ enum: ["a", "b"] }), '"a" | "b"');
	assert.equal(renderJsonSchemaToTs({ const: 42 }), "42");
	assert.equal(renderJsonSchemaToTs({ anyOf: [{ type: "string" }, { type: "null" }] }), "string | null");
	assert.equal(renderJsonSchemaToTs({ type: ["string", "boolean"] }), "string | boolean");
	assert.equal(
		renderJsonSchemaToTs({ allOf: [{ type: "string" }, { type: "string" }] }),
		"string & string",
	);
});

test("renderJsonSchemaToTs renders arrays, tuples, and index signatures", () => {
	assert.equal(renderJsonSchemaToTs({ type: "array", items: { type: "number" } }), "Array<number>");
	assert.equal(renderJsonSchemaToTs({ type: "array" }), "unknown[]");
	assert.equal(
		renderJsonSchemaToTs({ prefixItems: [{ type: "string" }, { type: "number" }] }),
		"[string, number]",
	);
	assert.equal(
		renderJsonSchemaToTs({ type: "object", additionalProperties: { type: "string" } }),
		"{ [key: string]: string; }",
	);
	assert.equal(renderJsonSchemaToTs({ type: "object", properties: {} }), "{ [key: string]: unknown; }");
	assert.equal(
		renderJsonSchemaToTs({ type: "object", properties: {}, additionalProperties: false }),
		"{}",
	);
});

test("renderJsonSchemaToTs handles edge cases", () => {
	assert.equal(renderJsonSchemaToTs(true), "unknown");
	assert.equal(renderJsonSchemaToTs(false), "never");
	assert.equal(renderJsonSchemaToTs(undefined), "unknown");
	assert.equal(renderJsonSchemaToTs({}), "unknown");
	assert.equal(
		renderJsonSchemaToTs({ type: "object", properties: { "not-an-ident": { type: "string" } } }),
		'{ "not-an-ident"?: string; }',
	);
});

// ── description builders ─────────────────────────────────────────────────────

test("buildExecDescription documents helpers, cells, and nested tools", () => {
	const description = buildExecDescription([
		{
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
			mayReturnContentBlocks: true,
		},
	]);
	assert.match(description, /fresh JavaScript sandbox/);
	assert.match(description, /yield_time_ms/);
	assert.match(description, /store\(key: string, value: any\)/);
	assert.match(description, /llm\.query\(prompt: string/);
	assert.match(description, /### `read`/);
	assert.match(description, /read\(args: \{ path: string; \}\): Promise<string \| ContentBlock\[\]>/);
	assert.match(description, /type ContentBlock =/);
});

test("buildNestedToolsSection is empty without tools", () => {
	assert.equal(buildNestedToolsSection([]), "");
});

test("WAIT_TOOL_DESCRIPTION documents the cell protocol", () => {
	assert.match(WAIT_TOOL_DESCRIPTION, /cell_id/);
	assert.match(WAIT_TOOL_DESCRIPTION, /terminate: true/);
	assert.match(WAIT_TOOL_DESCRIPTION, /unknown or already closed/);
});

test("STRICT_MODE_PROMPT names exec and the tools object", () => {
	assert.match(STRICT_MODE_PROMPT, new RegExp(`${EXEC_TOOL_NAME} and ${WAIT_TOOL_NAME}`));
	assert.match(STRICT_MODE_PROMPT, /tools\.read/);
});

// ── output helpers ───────────────────────────────────────────────────────────

test("stringifyForOutput matches codex semantics", () => {
	assert.equal(stringifyForOutput("hi"), "hi");
	assert.equal(stringifyForOutput(42), "42");
	assert.equal(stringifyForOutput({ a: 1 }), '{"a":1}');
	assert.equal(stringifyForOutput(undefined), "undefined");
	assert.equal(stringifyForOutput(null), "null");
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	assert.equal(stringifyForOutput(circular), "[object Object]");
});

test("ensureJsonSerializable round-trips and detaches values", () => {
	const input = { a: [1, 2], b: { c: "x" } };
	const stored = ensureJsonSerializable(input) as typeof input;
	assert.deepEqual(stored, input);
	assert.notEqual(stored, input);
	assert.notEqual(stored.b, input.b);
});

test("ensureJsonSerializable rejects non-serializable values", () => {
	assert.throws(() => ensureJsonSerializable(undefined), /JSON-serializable/);
	assert.throws(() => ensureJsonSerializable(() => 1), /JSON-serializable/);
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	assert.throws(() => ensureJsonSerializable(circular), /JSON-serializable/);
});

test("normalizeImageInput accepts blocks, data URLs, and base64+mime", () => {
	assert.deepEqual(normalizeImageInput({ type: "image", data: "AAAA", mimeType: "image/png" }), {
		type: "image",
		data: "AAAA",
		mimeType: "image/png",
	});
	assert.deepEqual(normalizeImageInput("data:image/png;base64,AAAA"), {
		type: "image",
		data: "AAAA",
		mimeType: "image/png",
	});
	assert.deepEqual(normalizeImageInput("AAAA", "image/jpeg"), {
		type: "image",
		data: "AAAA",
		mimeType: "image/jpeg",
	});
	assert.throws(() => normalizeImageInput("data:broken"), /could not parse/);
	assert.throws(() => normalizeImageInput("AAAA"), /expects a base64/);
	assert.throws(() => normalizeImageInput(42), /expects a base64/);
});

test("budgetItems keeps everything under budget", () => {
	const items = [
		{ type: "text" as const, text: "abc" },
		{ type: "image" as const, data: "x", mimeType: "image/png" },
	];
	const result = budgetItems(items, 100);
	assert.deepEqual(result, { items, truncated: false });
});

test("budgetItems drops oldest text first and keeps images", () => {
	const items = [
		{ type: "text" as const, text: "a".repeat(100) },
		{ type: "image" as const, data: "x", mimeType: "image/png" },
		{ type: "text" as const, text: "b".repeat(40) },
	];
	// 4 chars/token * 10 tokens = 40 chars budget → keeps only the final text.
	const result = budgetItems(items, 10);
	assert.equal(result.truncated, true);
	assert.equal(result.items.length, 2);
	assert.equal(result.items[0]?.type, "image");
	assert.deepEqual(result.items[1], { type: "text", text: "b".repeat(40) });
});

test("budgetItems trims the boundary item from the head", () => {
	const items = [{ type: "text" as const, text: `first\n${"x".repeat(100)}` }];
	const result = budgetItems(items, 10); // 40 chars
	assert.equal(result.truncated, true);
	assert.equal(result.items.length, 1);
	const text = result.items[0];
	assert.equal(text?.type, "text");
	assert.ok((text as { text: string }).text.length <= 40);
	assert.ok(!(text as { text: string }).text.startsWith("first"));
});

// ── usage ────────────────────────────────────────────────────────────────────

test("addUsage sums and handles undefined", () => {
	assert.equal(addUsage(undefined, undefined), undefined);
	const a = fakeUsage(10);
	assert.equal(addUsage(a, undefined), a);
	assert.equal(addUsage(undefined, a), a);
	const sum = addUsage(fakeUsage(10), fakeUsage(20));
	assert.equal(sum?.input, 30);
	assert.equal(sum?.totalTokens, 40);
	const withReasoning = addUsage({ ...fakeUsage(1), reasoning: 3 }, fakeUsage(1));
	assert.equal(withReasoning?.reasoning, 3);
});

// ── model refs ───────────────────────────────────────────────────────────────

test("parseModelRef splits provider/id", () => {
	assert.deepEqual(parseModelRef("anthropic/claude"), { provider: "anthropic", modelId: "claude" });
	assert.deepEqual(parseModelRef("openrouter/vendor/model"), {
		provider: "openrouter",
		modelId: "vendor/model",
	});
	assert.equal(parseModelRef("noslash"), undefined);
	assert.equal(parseModelRef("trailing/"), undefined);
	assert.equal(parseModelRef("/leading"), undefined);
});

// ── mode state machine ───────────────────────────────────────────────────────

test("parseModeArg toggles and parses explicit modes", () => {
	assert.deepEqual(parseModeArg("off", ""), { action: "set", mode: "strict" });
	assert.deepEqual(parseModeArg("strict", ""), { action: "set", mode: "off" });
	assert.deepEqual(parseModeArg("hybrid", ""), { action: "set", mode: "off" });
	assert.deepEqual(parseModeArg("off", "hybrid"), { action: "set", mode: "hybrid" });
	assert.deepEqual(parseModeArg("off", "status"), { action: "status" });
	const bad = parseModeArg("off", "bogus");
	assert.equal(bad.action, "error");
});

test("computeToolTransition: off→strict snapshots without mode tools", () => {
	const result = computeToolTransition({
		target: "strict",
		currentMode: "off",
		currentActive: ["read", "bash", EXEC_TOOL_NAME, WAIT_TOOL_NAME],
		previousTools: undefined,
	});
	assert.deepEqual(result.active, [EXEC_TOOL_NAME, WAIT_TOOL_NAME]);
	assert.deepEqual(result.previousTools, ["read", "bash"]);
});

test("computeToolTransition: strict→off restores the snapshot", () => {
	const result = computeToolTransition({
		target: "off",
		currentMode: "strict",
		currentActive: [EXEC_TOOL_NAME, WAIT_TOOL_NAME],
		previousTools: ["read", "bash"],
	});
	assert.deepEqual(result.active, ["read", "bash"]);
	assert.equal(result.previousTools, undefined);
});

test("computeToolTransition: off→hybrid is additive and records the base", () => {
	const result = computeToolTransition({
		target: "hybrid",
		currentMode: "off",
		currentActive: ["read"],
		previousTools: undefined,
	});
	assert.deepEqual(result.active, ["read", EXEC_TOOL_NAME, WAIT_TOOL_NAME]);
	assert.deepEqual(result.previousTools, ["read"]);
});

test("computeToolTransition: strict→hybrid rebuilds from the snapshot", () => {
	const result = computeToolTransition({
		target: "hybrid",
		currentMode: "strict",
		currentActive: [EXEC_TOOL_NAME, WAIT_TOOL_NAME],
		previousTools: ["read", "grep"],
	});
	assert.deepEqual(result.active, ["read", "grep", EXEC_TOOL_NAME, WAIT_TOOL_NAME]);
	assert.deepEqual(result.previousTools, ["read", "grep"]);
});

test("computeToolTransition: re-entering strict keeps the original snapshot", () => {
	const result = computeToolTransition({
		target: "strict",
		currentMode: "strict",
		currentActive: [EXEC_TOOL_NAME, WAIT_TOOL_NAME],
		previousTools: ["read"],
	});
	assert.deepEqual(result.active, [EXEC_TOOL_NAME, WAIT_TOOL_NAME]);
	assert.deepEqual(result.previousTools, ["read"]);
});

test("computeToolTransition: off without a snapshot just removes mode tools", () => {
	const result = computeToolTransition({
		target: "off",
		currentMode: "hybrid",
		currentActive: ["read", EXEC_TOOL_NAME, WAIT_TOOL_NAME],
		previousTools: undefined,
	});
	assert.deepEqual(result.active, ["read"]);
});

// ── plan-mode gate predicate ─────────────────────────────────────────────────

test("isPlanModeExecuting reads the latest plan-mode entry", () => {
	assert.equal(isPlanModeExecuting([]), false);
	assert.equal(
		isPlanModeExecuting([{ type: "custom", customType: "plan-mode", data: { executing: true } }]),
		true,
	);
	assert.equal(
		isPlanModeExecuting([
			{ type: "custom", customType: "plan-mode", data: { executing: true } },
			{ type: "custom", customType: "plan-mode", data: { executing: false } },
		]),
		false,
	);
	assert.equal(
		isPlanModeExecuting([{ type: "custom", customType: "other", data: { executing: true } }]),
		false,
	);
});

// ── ReplSession: basics ──────────────────────────────────────────────────────

test("exec completes and returns text() output", async () => {
	const session = makeSession();
	const outcome = await session.execute(`text("hi");`, { yieldTimeMs: 100, maxOutputTokens: 100 });
	assert.equal(outcome.state, "completed");
	assert.equal(texts(outcome), "hi");
});

test("exec runs nested tools via the tools object", async () => {
	const session = makeSession();
	const outcome = await session.execute(`text(await tools.echo({ a: 1 }));`, {
		yieldTimeMs: 100,
		maxOutputTokens: 100,
	});
	assert.equal(outcome.state, "completed");
	assert.equal(texts(outcome), '{"a":1}');
});

test("nested tool failures reject inside the sandbox and are catchable", async () => {
	const session = makeSession({
		tools: [
			{
				name: "fail",
				description: "Always fails",
				parameters: {},
				run: async () => {
					throw new Error("tool exploded");
				},
			},
		],
	});
	const caught = await session.execute(
		`try { await tools.fail({}); text("not reached"); } catch (error) { text("caught: " + error.message); }`,
		{ yieldTimeMs: 100, maxOutputTokens: 100 },
	);
	assert.equal(caught.state, "completed");
	assert.equal(texts(caught), "caught: tool exploded");

	const uncaught = await session.execute(`await tools.fail({});`, {
		yieldTimeMs: 100,
		maxOutputTokens: 100,
	});
	assert.equal(uncaught.state, "failed");
	assert.equal(uncaught.errorText, "tool exploded");
	assert.match(texts(uncaught), /Uncaught tool exploded/);
});

test("uncaught syntax and runtime errors complete in-band", async () => {
	const session = makeSession();
	const syntax = await session.execute(`const x = ;`, { yieldTimeMs: 100, maxOutputTokens: 100 });
	assert.equal(syntax.state, "failed");
	assert.ok(syntax.errorText);

	const runtime = await session.execute(`throw new Error("boom");`, {
		yieldTimeMs: 100,
		maxOutputTokens: 100,
	});
	assert.equal(runtime.state, "failed");
	assert.equal(runtime.errorText, "boom");
});

test("exit() ends the script successfully and immediately", async () => {
	const session = makeSession();
	const outcome = await session.execute(`text("before"); exit(); text("after");`, {
		yieldTimeMs: 100,
		maxOutputTokens: 100,
	});
	assert.equal(outcome.state, "completed");
	assert.equal(texts(outcome), "before");
});

test("a script with no output reports it", async () => {
	const session = makeSession();
	const outcome = await session.execute(`const x = 1;`, { yieldTimeMs: 100, maxOutputTokens: 100 });
	assert.equal(outcome.state, "completed");
	assert.match(texts(outcome), /no output/);
});

test("the sandbox has no console, process, or require", async () => {
	const session = makeSession();
	const outcome = await session.execute(
		`text([typeof console, typeof process, typeof require, typeof fetch].join(","));`,
		{ yieldTimeMs: 100, maxOutputTokens: 100 },
	);
	assert.equal(texts(outcome), "undefined,undefined,undefined,undefined");
});

test("each exec call gets a fresh sandbox", async () => {
	const session = makeSession();
	await session.execute(`globalThis.leaked = 42;`, { yieldTimeMs: 100, maxOutputTokens: 100 });
	const outcome = await session.execute(`text(typeof globalThis.leaked);`, {
		yieldTimeMs: 100,
		maxOutputTokens: 100,
	});
	assert.equal(texts(outcome), "undefined");
});

// ── ReplSession: store/load ──────────────────────────────────────────────────

test("store/load keep values across exec calls", async () => {
	const session = makeSession();
	await session.execute(`store("k", { v: 42 });`, { yieldTimeMs: 100, maxOutputTokens: 100 });
	const outcome = await session.execute(`text(load("k").v + 1);`, {
		yieldTimeMs: 100,
		maxOutputTokens: 100,
	});
	assert.equal(texts(outcome), "43");
	const missing = await session.execute(`text(String(load("nope")));`, {
		yieldTimeMs: 100,
		maxOutputTokens: 100,
	});
	assert.equal(texts(missing), "undefined");
});

test("store rejects non-serializable values", async () => {
	const session = makeSession();
	const outcome = await session.execute(`store("k", () => 1);`, {
		yieldTimeMs: 100,
		maxOutputTokens: 100,
	});
	assert.equal(outcome.state, "failed");
	assert.match(outcome.errorText ?? "", /JSON-serializable/);
});

// ── ReplSession: cells, yield, wait ──────────────────────────────────────────

test("long-running scripts yield with a cell ID and complete via wait", async () => {
	const session = makeSession();
	const yielded = await session.execute(
		`text("early"); await new Promise(r => setTimeout(r, 50)); text("late");`,
		{ yieldTimeMs: 10, maxOutputTokens: 100 },
	);
	assert.equal(yielded.state, "yielded");
	assert.match(texts(yielded), /early/);
	assert.match(texts(yielded), new RegExp(runningNotice(yielded.cellId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

	const completed = await session.wait(yielded.cellId, { yieldTimeMs: 1000, maxOutputTokens: 100 });
	assert.equal(completed.state, "completed");
	assert.equal(texts(completed), "late"); // only new output since the yield
});

test("wait on an unknown cell reports a missing cell", async () => {
	const session = makeSession();
	const outcome = await session.wait("cell-999", { yieldTimeMs: 10, maxOutputTokens: 100 });
	assert.equal(outcome.state, "missing");
	assert.equal(texts(outcome), missingCellMessage("cell-999"));
});

test("yield_control returns accumulated output while the script keeps running", async () => {
	const session = makeSession();
	const yielded = await session.execute(
		`text("a"); yield_control(); await new Promise(r => setTimeout(r, 30)); text("b");`,
		{ yieldTimeMs: 10_000, maxOutputTokens: 100 },
	);
	assert.equal(yielded.state, "yielded");
	assert.match(texts(yielded), /a/);

	const completed = await session.wait(yielded.cellId, { yieldTimeMs: 1000, maxOutputTokens: 100 });
	assert.equal(completed.state, "completed");
	assert.equal(texts(completed), "b");
});

test("wait with terminate stops the cell and reports it", async () => {
	const session = makeSession();
	const yielded = await session.execute(
		`text("start"); await new Promise(r => setTimeout(r, 10_000)); text("never");`,
		{ yieldTimeMs: 10, maxOutputTokens: 100 },
	);
	assert.equal(yielded.state, "yielded");

	const terminated = await session.wait(yielded.cellId, {
		yieldTimeMs: 1000,
		maxOutputTokens: 100,
		terminate: true,
	});
	assert.equal(terminated.state, "terminated");
	// "start" was already delivered by the exec yield; wait returns only new output.
	assert.match(texts(yielded), /start/);
	assert.doesNotMatch(texts(terminated), /start/);
	assert.match(texts(terminated), /terminated/i);

	const after = await session.wait(yielded.cellId, { yieldTimeMs: 10, maxOutputTokens: 100 });
	assert.equal(after.state, "missing");
});

test("output budgets truncate old text and flag the outcome", async () => {
	const session = makeSession();
	const outcome = await session.execute(`text("x".repeat(1000));`, {
		yieldTimeMs: 100,
		maxOutputTokens: 5, // 20 chars
	});
	assert.equal(outcome.state, "completed");
	assert.equal(outcome.truncated, true);
	assert.ok(texts(outcome).length <= 20);
});

// ── ReplSession: llm.query ───────────────────────────────────────────────────

test("llm.query returns text and aggregates usage", async () => {
	const session = makeSession({
		llmQuery: async (prompt) => ({ text: `summary:${prompt}`, usage: fakeUsage(10) }),
	});
	const outcome = await session.execute(
		`const a = await llm.query("first"); const b = await llm.query("second"); text(a + "|" + b);`,
		{ yieldTimeMs: 100, maxOutputTokens: 100 },
	);
	assert.equal(outcome.state, "completed");
	assert.equal(texts(outcome), "summary:first|summary:second");
	assert.equal(outcome.usage?.input, 20);
	assert.equal(outcome.usage?.totalTokens, 30);
});

test("llm.query usage is reported as deltas across yield/wait", async () => {
	const session = makeSession({
		llmQuery: async () => ({ text: "ok", usage: fakeUsage(10) }),
	});
	const yielded = await session.execute(
		`await llm.query("one"); yield_control(); await llm.query("two"); text("done");`,
		{ yieldTimeMs: 10_000, maxOutputTokens: 100 },
	);
	assert.equal(yielded.state, "yielded");
	assert.equal(yielded.usage?.input, 10);

	const completed = await session.wait(yielded.cellId, { yieldTimeMs: 1000, maxOutputTokens: 100 });
	assert.equal(completed.state, "completed");
	assert.equal(completed.usage?.input, 10); // only the second query
});

test("llm.query is unavailable without a provider", async () => {
	const session = new ReplSession({ tools: [echoTool()] });
	const outcome = await session.execute(`await llm.query("hi");`, {
		yieldTimeMs: 100,
		maxOutputTokens: 100,
	});
	assert.equal(outcome.state, "failed");
	assert.match(outcome.errorText ?? "", /unavailable/);
});

test("llm.query validates its arguments", async () => {
	const session = makeSession();
	const outcome = await session.execute(`await llm.query(42);`, {
		yieldTimeMs: 100,
		maxOutputTokens: 100,
	});
	assert.equal(outcome.state, "failed");
	assert.match(outcome.errorText ?? "", /non-empty string prompt/);
});

// ── ReplSession: misc globals ────────────────────────────────────────────────

test("ALL_TOOLS exposes nested tool metadata", async () => {
	const session = makeSession();
	const outcome = await session.execute(
		`text(ALL_TOOLS.map(t => t.name).join(","));`,
		{ yieldTimeMs: 100, maxOutputTokens: 100 },
	);
	assert.equal(texts(outcome), "echo");
});

test("setTimeout works when awaited and is otherwise dropped", async () => {
	const session = makeSession();
	const awaited = await session.execute(
		`await new Promise(r => setTimeout(r, 20)); text("after timer");`,
		{ yieldTimeMs: 1000, maxOutputTokens: 100 },
	);
	assert.equal(awaited.state, "completed");
	assert.equal(texts(awaited), "after timer");

	// An unawaited pending timer does not keep the cell alive.
	const dropped = await session.execute(`setTimeout(() => text("never"), 50); text("now");`, {
		yieldTimeMs: 1000,
		maxOutputTokens: 100,
	});
	assert.equal(dropped.state, "completed");
	assert.equal(texts(dropped), "now");
});

test("image() appends image items", async () => {
	const session = makeSession();
	const outcome = await session.execute(`image("data:image/png;base64,AAAA");`, {
		yieldTimeMs: 100,
		maxOutputTokens: 100,
	});
	assert.equal(outcome.state, "completed");
	assert.deepEqual(outcome.items, [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
});

test("dispose terminates running cells", async () => {
	const session = makeSession();
	const yielded = await session.execute(`await new Promise(r => setTimeout(r, 10_000));`, {
		yieldTimeMs: 10,
		maxOutputTokens: 100,
	});
	assert.equal(yielded.state, "yielded");
	session.dispose();
	const outcome = await session.wait(yielded.cellId, { yieldTimeMs: 10, maxOutputTokens: 100 });
	assert.equal(outcome.state, "missing");
});
