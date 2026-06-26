import assert from "node:assert/strict";
import test from "node:test";
import { textFromToolResult } from "../subagent/core/SubprocessRpcBackend.ts";

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
