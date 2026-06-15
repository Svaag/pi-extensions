/**
 * Pure logic for the tool-highlight extension.
 *
 * Kept free of any `@earendil-works/pi-coding-agent` imports so the
 * unit tests can run with `node --experimental-strip-types --test`
 * and no extra dependencies.
 *
 * The boundary object is `ToolOutputHighlighter`. It takes the
 * highlighting/language-detection functions as constructor arguments
 * so the test suite can inject fakes.
 */

export type HighlightFn = (code: string, language: string, theme: unknown) => string;

export type LanguageFn = (path: string) => string | null | undefined;

export interface FileToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: { path?: string };
}

/**
 * Render a tool result with optional syntax highlighting.
 *
 * Contract:
 *   - The canonical message content (`result.content[].text`) is NEVER
 *     modified. The LLM still sees the raw text.
 *   - The returned string is for TUI display only (presentation layer).
 *   - If truecolor is unavailable, the language is unknown, or
 *     highlighting throws, the raw text is returned unchanged so the
 *     user always sees something readable.
 */
export class ToolOutputHighlighter {
	private readonly theme: unknown;
	private readonly highlight: HighlightFn;
	private readonly detectLanguage: LanguageFn;
	private readonly isTruecolor: boolean;

	constructor(
		theme: unknown,
		highlight: HighlightFn,
		detectLanguage: LanguageFn,
		isTruecolor: boolean,
	) {
		this.theme = theme;
		this.highlight = highlight;
		this.detectLanguage = detectLanguage;
		this.isTruecolor = isTruecolor;
	}

	render(result: FileToolResult): string {
		const raw = this.extractRawText(result);
		if (raw === null) {
			// No text content to highlight; pass through whatever the
			// tool produced (could be empty, or a non-text item).
			return result.content?.[0]?.text ?? "";
		}

		const language = this.languageFor(result);
		if (!language) {
			return raw;
		}

		if (!this.isTruecolor) {
			// Safe fallback: plain text, no ANSI codes.
			return raw;
		}

		try {
			return this.highlight(raw, language, this.theme);
		} catch {
			// Never let a highlighter bug break display.
			return raw;
		}
	}

	private extractRawText(result: FileToolResult): string | null {
		const item = result.content?.find((c) => c.type === "text");
		return item?.text ?? null;
	}

	private languageFor(result: FileToolResult): string | null {
		const path = result.details?.path;
		if (!path) return null;
		const lang = this.detectLanguage(path);
		return lang || null;
	}
}

/**
 * Detect truecolor (24-bit) terminal capability.
 *
 * Checks `COLORTERM` (modern convention) and falls back to known
 * `TERM` identifiers. Safe to call repeatedly; reads `process.env`
 * by default but accepts an env override for testing.
 */
export function detectTruecolor(env: NodeJS.ProcessEnv = process.env): boolean {
	const ct = (env.COLORTERM ?? "").toLowerCase();
	if (ct === "truecolor" || ct === "24bit") return true;

	const term = (env.TERM ?? "").toLowerCase();
	if (term.includes("truecolor") || term.includes("24bit")) return true;
	// Terminals that always emit 24-bit escapes when their own
	// config says so, regardless of $COLORTERM.
	if (term === "xterm-direct" || term === "xterm-direct2") return true;
	if (term.startsWith("alacritty")) return true;
	if (term.startsWith("wezterm")) return true;
	if (term.startsWith("ghostty")) return true;
	if (term.startsWith("kitty")) return true;
	if (term.startsWith("tmux-256color") && ct === "truecolor") return true;

	return false;
}
