/**
 * Optional / diagnostic bash output highlighter.
 *
 * Kept free of @earendil-works/pi-coding-agent imports so it is testable
 * with Node's built-in test runner and no dependencies.
 */

import type { HighlightFn } from "./highlighter.ts";

export interface BashToolArgs {
	command?: string;
	args?: string[];
	cwd?: string;
}

export interface BashToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: {
		command?: string;
		args?: string[];
		cwd?: string;
		exitCode?: number;
		stdout?: string;
		stderr?: string;
	};
}

export type OutputFormat =
	| "ansi"
	| "json"
	| "diff"
	| "traceback"
	| "diagnostics"
	| "grep"
	| "log"
	| "plain";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const ALL_ESCAPES = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Strip every ANSI/OSC/other escape sequence except SGR (color/style).
 * This prevents cursor movement, screen clears, hyperlinks, etc. from
 * corrupting the TUI, while preserving legitimate color codes.
 */
export function sanitizeAnsi(text: string): string {
	const parts = text.split(ALL_ESCAPES);
	const escapes = text.match(ALL_ESCAPES) ?? [];

	let out = parts[0] ?? "";
	for (let i = 0; i < escapes.length; i++) {
		const esc = escapes[i];
		if (SGR_PATTERN.test(esc)) {
			out += esc;
		}
		out += parts[i + 1] ?? "";
	}
	return out;
}

export function containsAnsi(text: string): boolean {
	return SGR_PATTERN.test(text);
}

/**
 * Very cheap format detection for command output. Returns the best
 * guess; callers fall back to plain text when no highlighter applies.
 */
