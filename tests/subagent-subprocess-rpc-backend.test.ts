import assert from "node:assert/strict";
import test from "node:test";
import { buildSubprocessRpcArgs, textFromToolResult } from "../subagent/core/SubprocessRpcBackend.ts";

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
