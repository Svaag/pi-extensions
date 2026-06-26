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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { ToolOutputHighlighter, detectTruecolor, type FileToolResult } from "./highlighter.ts";

const FILE_CONTENT_TOOLS = ["read", "edit", "write"] as const;

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
}
