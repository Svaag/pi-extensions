/**
 * Code Mode — REPL session runtime.
 *
 * Executes model-written JavaScript in fresh `node:vm` sandboxes (one per exec
 * call), exposes nested tools + helpers as globals, and manages background
 * cells with codex-style yield/wait/terminate semantics.
 *
 * Dependencies (tool bindings, llm.query implementation) are injected so the
 * session can be unit-tested without a running pi.
 */

import vm from "node:vm";
import {
	STILL_RUNNING_NOTE,
	TERMINATED_NOTE,
	NO_OUTPUT_NOTE,
	addUsage,
	budgetItems,
	ensureJsonSerializable,
	missingCellMessage,
	normalizeIdentifier,
	normalizeImageInput,
	runningNotice,
	stringifyForOutput,
	type ReplOutputItem,
	type ReplUsage,
} from "./utils.ts";

/** Sync evaluation budget for a cell's initial run (covers pre-await loops). */
const SYNC_EXECUTION_TIMEOUT_MS = 60_000;

/** Thrown by the `exit()` helper; signals clean early completion. */
class ExitSignal extends Error {
	constructor() {
		super("exit");
		this.name = "ExitSignal";
	}
}

export interface ReplToolBinding {
	name: string;
	description: string;
	/** JSON Schema for the tool's input object (used for the TS declaration). */
	parameters: unknown;
	/** Execute the tool. Rejects on failure; resolves to text or content blocks. */
	run(args: unknown, signal: AbortSignal): Promise<string | ReplOutputItem[]>;
}

export interface LlmQueryOptions {
	system?: string;
	model?: string;
	maxTokens?: number;
	reasoning?: string;
}

export type LlmQueryFn = (
	prompt: string,
	options: LlmQueryOptions,
	signal: AbortSignal,
) => Promise<{ text: string; usage?: ReplUsage }>;

export interface ReplSessionDeps {
	tools: ReplToolBinding[];
	llmQuery?: LlmQueryFn;
}

export interface CellBudgets {
	yieldTimeMs: number;
	maxOutputTokens: number;
}

export type CellState =
	| "completed"
	| "failed"
	| "yielded"
	| "running"
	| "terminated"
	| "missing";

export interface CellOutcome {
	cellId: string;
	state: CellState;
	items: ReplOutputItem[];
	truncated: boolean;
	errorText?: string;
	/** Usage delta since the last returned outcome for this cell. */
	usage?: ReplUsage;
}

type WaitReason = "settled" | "timeout" | "yield" | "aborted";

interface Cell {
	id: string;
	items: ReplOutputItem[];
	cursor: number;
	settled: boolean;
	closed: boolean;
	terminated: boolean;
	errorText?: string;
	abort: AbortController;
	timers: Set<ReturnType<typeof setTimeout>>;
	waiters: Set<(reason: WaitReason) => void>;
	yieldRequested: boolean;
	usage?: ReplUsage;
	usageReported?: ReplUsage;
	onActivity?: (previewText: string) => void;
}

export class ReplSession {
	private readonly deps: ReplSessionDeps;
	private readonly cells = new Map<string, Cell>();
	private readonly store = new Map<string, unknown>();
	private counter = 0;

	constructor(deps: ReplSessionDeps) {
		this.deps = deps;
	}

	get storeKeys(): string[] {
		return [...this.store.keys()];
	}

	get activeCellIds(): string[] {
		return [...this.cells.values()].filter((cell) => !cell.settled).map((cell) => cell.id);
	}

	/** Terminate all cells and drop all state (session shutdown / reload). */
	dispose(): void {
		for (const cell of this.cells.values()) {
			this.terminateCell(cell);
			this.closeCell(cell);
		}
		this.store.clear();
	}

	// ── public API ───────────────────────────────────────────────────────────

