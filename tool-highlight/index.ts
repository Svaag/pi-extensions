/**
 * tool-highlight — Pi extension
 *
 * Overrides `renderResult` for the file-content tools (`read`, `edit`,
 * `write`) so the TUI displays syntax-highlighted output using the
 * active theme. The canonical message content is left untouched: the
 * LLM still sees the raw text the tool produced.
 *
 * Truecolor is auto-detected via `COLORTERM`/`TERM`. When unavailable
 * (e.g. over a 256-color SSH session) the output is shown as plain
 * text, exactly like before this extension was loaded.
 *
 * ------------------------------------------------------------------
 * Optional / experimental: bash highlighting
 * ------------------------------------------------------------------
 * Set the environment variable `PI_TOOL_HIGHLIGHT_BASH=1` when
 * starting Pi to also wrap the built-in `bash` tool. This is a
 * diagnostic/advanced path: it tests whether a custom `renderResult`
 * for `bash` bypasses the built-in renderer's ANSI escaping, and
 * optionally adds structured-output highlighting for command output.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { BashOutputHighlighter, type BashToolArgs, type BashToolResult } from "./bash-highlighter.ts";
import { ToolOutputHighlighter, detectTruecolor, type FileToolResult } from "./highlighter.ts";

const FILE_CONTENT_TOOLS = ["read", "edit", "write"] as const;

function isBashHighlightEnabled(): boolean {
	const v = process.env.PI_TOOL_HIGHLIGHT_BASH?.toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

export default function (pi: ExtensionAPI) {
	const isTruecolor = detectTruecolor();

	for (const toolName of FILE_CONTENT_TOOLS) {
		pi.registerTool({
			name: toolName,
			renderResult: (result, _options, theme, _context) => {
				const highlighter = new ToolOutputHighlighter(
					theme,
					highlightCode,
					getLanguageFromPath as (path: string) => string | null | undefined,
					isTruecolor,
				);
				return highlighter.render(result as FileToolResult);
			},
		});
	}

	if (isBashHighlightEnabled()) {
		pi.registerTool({
			name: "bash",
			renderCall: (args, theme, _context) => {
				const highlighter = new BashOutputHighlighter(theme, highlightCode, isTruecolor);
				return highlighter.renderCommand(args as BashToolArgs);
			},
			renderResult: (result, _options, theme, _context) => {
				const highlighter = new BashOutputHighlighter(theme, highlightCode, isTruecolor);
				return highlighter.renderResult(result as BashToolResult);
			},
		});
	}
}
