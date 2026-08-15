/**
 * Code Mode — pure utility functions.
 *
 * Extracted for testability (mirrors plan-mode/goal-mode conventions).
 * Ports the model-facing surface of OpenAI Codex's code mode
 * (codex-rs/code-mode-protocol/src/description.rs) to Pi.
 */

export const EXEC_TOOL_NAME = "exec";
export const WAIT_TOOL_NAME = "wait";
export const EXEC_PRAGMA_PREFIX = "// @exec:";

export const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
export const DEFAULT_WAIT_YIELD_TIME_MS = 10_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

/** Rough chars-per-token used to convert output token budgets to char budgets. */
export const CHARS_PER_TOKEN = 4;
/** Hard output cap, mirroring pi's built-in DEFAULT_MAX_BYTES (50KB). */
export const HARD_MAX_OUTPUT_CHARS = 50 * 1024;

// ── output items ─────────────────────────────────────────────────────────────

export type ReplOutputItem =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

// ── exec source pragma parsing ───────────────────────────────────────────────

export interface ParsedExecSource {
	code: string;
	yieldTimeMs?: number;
	maxOutputTokens?: number;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Split an exec source into an optional first-line `// @exec: {...}` pragma
 * and the remaining JavaScript code. Throws with codex-style messages on
 * malformed input.
 */
export function parseExecSource(input: string): ParsedExecSource {
	if (typeof input !== "string" || input.trim().length === 0) {
		throw new Error(
			`exec expects raw JavaScript source text (non-empty). Provide JS only, optionally with first-line \`${EXEC_PRAGMA_PREFIX} {"yield_time_ms": 10000, "max_output_tokens": 1000}\`.`,
		);
	}

	const newlineIndex = input.indexOf("\n");
	const firstLine = newlineIndex === -1 ? input : input.slice(0, newlineIndex);
	const rest = newlineIndex === -1 ? "" : input.slice(newlineIndex + 1);
	const trimmedFirst = firstLine.trimStart();

	if (!trimmedFirst.startsWith(EXEC_PRAGMA_PREFIX)) {
		return { code: input };
	}

	if (rest.trim().length === 0) {
		throw new Error("exec pragma must be followed by JavaScript source on subsequent lines");
	}

	const directive = trimmedFirst.slice(EXEC_PRAGMA_PREFIX.length).trim();
	if (directive.length === 0) {
		throw new Error(
			"exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`",
		);
	}

	let value: unknown;
	try {
		value = JSON.parse(directive);
	} catch (error) {
		throw new Error(
			`exec pragma must be valid JSON with supported fields \`yield_time_ms\` and \`max_output_tokens\`: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(
			"exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`",
		);
	}

	const object = value as Record<string, unknown>;
	for (const key of Object.keys(object)) {
		if (key !== "yield_time_ms" && key !== "max_output_tokens") {
			throw new Error(`exec pragma only supports \`yield_time_ms\` and \`max_output_tokens\`; got \`${key}\``);
		}
	}

	const result: ParsedExecSource = { code: rest };
	if (object.yield_time_ms !== undefined) {
		if (!isNonNegativeSafeInteger(object.yield_time_ms)) {
			throw new Error("exec pragma field `yield_time_ms` must be a non-negative safe integer");
		}
		result.yieldTimeMs = object.yield_time_ms;
	}
	if (object.max_output_tokens !== undefined) {
		if (!isNonNegativeSafeInteger(object.max_output_tokens)) {
			throw new Error("exec pragma field `max_output_tokens` must be a non-negative safe integer");
		}
		result.maxOutputTokens = object.max_output_tokens;
	}
	return result;
}

export interface ExecBudgets {
	yieldTimeMs: number;
	maxOutputTokens: number;
}

/** Explicit tool arguments beat pragma values, which beat defaults. */
export function resolveExecBudgets(
	args: { yield_time_ms?: number; max_output_tokens?: number },
	pragma: { yieldTimeMs?: number; maxOutputTokens?: number },
): ExecBudgets {
	return {
		yieldTimeMs: args.yield_time_ms ?? pragma.yieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS,
		maxOutputTokens: args.max_output_tokens ?? pragma.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
	};
}

// ── identifiers ──────────────────────────────────────────────────────────────

/** Port of codex's normalize_code_mode_identifier. */
export function normalizeIdentifier(toolKey: string): string {
	let identifier = "";
	let index = 0;
	for (const ch of toolKey) {
		const isValid =
			index === 0
				? ch === "_" || ch === "$" || /[A-Za-z]/.test(ch)
				: ch === "_" || ch === "$" || /[A-Za-z0-9]/.test(ch);
		identifier += isValid ? ch : "_";
		index += 1;
	}
	return identifier.length > 0 ? identifier : "_";
}

// ── JSON Schema → TypeScript rendering ───────────────────────────────────────

type JsonValue = unknown;

function asObject(value: JsonValue): Record<string, JsonValue> | undefined {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, JsonValue>;
	}
	return undefined;
}