	async execute(
		code: string,
		budgets: CellBudgets,
		signal?: AbortSignal,
		onActivity?: (previewText: string) => void,
	): Promise<CellOutcome> {
		const cell = this.createCell(onActivity);
		const context = this.buildContext(cell);

		let scriptPromise: Promise<unknown> | undefined;
		try {
			const script = new vm.Script(`(async () => {\n${code}\n})()`, {
				filename: `${cell.id}.js`,
			});
			scriptPromise = script.runInContext(context, {
				timeout: SYNC_EXECUTION_TIMEOUT_MS,
			}) as Promise<unknown>;
		} catch (error) {
			// Syntax errors and the sync-execution timeout surface here.
			this.settle(cell, error);
		}
		if (scriptPromise !== undefined) {
			scriptPromise.then(
				() => this.settle(cell),
				(error: unknown) => this.settle(cell, error),
			);
		}

		const onAbort = () => this.terminateCell(cell);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (!cell.settled) {
				await this.awaitProgress(cell, budgets.yieldTimeMs, signal);
			}
			if (cell.settled) {
				return this.finalOutcome(cell, budgets.maxOutputTokens);
			}
			const delivered = this.deliver(cell, budgets.maxOutputTokens);
			return {
				cellId: cell.id,
				state: "yielded",
				items: [...delivered.items, { type: "text", text: runningNotice(cell.id) }],
				truncated: delivered.truncated,
				usage: this.takeUsageDelta(cell),
			};
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async wait(
		cellId: string,
		budgets: CellBudgets & { terminate?: boolean },
		signal?: AbortSignal,
	): Promise<CellOutcome> {
		const cell = this.cells.get(cellId);
		if (!cell) {
			return {
				cellId,
				state: "missing",
				items: [{ type: "text", text: missingCellMessage(cellId) }],
				truncated: false,
			};
		}

		if (budgets.terminate) {
			this.terminateCell(cell);
			return this.finalOutcome(cell, budgets.maxOutputTokens);
		}

		if (!cell.settled) {
			await this.awaitProgress(cell, budgets.yieldTimeMs, signal);
		}
		if (cell.settled) {
			return this.finalOutcome(cell, budgets.maxOutputTokens);
		}
		const delivered = this.deliver(cell, budgets.maxOutputTokens);
		return {
			cellId: cell.id,
			state: "running",
			items: [...delivered.items, { type: "text", text: STILL_RUNNING_NOTE }],
			truncated: delivered.truncated,
			usage: this.takeUsageDelta(cell),
		};
	}

	// ── cell lifecycle ───────────────────────────────────────────────────────

	private createCell(onActivity?: (previewText: string) => void): Cell {
		const cell: Cell = {
			id: `cell-${++this.counter}`,
			items: [],
			cursor: 0,
			settled: false,
			closed: false,
			terminated: false,
			abort: new AbortController(),
			timers: new Set(),
			waiters: new Set(),
			yieldRequested: false,
			onActivity,
		};
		this.cells.set(cell.id, cell);
		return cell;
	}

	private settle(cell: Cell, error?: unknown): void {
		if (cell.settled) return;
		cell.settled = true;
		for (const timer of cell.timers) clearTimeout(timer);
		cell.timers.clear();

		if (error !== undefined && !(error instanceof ExitSignal)) {
			cell.errorText = errorMessage(error);
			cell.items.push({ type: "text", text: `Uncaught ${cell.errorText}` });
		}
		if (cell.items.length === 0) {
			cell.items.push({ type: "text", text: NO_OUTPUT_NOTE });
		}
		this.wake(cell, "settled");
	}

	private terminateCell(cell: Cell): void {
		if (cell.closed) return;
		cell.terminated = true;
		cell.abort.abort();
		for (const timer of cell.timers) clearTimeout(timer);
		cell.timers.clear();
		if (!cell.settled) {
			// Force-settle: we stop tracking the script's eventual outcome. The
			// settled handler is guarded and will no-op when the promise lands.
			cell.settled = true;
			this.wake(cell, "settled");
		}
	}

	private closeCell(cell: Cell): void {
		cell.closed = true;
		cell.abort.abort();
		for (const timer of cell.timers) clearTimeout(timer);
		cell.timers.clear();
		cell.waiters.clear();
		this.cells.delete(cell.id);
	}

	private wake(cell: Cell, reason: WaitReason): void {
		for (const waiter of [...cell.waiters]) waiter(reason);
	}

	private awaitProgress(cell: Cell, yieldTimeMs: number, signal?: AbortSignal): Promise<WaitReason> {
		return new Promise((resolve) => {
			let finished = false;
			const timer = setTimeout(() => finish("timeout"), Math.max(0, yieldTimeMs));
			timer.unref?.();

			const onAbort = () => finish("aborted");

			const finish = (reason: WaitReason) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				cell.waiters.delete(finish);
				cell.yieldRequested = false; // consume the yield request
				resolve(reason);
			};

			cell.waiters.add(finish);
			signal?.addEventListener("abort", onAbort, { once: true });

			// Re-check state in case the cell settled before listeners attached.
			if (cell.settled) finish("settled");
			else if (cell.yieldRequested) finish("yield");
		});
	}

