import assert from "node:assert/strict";
import test from "node:test";
import {
	BashOutputHighlighter,
	containsAnsi,
	detectFormat,
	highlightDiagnostics,
	highlightGrep,
	highlightLog,
	highlightTraceback,
	sanitizeAnsi,
	type BashToolResult,
} from "../tool-highlight/bash-highlighter.ts";
import type { HighlightFn } from "../tool-highlight/highlighter.ts";

const noopHighlight: HighlightFn = (code, lang) => `<<${lang}:${code}>>`;

function makeHighlighter(opts: { highlight?: HighlightFn; truecolor?: boolean; theme?: unknown }) {
	return new BashOutputHighlighter(
		opts.theme ?? { name: "test-theme" },
		opts.highlight ?? noopHighlight,
		opts.truecolor ?? true,
	);
}

// --- sanitizeAnsi / containsAnsi ---

test("sanitizeAnsi preserves SGR color codes", () => {
	const input = "\x1b[31mred\x1b[0m plain";
	assert.equal(sanitizeAnsi(input), input);
});

test("sanitizeAnsi strips cursor movement sequences", () => {
	const input = "before\x1b[2J\x1b[Hafter";
	assert.equal(sanitizeAnsi(input), "beforeafter");
});

test("sanitizeAnsi strips OSC hyperlinks", () => {
	const input = "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\";
	assert.equal(sanitizeAnsi(input), "link");
});

test("sanitizeAnsi strips non-SGR CSI sequences but keeps colors", () => {
	const input = "\x1b[31mred\x1b[2K\x1b[0m";
	assert.equal(sanitizeAnsi(input), "\x1b[31mred\x1b[0m");
});

test("containsAnsi detects SGR sequences", () => {
	assert.equal(containsAnsi("\x1b[31mred\x1b[0m"), true);
	assert.equal(containsAnsi("plain text"), false);
});

// --- detectFormat ---

test("detectFormat: ansi", () => {
	assert.equal(detectFormat("\x1b[31merror\x1b[0m"), "ansi");
});

test("detectFormat: diff", () => {
	assert.equal(detectFormat("diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts"), "diff");
	assert.equal(detectFormat("@@ -1,3 +1,4 @@\n old\n+new"), "diff");
});

test("detectFormat: json", () => {
	assert.equal(detectFormat('{"ok": true}'), "json");
	assert.equal(detectFormat('[1, 2, 3]'), "json");
	assert.equal(detectFormat('{"a": 1}\n{"b": 2}'), "json");
});

test("detectFormat: traceback python", () => {
	assert.equal(
		detectFormat("Traceback (most recent call last):\n  File \"x.py\", line 1"),
		"traceback",
	);
});

test("detectFormat: traceback javascript", () => {
	assert.equal(detectFormat("Error: boom\n    at foo (/app.js:1:2)"), "traceback");
});

test("detectFormat: diagnostics", () => {
	assert.equal(detectFormat("src/main.ts:1:2: error TS1234: bad type"), "diagnostics");
	assert.equal(detectFormat("[ERROR] something failed"), "diagnostics");
	assert.equal(detectFormat("FAIL test suite"), "diagnostics");
});

test("detectFormat: grep", () => {
	assert.equal(detectFormat("src/main.ts:10:import foo"), "grep");
	assert.equal(detectFormat("file.txt:42:matched line"), "grep");
});

test("detectFormat: log", () => {
	assert.equal(detectFormat("2024-01-15T09:30:00Z INFO starting"), "log");
	assert.equal(detectFormat("09:30:00 WARN slow query"), "log");
	assert.equal(detectFormat("DEBUG trace info"), "log");
});

test("detectFormat: plain", () => {
	assert.equal(detectFormat("hello world\nmore text"), "plain");
});

// --- BashOutputHighlighter.renderCommand ---

test("renderCommand: highlights shell syntax when truecolor is enabled", () => {
	const h = makeHighlighter({ truecolor: true });
	assert.equal(h.renderCommand({ command: "ls -la" }), "<<shell:ls -la>>");
});

test("renderCommand: returns raw command when truecolor is disabled", () => {
	const h = makeHighlighter({ truecolor: false });
	assert.equal(h.renderCommand({ command: "ls -la" }), "ls -la");
});