function renderLiteral(value: JsonValue): string {
	try {
		const rendered = JSON.stringify(value);
		return rendered === undefined ? "unknown" : rendered;
	} catch {
		return "unknown";
	}
}

function renderPropertyName(name: string): string {
	return normalizeIdentifier(name) === name ? name : renderLiteral(name);
}

function hasDescription(value: JsonValue): boolean {
	const object = asObject(value);
	const description = object?.description;
	return typeof description === "string" && description.trim().length > 0;
}

function renderObjectProperty(name: string, value: JsonValue, required: string[]): string {
	const optional = required.includes(name) ? "" : "?";
	return `${renderPropertyName(name)}${optional}: ${renderJsonSchemaToTsInner(value)};`;
}

function additionalPropertiesLine(
	map: Record<string, JsonValue>,
	properties: Record<string, JsonValue>,
	prefix: string,
): string | undefined {
	if ("additionalProperties" in map) {
		const additional = map.additionalProperties;
		if (additional === false) return undefined;
		if (additional === true) return `${prefix}[key: string]: unknown;`;
		return `${prefix}[key: string]: ${renderJsonSchemaToTsInner(additional)};`;
	}
	if (Object.keys(properties).length === 0) {
		return `${prefix}[key: string]: unknown;`;
	}
	return undefined;
}

function renderObjectSchema(map: Record<string, JsonValue>): string {
	const required = Array.isArray(map.required)
		? map.required.filter((item): item is string => typeof item === "string")
		: [];
	const properties = asObject(map.properties) ?? {};
	const sorted = Object.entries(properties).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

	if (sorted.some(([, value]) => hasDescription(value))) {
		const lines = ["{"];
		for (const [name, value] of sorted) {
			const description = asObject(value)?.description;
			if (typeof description === "string") {
				for (const line of description.split("\n")) {
					const trimmed = line.trim();
					if (trimmed.length > 0) lines.push(`  // ${trimmed}`);
				}
			}
			lines.push(`  ${renderObjectProperty(name, value, required)}`);
		}
		const extra = additionalPropertiesLine(map, properties, "  ");
		if (extra) lines.push(extra);
		lines.push("}");
		return lines.join("\n");
	}

	const parts = sorted.map(([name, value]) => renderObjectProperty(name, value, required));
	const extra = additionalPropertiesLine(map, properties, "");
	if (extra) parts.push(extra);
	if (parts.length === 0) return "{}";
	return `{ ${parts.join(" ")} }`;
}

function renderArraySchema(map: Record<string, JsonValue>): string {
	if ("items" in map && map.items !== undefined) {
		return `Array<${renderJsonSchemaToTsInner(map.items)}>`;
	}
	const prefixItems = Array.isArray(map.prefixItems) ? map.prefixItems : undefined;
	if (prefixItems && prefixItems.length > 0) {
		return `[${prefixItems.map((item) => renderJsonSchemaToTsInner(item)).join(", ")}]`;
	}
	return "unknown[]";
}