export function detectFormat(text: string): OutputFormat {
	if (containsAnsi(text)) return "ansi";

	const lines = text.split(/\r?\n/);
	const first = lines[0].trim();

	// diff / patch
	if (
		first.startsWith("diff ") ||
		first.startsWith("--- ") ||
		first.startsWith("+++ ") ||
		first.startsWith("@@ ") ||
		first.startsWith("index ") ||
		/^\s*[+-]{3}\s/.test(first)
	) {
		return "diff";
	}

	// JSON / NDJSON
	if (
		first.startsWith("{") ||
		first.startsWith("[") ||
		/^\s*["{[]/.test(first)
	) {
		// Make sure it isn't a JS file starting with an object literal
		try {
			JSON.parse(first);
			return "json";
		} catch {
			/* continue */
		}
	}

	// Tracebacks (Python, Node.js, Rust panics)
	if (
		/Traceback \(most recent call last\):/.test(text) ||
		/\s+at\s+.+\(.+:\d+:\d+\)/.test(text) ||
		/^\s*thread '.+' panicked at/.test(text) ||
		/^\s*Error:\s/.test(text)
	) {
		return "traceback";
	}

	// Compiler / test diagnostics
	if (
		/\[ERROR\]|\[WARN\]|\[WARNING\]|\[INFO\]|\[DEBUG\]|\[PASS\]|\[FAIL\]/.test(
			text,
		) ||
		/^\s*(error|warning|info|note|help)\s*\[?/.test(text) ||
		/:\d+:\d+:\s*(error|warning|info):/.test(text) ||
		/\bfail(ures?|ed)?\b/i.test(text)
	) {
		return "diagnostics";
	}

	// grep / rg
	if (
		/^[^\n]+:\d+:\d*:/.test(text) ||
		/^[^\n]+:\d+:/.test(text)
	) {
		return "grep";
	}

	// Plain logs (ISO-ish timestamps or common log levels)
	if (
		/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(first) ||
		/^\d{2}:\d{2}:\d{2}/.test(first) ||
		/\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/.test(text)
	) {
		return "log";
	}

	return "plain";
}

/**
 * Light log highlighting: colorize level tokens and timestamps.
 * Does not do full parsing; intended to make multi-line logs readable.
 */
export function highlightLog(text: string, theme: unknown, highlight: HighlightFn): string {
	const levelColors: Record<string, string> = {
		ERROR: "error",
		FATAL: "error",
		WARN: "warning",
		WARNING: "warning",
		INFO: "success",
		DEBUG: "dim",
		TRACE: "dim",
	};

	// We can't easily call theme.fg() because theme is opaque here.
	// Instead, return as-is; callers may choose to post-process.
	// For now this is a stub that preserves the text unchanged.
	void theme;
	void highlight;
	return text;
}

/**
 * Light grep highlighting: colorize the leading path:line prefix.
 */
export function highlightGrep(text: string, theme: unknown, highlight: HighlightFn): string {
	void theme;
	void highlight;
	// Preserve existing ANSI if any; otherwise plain text for now.
	return text;
}

/**
 * Light diagnostics highlighting: colorize leading error/warning/note words.
 */
export function highlightDiagnostics(
	text: string,
	theme: unknown,
	highlight: HighlightFn,
): string {
	void theme;
	void highlight;
	// Preserve existing ANSI if any; otherwise plain text for now.
	return text;
}

/**
 * Highlight a traceback by guessing the source language from content
 * heuristics, then falling back to plain text if we cannot guess.
 */
export function highlightTraceback(
	text: string,
	theme: unknown,
	highlight: HighlightFn,
): string {
	void theme;
	let lang: string | null = null;
	if (/Traceback \(most recent call last\):/.test(text)) {
		lang = "python";
	} else if (/\s+at\s+.+\(.+:\d+:\d+\)/.test(text)) {
		lang = "javascript";
	} else if (/^\s*thread '.+' panicked at/.test(text)) {
		lang = "rust";
	}
	if (lang) {
		try {
			return highlight(text, lang, theme);
		} catch {
			return text;
		}
	}
	return text;
}

export class BashOutputHighlighter {
	private readonly theme: unknown;
	private readonly highlight: HighlightFn;
	private readonly isTruecolor: boolean;

	constructor(theme: unknown, highlight: HighlightFn, isTruecolor: boolean) {
		this.theme = theme;
		this.highlight = highlight;
		this.isTruecolor = isTruecolor;
	}

	/**
	 * Render the command call (for renderCall). Returns ANSI-styled shell
	 * syntax if truecolor is available, otherwise the raw command string.
	 */
	renderCommand(args: BashToolArgs): string {
		const cmd = this.commandString(args);
		if (!cmd || !this.isTruecolor) return cmd ?? "";
		try {
			return this.highlight(cmd, "shell", this.theme);
		} catch {
			return cmd;
		}
	}

	/**
	 * Render the command result/output (for renderResult). Preserves
	 * existing ANSI after sanitizing, detects common structured formats,
	 * highlights those, and falls back to plain text.
	 */
	renderResult(result: BashToolResult): string {
		const output = this.extractOutput(result);
		if (!output) return "";

		if (!this.isTruecolor) {
			return output;
		}

		// If the command already produced ANSI, sanitize and pass through.
		if (containsAnsi(output)) {
			return sanitizeAnsi(output);
		}

		const format = detectFormat(output);
		switch (format) {
			case "json":
				return this.safeHighlight(output, "json");
			case "diff":
				return this.safeHighlight(output, "diff");
			case "traceback":
				return highlightTraceback(output, this.theme, this.highlight);
			case "diagnostics":
				return highlightDiagnostics(output, this.theme, this.highlight);
			case "grep":
				return highlightGrep(output, this.theme, this.highlight);
			case "log":
				return highlightLog(output, this.theme, this.highlight);
			case "ansi":
				return sanitizeAnsi(output);
			case "plain":
			default:
				return output;
		}
	}

	private commandString(args: BashToolArgs): string | null {
		if (args.command) return args.command;
		if (args.args && args.args.length > 0) return args.args.join(" ");
		return null;
	}

	private extractOutput(result: BashToolResult): string {
		const d = result.details;
		if (d?.stdout !== undefined || d?.stderr !== undefined) {
			const parts: string[] = [];
			if (d.stdout) parts.push(d.stdout);
			if (d.stderr) parts.push(d.stderr);
			return parts.join("\n");
		}
		const textItem = result.content?.find((c) => c.type === "text");
		return textItem?.text ?? "";
	}

	private safeHighlight(text: string, lang: string): string {
		try {
			return this.highlight(text, lang, this.theme);
		} catch {
			return text;
		}
	}
}