	private finalOutcome(cell: Cell, maxOutputTokens: number): CellOutcome {
		const delivered = this.deliver(cell, maxOutputTokens);
		const state: CellState = cell.terminated ? "terminated" : cell.errorText ? "failed" : "completed";
		const items = [...delivered.items];
		if (cell.terminated) {
			items.push({ type: "text", text: TERMINATED_NOTE });
		}
		const outcome: CellOutcome = {
			cellId: cell.id,
			state,
			items,
			truncated: delivered.truncated,
			errorText: cell.errorText,
			usage: this.takeUsageDelta(cell),
		};
		this.closeCell(cell);
		return outcome;
	}

	private deliver(cell: Cell, maxOutputTokens: number): { items: ReplOutputItem[]; truncated: boolean } {
		const fresh = cell.items.slice(cell.cursor);
		cell.cursor = cell.items.length;
		return budgetItems(fresh, maxOutputTokens);
	}

	private takeUsageDelta(cell: Cell): ReplUsage | undefined {
		const current = cell.usage;
		const reported = cell.usageReported;
		cell.usageReported = current;
		if (!current) return undefined;
		if (!reported) return current;
		const delta: ReplUsage = {
			input: current.input - reported.input,
			output: current.output - reported.output,
			cacheRead: current.cacheRead - reported.cacheRead,
			cacheWrite: current.cacheWrite - reported.cacheWrite,
			reasoning:
				current.reasoning === undefined && reported.reasoning === undefined
					? undefined
					: (current.reasoning ?? 0) - (reported.reasoning ?? 0),
			totalTokens: current.totalTokens - reported.totalTokens,
			cost: {
				input: current.cost.input - reported.cost.input,
				output: current.cost.output - reported.cost.output,
				cacheRead: current.cost.cacheRead - reported.cost.cacheRead,
				cacheWrite: current.cost.cacheWrite - reported.cost.cacheWrite,
				total: current.cost.total - reported.cost.total,
			},
		};
		return delta;
	}