function renderTypeKeyword(map: Record<string, JsonValue>, schemaType: string): string {
	switch (schemaType) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return renderArraySchema(map);
		case "object":
			return renderObjectSchema(map);
		default:
			return "unknown";
	}
}

function renderJsonSchemaToTsInner(schema: JsonValue): string {
	if (schema === true) return "unknown";
	if (schema === false) return "never";
	const map = asObject(schema);
	if (!map) return "unknown";

	if ("const" in map) return renderLiteral(map.const);

	if (Array.isArray(map.enum) && map.enum.length > 0) {
		return map.enum.map((value) => renderLiteral(value)).join(" | ");
	}

	for (const key of ["anyOf", "oneOf"] as const) {
		const variants = Array.isArray(map[key]) ? (map[key] as JsonValue[]) : undefined;
		if (variants && variants.length > 0) {
			return variants.map((variant) => renderJsonSchemaToTsInner(variant)).join(" | ");
		}
	}

	if (Array.isArray(map.allOf) && map.allOf.length > 0) {
		return (map.allOf as JsonValue[]).map((variant) => renderJsonSchemaToTsInner(variant)).join(" & ");
	}

	if (Array.isArray(map.type)) {
		const types = map.type.filter((t): t is string => typeof t === "string");
		if (types.length > 0) {
			return types.map((t) => renderTypeKeyword(map, t)).join(" | ");
		}
	}

	if (typeof map.type === "string") {
		return renderTypeKeyword(map, map.type);
	}

	if ("properties" in map || "additionalProperties" in map || "required" in map) {
		return renderObjectSchema(map);
	}

	if ("items" in map || "prefixItems" in map) {
		return renderArraySchema(map);
	}

	return "unknown";
}

/** Render a JSON Schema (e.g. a typebox tool schema) as a TypeScript type. */
export function renderJsonSchemaToTs(schema: JsonValue): string {
	return renderJsonSchemaToTsInner(schema);
}

// ── tool descriptions ────────────────────────────────────────────────────────

export interface NestedToolInfo {
	name: string;
	description: string;
	/** JSON Schema for the tool's input object. */
	parameters: JsonValue;
	/** Tools that may return image blocks instead of plain text. */
	mayReturnContentBlocks?: boolean;
}

const CONTENT_BLOCK_PREAMBLE = `type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };`;

function renderToolDeclaration(tool: NestedToolInfo): string {
	const globalName = normalizeIdentifier(tool.name);
	const inputType = renderJsonSchemaToTs(tool.parameters);
	const outputType = tool.mayReturnContentBlocks ? "string | ContentBlock[]" : "string";
	return `declare const tools: { ${globalName}(args: ${inputType}): Promise<${outputType}>; };`;
}

export function buildNestedToolsSection(tools: NestedToolInfo[]): string {
	if (tools.length === 0) return "";
	const sections: string[] = [];
	if (tools.some((tool) => tool.mayReturnContentBlocks)) {
		sections.push(`Shared types:\n\`\`\`ts\n${CONTENT_BLOCK_PREAMBLE}\n\`\`\``);
	}
	for (const tool of tools) {
		const globalName = normalizeIdentifier(tool.name);
		const heading =
			globalName === tool.name ? `### \`${globalName}\`` : `### \`${globalName}\` (\`${tool.name}\`)`;
		const description = tool.description.trim();
		sections.push(`${heading}\n${description}\n\nexec tool declaration:\n\`\`\`ts\n${renderToolDeclaration(tool)}\n\`\`\``);
	}
	return `Nested tools (call via \`tools.<name>\`):\n\n${sections.join("\n\n")}`;
}

