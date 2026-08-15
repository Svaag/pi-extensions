/**
 * Code Mode Extension — a Codex-style JavaScript REPL for Pi.
 *
 * Ports OpenAI Codex's code mode (codex-rs/code-mode*) to pi:
 *
 * - `exec` runs model-written JavaScript in a fresh sandbox. All built-in pi
 *   tools (read/bash/edit/write/grep/find/ls) are available on the global
 *   `tools` object; intermediate results stay inside the sandbox and only
 *   explicit `text(...)`/`image(...)` output enters the conversation.
 * - `wait` collects output from (or terminates) long-running exec cells.
 * - `llm.query(...)` inside the sandbox makes fresh-context sub-LLM calls
 *   (RLM-style) for summarizing/filtering large data outside the transcript.
 *
 * /code-mode [strict|hybrid|off|status]   Toggle code mode (default: strict).
 *
 * Strict mode replaces the active tool set with just exec+wait; hybrid adds
 * them alongside the existing tools; off restores the previous set.
 */

import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	highlightCode,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { contentText, type Usage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	ReplSession,
	type CellOutcome,
	type LlmQueryFn,
	type ReplToolBinding,
} from "./repl.ts";
import {
	DEFAULT_MAX_OUTPUT_TOKENS,
	DEFAULT_WAIT_YIELD_TIME_MS,
	DEFAULT_EXEC_YIELD_TIME_MS,
	EXEC_TOOL_NAME,
	MODE_TOOL_NAMES,
	STRICT_MODE_PROMPT,
	WAIT_TOOL_NAME,
	WAIT_TOOL_DESCRIPTION,
	buildExecDescription,
	computeToolTransition,
	isPlanModeExecuting,
	parseExecSource,
	parseModeArg,
	parseModelRef,
	resolveExecBudgets,
	type CodeModeState,
	type NestedToolInfo,
	type ReplOutputItem,
} from "./utils.ts";

const ENTRY_TYPE = "code-mode";
const MUTATING_TOOL_NAMES = new Set(["edit", "write"]);
const IMAGE_CAPABLE_TOOLS = new Set(["read"]);

// ── module state ─────────────────────────────────────────────────────────────

let session: ReplSession | undefined;
let mode: CodeModeState = "off";
let previousTools: string[] | undefined;
let currentCtx: ExtensionContext | undefined;
let isSafeCommandFn: ((command: string) => boolean) | undefined;
let nestedCallCounter = 0;

// ── nested tool bindings ─────────────────────────────────────────────────────

function isPlanModeActive(): boolean {
	if (!currentCtx) return false;
	return isPlanModeExecuting(currentCtx.sessionManager.getEntries());
}

function gateNestedTool(name: string, args: unknown): void {
	if (!isPlanModeActive()) return;
	if (MUTATING_TOOL_NAMES.has(name)) {
		throw new Error(`Blocked: plan mode is active (read-only). \`tools.${name}\` is unavailable inside exec until plan mode exits.`);
	}
	if (name === "bash") {
		const command = (args as { command?: unknown } | undefined)?.command;
		if (typeof command === "string" && isSafeCommandFn) {
			if (!isSafeCommandFn(command)) {
				throw new Error(
					"Blocked: plan mode is active; only read-only bash commands are allowed inside exec (e.g. git status, rg, ls).",
				);
			}
			return;
		}
		throw new Error(
			"Blocked: plan mode is active and its command guard is unavailable; `tools.bash` is disabled inside exec until plan mode exits.",
		);
	}
}

function mapToolContent(content: Array<{ type: string }>): string | ReplOutputItem[] {
	const allText = content.every((block) => block.type === "text");
	if (allText) {
		return content.map((block) => (block as { text?: string }).text ?? "").join("\n");
	}
	return content.map((block) => {
		if (block.type === "image") {
			const image = block as { data: string; mimeType: string };
			return { type: "image", data: image.data, mimeType: image.mimeType };
		}
		return { type: "text", text: (block as { text?: string }).text ?? "" };
	});
}

function buildBindings(cwd: string): ReplToolBinding[] {
	const tools = [
		createReadTool(cwd),
		createBashTool(cwd),
		createEditTool(cwd),
		createWriteTool(cwd),
		createGrepTool(cwd),
		createFindTool(cwd),
		createLsTool(cwd),
	];
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		run: async (args, signal) => {
			gateNestedTool(tool.name, args);
			const result = await tool.execute(`code-mode-${++nestedCallCounter}`, args as never, signal);
			return mapToolContent(result.content as Array<{ type: string }>);
		},
	}));
}

