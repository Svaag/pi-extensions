import assert from "node:assert/strict";
import test from "node:test";
import {
	ToolOutputHighlighter,
	detectTruecolor,
	type FileToolResult,
	type HighlightFn,
	type LanguageFn,
} from "../tool-highlight/highlighter.ts";

const noopHighlight: HighlightFn = (code) => `<<HIGHLIGHTED:${code}>>`;
const typescript: LanguageFn = (path) => (path.endsWith(".ts") ? "typescript" : null);

function makeHighlighter(opts: {
	highlight?: HighlightFn;
	language?: LanguageFn;
	truecolor?: boolean;
	theme?: unknown;
}) {
	return new ToolOutputHighlighter(
		opts.theme ?? { name: "test-theme" },
		opts.highlight ?? noopHighlight,
		opts.language ?? typescript,
		opts.truecolor ?? true,
	);
}

const sampleTs: FileToolResult = {
	content: [{ type: "text", text: "const x = 1;\n" }],
	details: { path: "/tmp/example.ts" },
};

// --- ToolOutputHighlighter.render() ---

test("render: returns ANSI-styled text when truecolor and language are available", () => {
	const h = makeHighlighter({ truecolor: true });
	const out = h.render(sampleTs);
	assert.equal(out, "<<HIGHLIGHTED:const x = 1;\n>>");
});

test("render: returns raw text (no ANSI) when truecolor is disabled", () => {
	const h = makeHighlighter({ truecolor: false });
	const out = h.render(sampleTs);
	assert.equal(out, "const x = 1;\n");
});

test("render: returns raw text when path is missing from details", () => {
	const h = makeHighlighter({ truecolor: true, language: typescript });
	const result: FileToolResult = {
		content: [{ type: "text", text: "hello world" }],
		// no details
	};
	assert.equal(h.render(result), "hello world");
});

test("render: returns raw text when language cannot be detected for the path", () => {
	const h = makeHighlighter({
		truecolor: true,
		language: (path) => (path.endsWith(".ts") ? "typescript" : null),
	});
	const result: FileToolResult = {
		content: [{ type: "text", text: "no syntax here" }],
		details: { path: "/tmp/data.bin" },
	};
	assert.equal(h.render(result), "no syntax here");
});

test("render: returns raw text when language detector returns empty string", () => {
	const h = makeHighlighter({
		truecolor: true,
		language: () => "",
	});
	assert.equal(h.render(sampleTs), "const x = 1;\n");
});

test("render: never modifies the canonical content[].text (presentation layer only)", () => {
	const h = makeHighlighter({ truecolor: true });
	const result: FileToolResult = {
		content: [{ type: "text", text: "original-raw" }],
		details: { path: "/tmp/example.ts" },
	};
	const before = result.content[0].text;
	h.render(result);
	assert.equal(result.content[0].text, before);
});

test("render: returns raw text when highlighter throws (graceful fallback)", () => {
	const throwing: HighlightFn = () => {
		throw new Error("syntax highlighter crashed");
	};
	const h = makeHighlighter({ truecolor: true, highlight: throwing });
	assert.equal(h.render(sampleTs), "const x = 1;\n");
});

test("render: returns empty string when result has no text content", () => {
	const h = makeHighlighter({ truecolor: true });
	const result: FileToolResult = {
		content: [{ type: "image", text: undefined }],
		details: { path: "/tmp/example.ts" },
	};
	assert.equal(h.render(result), "");
});

test("render: returns first text item's text when multiple content items exist", () => {
	const h = makeHighlighter({ truecolor: false });
	const result: FileToolResult = {
		content: [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		],
		details: { path: "/tmp/example.ts" },
	};
	assert.equal(h.render(result), "first");
});

// --- detectTruecolor() ---

test("detectTruecolor: returns true when COLORTERM=truecolor", () => {
	assert.equal(detectTruecolor({ COLORTERM: "truecolor" }), true);
});

test("detectTruecolor: returns true when COLORTERM=24bit", () => {
	assert.equal(detectTruecolor({ COLORTERM: "24bit" }), true);
});

test("detectTruecolor: is case-insensitive for COLORTERM", () => {
	assert.equal(detectTruecolor({ COLORTERM: "TrueColor" }), true);
});

test("detectTruecolor: returns true for xterm-direct regardless of COLORTERM", () => {
	assert.equal(detectTruecolor({ TERM: "xterm-direct" }), true);
});

test("detectTruecolor: returns true for alacritty/wezterm/ghostty/kitty", () => {
	assert.equal(detectTruecolor({ TERM: "alacritty" }), true);
	assert.equal(detectTruecolor({ TERM: "wezterm" }), true);
	assert.equal(detectTruecolor({ TERM: "ghostty" }), true);
	assert.equal(detectTruecolor({ TERM: "kitty" }), true);
});

test("detectTruecolor: returns false for plain xterm-256color without COLORTERM", () => {
	assert.equal(detectTruecolor({ TERM: "xterm-256color" }), false);
});

test("detectTruecolor: returns false for empty env", () => {
	assert.equal(detectTruecolor({}), false);
});