export function buildExecDescription(tools: NestedToolInfo[]): string {
	const template = `Run JavaScript code to orchestrate/compose tool calls.
- Evaluates \`source\` as the body of an async function in a fresh JavaScript sandbox (top-level \`await\` works).
- All nested tools are available on the global \`tools\` object, for example \`await tools.read({ path: "src/index.ts" })\`.
- Nested tool methods take one object argument matching their schema and resolve to text (or content blocks for images). They throw on failure.
- Runs raw JavaScript — no Node, no \`require\`, no \`process\`, no file system, no network access, no \`console\`. Only the documented globals exist.
- \`source\` may optionally start with a first-line pragma like \`// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}\`. Explicit tool arguments take precedence over the pragma.
- \`yield_time_ms\` asks exec to return early if the script is still running. Defaults to ${DEFAULT_EXEC_YIELD_TIME_MS} ms. The script keeps running in the background as a cell; use the \`${WAIT_TOOL_NAME}\` tool to collect more output or terminate it.
- \`max_output_tokens\` sets the token budget for text returned by this exec call. Defaults to ${DEFAULT_MAX_OUTPUT_TOKENS} tokens. Older output is dropped first when the budget is exceeded.
- When the script finishes, its sandbox is discarded and unawaited promises are dropped. Use \`store()\`/\`load()\` to keep values across exec calls, or keep work alive inside a running cell.

- Global helpers:
- \`exit()\`: immediately ends the current script successfully (like an early return from the top level).
- \`text(value: any)\`: appends a text item. Non-string values are stringified with \`JSON.stringify(...)\` when possible.
- \`image(source: string | { type: "image"; data: string; mimeType: string }, mimeType?: string)\`: appends an image item. Accepts a base64 \`data:\` URL, base64 data plus a mimeType, or an image content block (for example from \`tools.read\` on an image file).
- \`store(key: string, value: any)\`: stores a JSON-serializable value under a string key for later exec calls in the same session. Throws on values that are not JSON-serializable.
- \`load(key: string)\`: returns the stored value for a string key, or \`undefined\` if it is missing.
- \`notify(value: any)\`: like \`text(...)\`, but also streams the value to the UI immediately as progress.
- \`setTimeout(callback: () => void, delayMs?: number)\`: schedules a callback and returns a timeout id. Pending timeouts do not keep exec alive by themselves; await an explicit promise if you need to wait for one.
- \`clearTimeout(timeoutId?: number)\`: cancels a timeout created by \`setTimeout\`.
- \`ALL_TOOLS\`: metadata for the nested tools as \`{ name, description }\` entries.
- \`yield_control()\`: yields the accumulated output to the model immediately while the script keeps running.
- \`llm.query(prompt: string, opts?: { system?: string; model?: string; maxTokens?: number; reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }): Promise<string>\`: asks a fresh-context sub-LLM (no tools) and resolves to its text reply. Use it to summarize, filter, or extract from large data without loading that data into this conversation. \`model\` accepts a \`"provider/id"\` reference and defaults to the current session model. Nested LLM usage is billed to this tool call.`;

	const nested = buildNestedToolsSection(tools);
	return nested.length > 0 ? `${template}\n\n${nested}` : template;
}

export const WAIT_TOOL_DESCRIPTION = `Collect output from a running exec cell.
- Use \`${WAIT_TOOL_NAME}\` only after \`${EXEC_TOOL_NAME}\` returns \`Script running with cell ID ...\`.
- \`cell_id\` identifies the running exec cell to resume.
- \`yield_time_ms\` controls how long to wait for more output before returning again. Defaults to ${DEFAULT_WAIT_YIELD_TIME_MS} ms.
- \`max_output_tokens\` limits how much new text output this wait call returns. Defaults to ${DEFAULT_MAX_OUTPUT_TOKENS} tokens.
- \`terminate: true\` stops the running cell; false or omitted waits for output.
- \`${WAIT_TOOL_NAME}\` returns only the new output since the last return for that cell, or the final completion or termination result for that cell.
- If the cell is still running after the wait, the result notes that it remains active; call \`${WAIT_TOOL_NAME}\` again with the same cell_id.
- Waiting on an unknown or already-closed cell returns an "unknown or already closed" message.`;

// ── cell messages ────────────────────────────────────────────────────────────