function nestedToolInfos(): NestedToolInfo[] {
	// Schemas/descriptions are cwd-independent; build a throwaway set for the
	// static exec tool description.
	return buildBindings(process.cwd()).map((binding) => ({
		name: binding.name,
		description: binding.description,
		parameters: binding.parameters,
		mayReturnContentBlocks: IMAGE_CAPABLE_TOOLS.has(binding.name),
	}));
}

// ── llm.query ────────────────────────────────────────────────────────────────

const llmQuery: LlmQueryFn = async (prompt, options, signal) => {
	const ctx = currentCtx;
	if (!ctx) {
		throw new Error("llm.query is unavailable: no active session context");
	}

	let model = ctx.model;
	if (options.model !== undefined) {
		const ref = parseModelRef(options.model);
		if (!ref) {
			throw new Error(`llm.query: invalid model "${options.model}" — expected "provider/id"`);
		}
		const found = ctx.modelRegistry.find(ref.provider, ref.modelId);
		if (!found) {
			throw new Error(`llm.query: model "${options.model}" was not found in the model registry`);
		}
		model = found;
	}
	if (!model) {
		throw new Error("llm.query: no active model in this session");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(`llm.query: ${auth.error}`);
	}

	const stream = streamSimple(
		model,
		{
			systemPrompt: options.system,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		},
		{
			apiKey: auth.apiKey ?? "",
			headers: auth.headers,
			env: auth.env,
			maxTokens: options.maxTokens,
			reasoning: options.reasoning as never,
			signal,
		},
	);
	const message = await stream.result();
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(`llm.query failed: ${message.errorMessage ?? message.stopReason}`);
	}
	return { text: contentText(message.content), usage: message.usage as Usage };
};

// ── session / mode management ────────────────────────────────────────────────

function getSession(ctx: ExtensionContext): ReplSession {
	currentCtx = ctx;
	if (!session) {
		session = new ReplSession({ tools: buildBindings(ctx.cwd), llmQuery });
	}
	return session;
}

function updateStatus(ctx: ExtensionContext): void {
	if (mode === "off") {
		ctx.ui.setStatus("code-mode", undefined);
		return;
	}
	ctx.ui.setStatus("code-mode", ctx.ui.theme.fg("accent", `⟨⟩ code: ${mode}`));
}

// ── result mapping ───────────────────────────────────────────────────────────

function outcomeToResult(outcome: CellOutcome): {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details: Record<string, unknown>;
	usage?: Usage;
} {
	return {
		content: outcome.items.map((item) =>
			item.type === "text"
				? { type: "text" as const, text: item.text }
				: { type: "image" as const, data: item.data, mimeType: item.mimeType },
		),
		details: {
			cellId: outcome.cellId,
			state: outcome.state,
			errorText: outcome.errorText,
			truncated: outcome.truncated,
		},
		usage: outcome.usage as Usage | undefined,
	};
}

// ── rendering ────────────────────────────────────────────────────────────────

function firstLines(text: string, count: number): { preview: string; more: boolean } {
	const lines = text.split("\n");
	const preview = lines.slice(0, count).join("\n");
	return { preview, more: lines.length > count };
}

function renderCodeResult(
	result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> },
	options: { expanded: boolean; isPartial: boolean },
	theme: ExtensionContext["ui"]["theme"],
	toolName: string,
): Text {
	if (options.isPartial) {
		return new Text(theme.fg("dim", "… running"), 0, 0);
	}
	const details = result.details ?? {};
	const state = String(details.state ?? "completed");
	const icon =
		state === "completed"
			? theme.fg("success", "✓")
			: state === "failed"
				? theme.fg("error", "✗")
				: state === "yielded" || state === "running"
					? theme.fg("warning", "…")
					: theme.fg("muted", "■");
	let text = `${icon} ${theme.fg("toolTitle", toolName)}`;
	if ((state === "yielded" || state === "running") && typeof details.cellId === "string") {
		text += theme.fg("dim", ` [${details.cellId}]`);
	}
	if (details.truncated === true) {
		text += theme.fg("warning", " (output truncated)");
	}
	const output = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	const imageCount = result.content.filter((block) => block.type === "image").length;
	if (output.trim().length > 0) {
		const { preview, more } = options.expanded ? { preview: output, more: false } : firstLines(output, 4);
		text += `\n${theme.fg("muted", preview)}`;
		if (more) text += `\n${theme.fg("dim", "… expand to see all output")}`;
	}
	if (imageCount > 0) {
		text += `\n${theme.fg("dim", `[${imageCount} image${imageCount === 1 ? "" : "s"}]`)}`;
	}
	return new Text(text, 0, 0);
}