test("renderCommand: joins args when command is missing", () => {
	const h = makeHighlighter({ truecolor: true });
	assert.equal(h.renderCommand({ args: ["git", "status", "--short"] }), "<<shell:git status --short>>");
});

test("renderCommand: returns empty string when no command or args", () => {
	const h = makeHighlighter({ truecolor: true });
	assert.equal(h.renderCommand({}), "");
});

// --- BashOutputHighlighter.renderResult ---

test("renderResult: preserves existing ANSI after sanitization", () => {
	const h = makeHighlighter({ truecolor: true });
	const result: BashToolResult = {
		content: [{ type: "text", text: "\x1b[31mred\x1b[2K\x1b[0m" }],
	};
	assert.equal(h.renderResult(result), "\x1b[31mred\x1b[0m");
});

test("renderResult: highlights JSON output", () => {
	const h = makeHighlighter({ truecolor: true });
	const result: BashToolResult = {
		content: [{ type: "text", text: '{"a": 1}' }],
	};
	assert.equal(h.renderResult(result), '<<json:{"a": 1}>>');
});

test("renderResult: highlights diff output", () => {
	const h = makeHighlighter({ truecolor: true });
	const result: BashToolResult = {
		content: [{ type: "text", text: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new" }],
	};
	assert.ok(h.renderResult(result).startsWith("<<diff:"));
});

test("renderResult: returns raw text when truecolor is disabled", () => {
	const h = makeHighlighter({ truecolor: false });
	const result: BashToolResult = {
		content: [{ type: "text", text: '{"a": 1}' }],
	};
	assert.equal(h.renderResult(result), '{"a": 1}');
});

test("renderResult: uses details.stdout/stderr when present", () => {
	const h = makeHighlighter({ truecolor: true });
	const result: BashToolResult = {
		content: [{ type: "text", text: "ignored" }],
		details: {
			stdout: "{\"ok\": true}",
			stderr: "",
		},
	};
	assert.equal(h.renderResult(result), '<<json:{"ok": true}>>');
});

test("renderResult: combines stdout and stderr", () => {
	const h = makeHighlighter({ truecolor: true });
	const result: BashToolResult = {
		content: [],
		details: {
			stdout: "line1",
			stderr: "line2",
		},
	};
	assert.equal(h.renderResult(result), "line1\nline2");
});

test("renderResult: returns empty string for empty output", () => {
	const h = makeHighlighter({ truecolor: true });
	const result: BashToolResult = { content: [{ type: "text", text: "" }] };
	assert.equal(h.renderResult(result), "");
});

test("renderResult: falls back to plain text for unknown format", () => {
	const h = makeHighlighter({ truecolor: true });
	const result: BashToolResult = {
		content: [{ type: "text", text: "hello world" }],
	};
	assert.equal(h.renderResult(result), "hello world");
});

test("renderResult: gracefully falls back if highlighter throws", () => {
	const throwing: HighlightFn = () => {
		throw new Error("boom");
	};
	const h = makeHighlighter({ truecolor: true, highlight: throwing });
	const result: BashToolResult = {
		content: [{ type: "text", text: '{"a": 1}' }],
	};
	assert.equal(h.renderResult(result), '{"a": 1}');
});

// --- highlightTraceback ---

test("highlightTraceback: detects python", () => {
	assert.ok(highlightTraceback("Traceback...", {}, noopHighlight).startsWith("<<python:"));
});

test("highlightTraceback: detects javascript", () => {
	assert.ok(
		highlightTraceback("Error: x\n    at y (/z.js:1:2)", {}, noopHighlight).startsWith(
			"<<javascript:",
		),
	);
});

test("highlightTraceback: detects rust", () => {
	assert.ok(
		highlightTraceback("thread 'main' panicked at src/lib.rs:1", {}, noopHighlight).startsWith(
			"<<rust:",
		),
	);
});

test("highlightTraceback: returns plain when language unclear", () => {
	assert.equal(highlightTraceback("some error", {}, noopHighlight), "some error");
});

// --- Stubs don't throw ---

test("highlightDiagnostics stub returns input", () => {
	assert.equal(highlightDiagnostics("err", {}, noopHighlight), "err");
});

test("highlightGrep stub returns input", () => {
	assert.equal(highlightGrep("file:1:line", {}, noopHighlight), "file:1:line");
});

test("highlightLog stub returns input", () => {
	assert.equal(highlightLog("INFO ok", {}, noopHighlight), "INFO ok");
});