export function runningNotice(cellId: string): string {
	return `Script running with cell ID "${cellId}". Use the ${WAIT_TOOL_NAME} tool with this cell_id to collect more output or terminate it.`;
}

export function missingCellMessage(cellId: string): string {
	return `Cell "${cellId}" is unknown or already closed.`;
}

export const STILL_RUNNING_NOTE = `Cell is still running. Call ${WAIT_TOOL_NAME} again with the same cell_id.`;

export const TERMINATED_NOTE = "Cell terminated.";

export const NO_OUTPUT_NOTE = "(script completed with no output)";

// ── output helpers ───────────────────────────────────────────────────────────

/** Stringify a helper argument (text()/notify()) the way codex does. */
export function stringifyForOutput(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		const rendered = JSON.stringify(value);
		if (rendered !== undefined) return rendered;
	} catch {
		// fall through to String()
	}
	return String(value);
}

/**
 * Deep-copy a value through JSON, rejecting anything that does not round-trip.
 * Returns the detached copy suitable for the session store.
 */
export function ensureJsonSerializable(value: unknown): unknown {
	let rendered: string;
	try {
		rendered = JSON.stringify(value) as string;
	} catch {
		throw new TypeError("store() value must be JSON-serializable");
	}
	if (rendered === undefined) {
		throw new TypeError("store() value must be JSON-serializable");
	}
	try {
		return JSON.parse(rendered);
	} catch {
		throw new TypeError("store() value must be JSON-serializable");
	}
}

/** Normalize the image() helper arguments into an image output item. */
export function normalizeImageInput(source: unknown, mimeType?: unknown): ReplOutputItem {
	if (typeof source === "object" && source !== null) {
		const block = source as { type?: unknown; data?: unknown; mimeType?: unknown };
		if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			return { type: "image", data: block.data, mimeType: block.mimeType };
		}
	}
	if (typeof source === "string") {
		if (source.startsWith("data:")) {
			const match = source.match(/^data:([^;,]+);base64,(.*)$/s);
			if (match) {
				return { type: "image", data: match[2] ?? "", mimeType: match[1] ?? "application/octet-stream" };
			}
			throw new Error("image() could not parse the data: URL — expected data:<mimeType>;base64,<data>");
		}
		if (typeof mimeType === "string" && mimeType.length > 0) {
			return { type: "image", data: source, mimeType };
		}
	}
	throw new TypeError(
		'image() expects a base64 data: URL, base64 data plus a mimeType, or an image content block like { type: "image", data, mimeType }',
	);
}

/** Apply the per-call output token budget to new items, dropping oldest text first. */
export function budgetItems(
	items: ReplOutputItem[],
	maxOutputTokens: number,
): { items: ReplOutputItem[]; truncated: boolean } {
	const maxChars = Math.min(Math.max(0, maxOutputTokens) * CHARS_PER_TOKEN, HARD_MAX_OUTPUT_CHARS);
	const totalText = items.reduce(
		(sum, item) => sum + (item.type === "text" ? item.text.length : 0),
		0,
	);
	if (totalText <= maxChars) return { items, truncated: false };

	const kept: ReplOutputItem[] = [];
	let used = 0;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index]!;
		if (item.type === "image") {
			kept.unshift(item);
			continue;
		}
		const remaining = maxChars - used;
		if (remaining <= 0) continue;
		if (item.text.length <= remaining) {
			kept.unshift(item);
			used += item.text.length;
		} else {
			let tail = item.text.slice(item.text.length - remaining);
			const newline = tail.indexOf("\n");
			if (newline !== -1 && newline < 200 && newline < tail.length - 1) {
				tail = tail.slice(newline + 1);
			}
			kept.unshift({ type: "text", text: tail });
			used += tail.length;
			break;
		}
	}
	return { items: kept, truncated: true };
}

export const TRUNCATION_NOTE =
	"[Output truncated to the max_output_tokens budget — oldest output was dropped. Re-run with narrower output, or use store()/load() and slice values with JavaScript.]";