	private activity(cell: Cell): void {
		if (!cell.onActivity) return;
		const text = cell.items
			.filter((item): item is Extract<ReplOutputItem, { type: "text" }> => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		cell.onActivity(text.length > 2000 ? `…${text.slice(-2000)}` : text);
	}

	// ── sandbox ──────────────────────────────────────────────────────────────

	private buildContext(cell: Cell): vm.Context {
		const toolsObject: Record<string, unknown> = {};
		for (const binding of this.deps.tools) {
			toolsObject[normalizeIdentifier(binding.name)] = (args: unknown) =>
				binding.run(args, cell.abort.signal);
		}

		const session = this;
		const sandbox: Record<string, unknown> = {
			// Node injects a forwarding console into vm contexts; mask it to match
			// codex's "no console" sandbox. Output goes through text()/notify().
			console: undefined,
			tools: toolsObject,
			ALL_TOOLS: this.deps.tools.map((tool) => ({
				name: normalizeIdentifier(tool.name),
				description: tool.description,
			})),

			text(value: unknown): void {
				cell.items.push({ type: "text", text: stringifyForOutput(value) });
				session.activity(cell);
			},

			image(source: unknown, mimeType?: unknown): void {
				cell.items.push(normalizeImageInput(source, mimeType));
				session.activity(cell);
			},

			notify(value: unknown): void {
				cell.items.push({ type: "text", text: stringifyForOutput(value) });
				session.activity(cell);
			},

			store(key: unknown, value: unknown): void {
				session.store.set(assertStoreKey(key), ensureJsonSerializable(value));
			},

			load(key: unknown): unknown {
				return session.store.get(assertStoreKey(key));
			},

			yield_control(): void {
				cell.yieldRequested = true;
				session.wake(cell, "yield");
			},

			exit(): never {
				throw new ExitSignal();
			},

			setTimeout(callback: unknown, delayMs?: unknown): unknown {
				if (typeof callback !== "function") {
					throw new TypeError("setTimeout(callback, delayMs) expects a function callback");
				}
				const ms =
					typeof delayMs === "number" && Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
				const timer = setTimeout(() => {
					cell.timers.delete(timer);
					if (cell.settled) return;
					try {
						(callback as () => void)();
					} catch (error) {
						session.settle(cell, error);
					}
				}, ms);
				cell.timers.add(timer);
				return timer;
			},

			clearTimeout(id: unknown): void {
				clearTimeout(id as ReturnType<typeof setTimeout>);
				cell.timers.delete(id as ReturnType<typeof setTimeout>);
			},

			llm: {
				query: async (prompt: unknown, options?: unknown): Promise<string> => {
					if (!session.deps.llmQuery) {
						throw new Error("llm.query is unavailable: no LLM query provider is configured");
					}
					if (typeof prompt !== "string" || prompt.trim().length === 0) {
						throw new TypeError("llm.query(prompt, opts?) expects a non-empty string prompt");
					}
					const opts = sanitizeLlmOptions(options);
					const result = await session.deps.llmQuery(prompt, opts, cell.abort.signal);
					cell.usage = addUsage(cell.usage, result.usage);
					return result.text;
				},
			},
		};

		return vm.createContext(sandbox);
	}
}

/** Extract a message from vm-realm errors (cross-realm instanceof fails). */
function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return String(error);
}

function assertStoreKey(key: unknown): string {	if (typeof key !== "string" || key.length === 0) {
		throw new TypeError("store()/load() expect a non-empty string key");
	}
	return key;
}

function sanitizeLlmOptions(options: unknown): LlmQueryOptions {
	if (options === undefined || options === null) return {};
	if (typeof options !== "object" || Array.isArray(options)) {
		throw new TypeError("llm.query(prompt, opts?) expects an options object");
	}
	const input = options as Record<string, unknown>;
	const output: LlmQueryOptions = {};
	if (input.system !== undefined) {
		if (typeof input.system !== "string") throw new TypeError("llm.query opts.system must be a string");
		output.system = input.system;
	}
	if (input.model !== undefined) {
		if (typeof input.model !== "string") throw new TypeError("llm.query opts.model must be a string");
		output.model = input.model;
	}
	if (input.maxTokens !== undefined) {
		if (typeof input.maxTokens !== "number" || !Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0) {
			throw new TypeError("llm.query opts.maxTokens must be a positive safe integer");
		}
		output.maxTokens = input.maxTokens;
	}
	if (input.reasoning !== undefined) {
		if (typeof input.reasoning !== "string") throw new TypeError("llm.query opts.reasoning must be a string");
		output.reasoning = input.reasoning;
	}
	return output;
}
