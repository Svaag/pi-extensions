import assert from "node:assert/strict";
import test from "node:test";
import { buildSubprocessRpcArgs, formatRetryNote, isContextWindowError, textFromToolResult } from "../subagent/core/SubprocessRpcBackend.ts";

test("buildSubprocessRpcArgs includes routed model and thinking level", () => {
	const args = buildSubprocessRpcArgs({
		agentId: "agent_1",
		taskName: "demo",
		taskPath: "/root/demo",
		parentAgentId: null,
		status: "running",
		processState: "live_running",
		cwd: "/repo",
		prompt: "do work",
		model: "local-llamacpp/local-model",
		thinkingLevel: "off",
		createdAt: 1,
		updatedAt: 2,
		contextMode: "fresh",
		writeMode: "read_only",
		allowedPaths: [],
		outputTail: "",
		outputChars: 0,
		controllable: true,
	}, "/policy.ts", "/prompt.md");
	assert(args.includes("--model"));
	assert.equal(args[args.indexOf("--model") + 1], "local-llamacpp/local-model");
	assert(args.includes("--thinking"));
	assert.equal(args[args.indexOf("--thinking") + 1], "off");
});

test("isContextWindowError recognizes provider overflow wording", () => {
	assert.equal(isContextWindowError("Your input exceeds the context window of this model. Please adjust your input and try again."), true);
	assert.equal(isContextWindowError("maximum context length is 200000 tokens"), true);
	assert.equal(isContextWindowError("ordinary model failure"), false);
});

test("textFromToolResult extracts text content and full-output path", () => {
	const text = textFromToolResult({
		content: [
			{ type: "text", text: "hello" },
			{ type: "image", data: "ignored" },
			{ type: "text", text: "world" },
		],
		details: { fullOutputPath: "/tmp/full.log" },
	});
	assert.equal(text, "hello\nworld\n[Full output saved by child at /tmp/full.log]");
});

test("formatRetryNote surfaces backoff attempt, delay, and compacted provider error", () => {
	const note = formatRetryNote(2, 3, 4000, 'Mistral API error (429): {"object":"error","message":"Rate limit exceeded"}');
	assert.match(note, /\(attempt 2\/3\)/);
	assert.match(note, /retrying in 4\.0s/);
	assert.match(note, /Mistral API error \(429\)/);
	assert.ok(note.length < 200, "note should stay single-line compact");
});

test("formatRetryNote handles missing error and non-finite delay", () => {
	assert.match(formatRetryNote(1, 3, Number.NaN, undefined), /\(attempt 1\/3\)/);
});