// ── usage accounting ─────────────────────────────────────────────────────────

export interface ReplUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export function addUsage(a: ReplUsage | undefined, b: ReplUsage | undefined): ReplUsage | undefined {
	if (!a) return b;
	if (!b) return a;
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		reasoning:
			a.reasoning === undefined && b.reasoning === undefined ? undefined : (a.reasoning ?? 0) + (b.reasoning ?? 0),
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

// ── model references ─────────────────────────────────────────────────────────

export function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

// ── mode state machine ───────────────────────────────────────────────────────

export type CodeModeState = "off" | "hybrid" | "strict";

export const MODE_TOOL_NAMES = [EXEC_TOOL_NAME, WAIT_TOOL_NAME] as const;

export type ModeCommand =
	| { action: "set"; mode: CodeModeState }
	| { action: "status" }
	| { action: "error"; message: string };

export function parseModeArg(current: CodeModeState, arg: string): ModeCommand {
	const trimmed = arg.trim().toLowerCase();
	if (trimmed.length === 0) {
		return { action: "set", mode: current === "off" ? "strict" : "off" };
	}
	if (trimmed === "strict" || trimmed === "hybrid" || trimmed === "off") {
		return { action: "set", mode: trimmed };
	}
	if (trimmed === "status") {
		return { action: "status" };
	}
	return {
		action: "error",
		message: `Unknown code-mode argument "${arg}". Usage: /code-mode [strict|hybrid|off|status]`,
	};
}

export interface ToolTransitionInput {
	target: CodeModeState;
	currentMode: CodeModeState;
	currentActive: string[];
	previousTools?: string[];
}

export interface ToolTransition {
	active: string[];
	previousTools?: string[];
}

function withoutModeTools(tools: string[]): string[] {
	return tools.filter((name) => name !== EXEC_TOOL_NAME && name !== WAIT_TOOL_NAME);
}

/**
 * Compute the active tool set (and snapshot) for a mode transition.
 * Strict replaces the whole set with exec+wait; hybrid adds exec+wait to the
 * base set (the snapshot when leaving strict, else the current set); off
 * restores the snapshot.
 */
export function computeToolTransition(input: ToolTransitionInput): ToolTransition {
	const { target, currentMode, currentActive, previousTools } = input;
	if (target === "off") {
		return {
			active: previousTools ?? withoutModeTools(currentActive),
			previousTools: undefined,
		};
	}
	if (target === "hybrid") {
		const base =
			currentMode === "strict" ? (previousTools ?? []) : withoutModeTools(currentActive);
		return {
			active: [...new Set([...base, ...MODE_TOOL_NAMES])],
			previousTools: base,
		};
	}
	// strict
	return {
		active: [...MODE_TOOL_NAMES],
		previousTools:
			currentMode === "strict" ? previousTools : withoutModeTools(currentActive),
	};
}

// ── plan-mode integration ────────────────────────────────────────────────────

/**
 * Whether this repo's plan-mode extension is currently executing, derived from
 * its session entries (same pattern goal-mode uses).
 */
export function isPlanModeExecuting(entries: unknown[]): boolean {
	let executing = false;
	for (const entry of entries) {
		const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (record?.type === "custom" && record?.customType === "plan-mode") {
			const data = record.data as { executing?: unknown } | undefined;
			executing = data?.executing === true;
		}
	}
	return executing;
}

// ── strict-mode system prompt line ───────────────────────────────────────────

export const STRICT_MODE_PROMPT = `Code mode (strict) is active: ${EXEC_TOOL_NAME} and ${WAIT_TOOL_NAME} are the only available tools. Do ALL file, search, shell, and edit work inside ${EXEC_TOOL_NAME} via the \`tools\` object (for example \`await tools.read({ path })\`, \`await tools.bash({ command })\`). Keep raw outputs inside the sandbox: filter, aggregate, and summarize in JavaScript (or via \`llm.query(...)\` for fresh-context sub-LLM distillation), and return only what matters with \`text(...)\`.`;