// ── extension ────────────────────────────────────────────────────────────────

export default function codeModeExtension(pi: ExtensionAPI): void {
	function persistState(): void {
		pi.appendEntry(ENTRY_TYPE, { mode, previousTools });
	}

	function applyMode(ctx: ExtensionContext): void {
		if (mode === "strict") {
			pi.setActiveTools([...MODE_TOOL_NAMES]);
		} else if (mode === "hybrid") {
			pi.setActiveTools([...new Set([...pi.getActiveTools(), ...MODE_TOOL_NAMES])]);
		} else {
			const active = pi.getActiveTools();
			if (active.some((name) => (MODE_TOOL_NAMES as readonly string[]).includes(name))) {
				pi.setActiveTools(
					active.filter((name) => !(MODE_TOOL_NAMES as readonly string[]).includes(name)),
				);
			}
		}
		updateStatus(ctx);
	}

	pi.registerFlag("code-mode", {
		description: "Start the session in code mode (strict): only the exec and wait tools are active",
		type: "boolean",
		default: false,
	});

	// ── exec tool ────────────────────────────────────────────────────────────

	pi.registerTool({
		name: EXEC_TOOL_NAME,
		label: "Exec (code mode)",
		description: buildExecDescription(nestedToolInfos()),
		promptSnippet:
			"Run JavaScript to orchestrate nested tools (read/bash/edit/write/grep/find/ls) and sub-LLM calls with explicit output control",
		promptGuidelines: [
			"Use exec instead of individual tool calls when a task needs several tool calls, loops, or filtering of large outputs: intermediate results stay inside the exec sandbox and only text(...)/image(...) output enters the conversation.",
			"Use the llm.query(...) helper inside exec to summarize or extract from large data with a fresh-context sub-LLM instead of loading that data into the conversation.",
			"Use the wait tool to collect more output from, or terminate, a long-running exec cell.",
		],
		parameters: Type.Object({
			source: Type.String({
				description:
					'Raw JavaScript source, evaluated as an async function body. May start with a first-line pragma like // @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}.',
			}),
			yield_time_ms: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: `Return early with a cell ID if the script is still running after this many ms (default ${DEFAULT_EXEC_YIELD_TIME_MS}).`,
				}),
			),
			max_output_tokens: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: `Token budget for text returned by this call (default ${DEFAULT_MAX_OUTPUT_TOKENS}).`,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			currentCtx = ctx;
			const parsed = parseExecSource(params.source);
			const budgets = resolveExecBudgets(params, parsed);
			const repl = getSession(ctx);
			const outcome = await repl.execute(parsed.code, budgets, signal, (preview) => {
				onUpdate?.({ content: [{ type: "text", text: preview }] });
			});
			return outcomeToResult(outcome);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const source = typeof args.source === "string" ? args.source : "";
			const firstLine = source.split("\n", 1)[0] ?? "";
			const lineCount = source.length === 0 ? 0 : source.split("\n").length;
			let content = theme.fg("toolTitle", theme.bold("exec "));
			content += theme.fg("dim", firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine);
			if (lineCount > 1) content += theme.fg("dim", ` … (${lineCount} lines)`);
			if (context.expanded && source.length > 0) {
				content += `\n${highlightCode(source, "javascript", theme)}`;
			}
			text.setText(content);
			return text;
		},
		renderResult(result, options, theme) {
			return renderCodeResult(
				result as { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> },
				options,
				theme,
				EXEC_TOOL_NAME,
			);
		},
	});

	// ── wait tool ────────────────────────────────────────────────────────────

	pi.registerTool({
		name: WAIT_TOOL_NAME,
		label: "Wait (code mode)",
		description: WAIT_TOOL_DESCRIPTION,
		promptSnippet: "Collect output from, or terminate, a running exec cell",
		parameters: Type.Object({
			cell_id: Type.String({ description: "The cell ID returned by a yielded exec call." }),
			yield_time_ms: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: `How long to wait for more output before returning again (default ${DEFAULT_WAIT_YIELD_TIME_MS}).`,
				}),
			),
			max_output_tokens: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: `Token budget for new output returned by this call (default ${DEFAULT_MAX_OUTPUT_TOKENS}).`,
				}),
			),
			terminate: Type.Optional(
				Type.Boolean({ description: "Stop the running cell instead of waiting for output." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			currentCtx = ctx;
			const repl = getSession(ctx);
			const outcome = await repl.wait(
				params.cell_id,
				{
					yieldTimeMs: params.yield_time_ms ?? DEFAULT_WAIT_YIELD_TIME_MS,
					maxOutputTokens: params.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
					terminate: params.terminate,
				},
				signal,
			);
			return outcomeToResult(outcome);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let content = theme.fg("toolTitle", theme.bold("wait "));
			content += theme.fg("dim", String(args.cell_id ?? ""));
			if (args.terminate === true) content += theme.fg("warning", " (terminate)");
			text.setText(content);
			return text;
		},
		renderResult(result, options, theme) {
			return renderCodeResult(
				result as { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> },
				options,
				theme,
				WAIT_TOOL_NAME,
			);
		},
	});

	// ── /code-mode command ───────────────────────────────────────────────────

	pi.registerCommand("code-mode", {
		description: "Toggle code mode: /code-mode [strict|hybrid|off|status] (default toggles strict)",
		getArgumentCompletions: (prefix) => {
			const items = ["strict", "hybrid", "off", "status"].map((value) => ({ value, label: value }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const command = parseModeArg(mode, args);
			if (command.action === "error") {
				ctx.ui.notify(command.message, "error");
				return;
			}
			if (command.action === "status") {
				const cells = session?.activeCellIds ?? [];
				const keys = session?.storeKeys ?? [];
				ctx.ui.notify(
					[
						`code mode: ${mode}`,
						`active cells: ${cells.length > 0 ? cells.join(", ") : "none"}`,
						`store keys: ${keys.length > 0 ? keys.join(", ") : "none"}`,
					].join("\n"),
					"info",
				);
				return;
			}

			const transition = computeToolTransition({
				target: command.mode,
				currentMode: mode,
				currentActive: pi.getActiveTools(),
				previousTools,
			});
			mode = command.mode;
			previousTools = transition.previousTools;
			pi.setActiveTools(transition.active);
			persistState();
			updateStatus(ctx);

			if (mode === "off") {
				ctx.ui.notify("Code mode off — previous tool set restored.", "info");
			} else if (mode === "strict") {
				ctx.ui.notify("Code mode strict — all work goes through exec/wait.", "info");
			} else {
				ctx.ui.notify("Code mode hybrid — exec/wait added alongside existing tools.", "info");
			}
		},
	});

	// ── strict-mode prompt line ──────────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		if (mode !== "strict") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${STRICT_MODE_PROMPT}` };
	});

	// ── session lifecycle ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		session = undefined; // fresh cells + store per session
		mode = "off";
		previousTools = undefined;

		// Best-effort plan-mode guard import (works in the repo checkout and when
		// both extensions are symlinked side by side).
		try {
			const mod = (await import("../plan-mode/utils.ts")) as { isSafeCommand?: unknown };
			isSafeCommandFn = typeof mod.isSafeCommand === "function" ? mod.isSafeCommand : undefined;
		} catch {
			isSafeCommandFn = undefined;
		}

		// Restore persisted state (latest entry wins).
		let restored = false;
		for (const entry of ctx.sessionManager.getEntries()) {
			const record = entry as { type?: string; customType?: string; data?: unknown };
			if (record.type === "custom" && record.customType === ENTRY_TYPE) {
				const data = record.data as
					| { mode?: CodeModeState; previousTools?: string[] }
					| undefined;
				if (data?.mode === "off" || data?.mode === "hybrid" || data?.mode === "strict") {
					mode = data.mode;
					previousTools = Array.isArray(data.previousTools) ? data.previousTools : undefined;
					restored = true;
				}
			}
		}

		// --code-mode flag enters strict mode when nothing was persisted.
		if (!restored && pi.getFlag("code-mode")) {
			mode = "strict";
			previousTools = pi
				.getActiveTools()
				.filter((name) => !(MODE_TOOL_NAMES as readonly string[]).includes(name));
			persistState();
		}

		applyMode(ctx);
	});

	pi.on("session_shutdown", async () => {
		session?.dispose();
		session = undefined;
	});
}
