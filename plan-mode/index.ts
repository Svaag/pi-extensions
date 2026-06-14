/**
 * Plan Mode Extension
 *
 * Safe read-only planning and code analysis mode based exactly on OpenAI Codex and Claude Code.
 * Restricted to non-mutating actions until explicitly finalized.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type } from "typebox";
import {
	extractProposedPlan,
	extractTodoItemsFromProposedPlan,
	isSafeCommand,
	markCompletedSteps,
	type TodoItem,
} from "./utils.js";

const DEFAULT_NORMAL_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_QUESTIONS_TOOL = "plan_questions";
const MUTATING_TOOLS_IN_PLAN_MODE = new Set(["edit", "write"]);

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block: any): block is TextContent => block.type === "text")
		.map((block: TextContent) => block.text)
		.join("\n");
}

interface PlanQuestionOption {
	value: string;
	label: string;
	description?: string;
}

interface PlanQuestion {
	id: string;
	label: string;
	prompt: string;
	options: PlanQuestionOption[];
	allowOther: boolean;
}

interface PlanQuestionAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface PlanQuestionsResult {
	questions: PlanQuestion[];
	answers: PlanQuestionAnswer[];
	cancelled: boolean;
}

const PlanQuestionOptionSchema = Type.Object({
	value: Type.String({ description: "Stable value returned when selected" }),
	label: Type.String({ description: "Human-readable option label" }),
	description: Type.Optional(Type.String({ description: "Optional detail shown under the option" })),
});

const PlanQuestionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier, e.g. scope, storage, rollout" }),
	label: Type.Optional(Type.String({ description: "Short tab label, e.g. Scope, Storage, Rollout" })),
	prompt: Type.String({ description: "The implementation-detail question to ask" }),
	options: Type.Array(PlanQuestionOptionSchema, {
		description: "2-4 meaningful choices. Include a recommended default where appropriate.",
	}),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow a custom written answer (default: true)" })),
});

const PlanQuestionsParams = Type.Object({
	questions: Type.Array(PlanQuestionSchema, { description: "Planning questions to ask the user in one TUI flow" }),
});

function planQuestionsError(message: string, questions: PlanQuestion[] = []) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { questions, answers: [], cancelled: true } satisfies PlanQuestionsResult,
	};
}

function planTitle(plan: string): string {
	const heading = plan.match(/^#\s+(.+)$/m)?.[1]?.trim();
	if (heading) return heading;
	return plan.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "implementation-plan";
}

function slugifyPlanTitle(title: string): string {
	return (
		title
			.replace(/`([^`]+)`/g, "$1")
			.replace(/[^a-z0-9]+/gi, "-")
			.replace(/^-+|-+$/g, "")
			.toLowerCase()
			.slice(0, 80) || "implementation-plan"
	);
}

function timestampForFilename(date = new Date()): string {
	return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
}

function buildSavedPlanMarkdown(plan: string, createdAt = new Date()): string {
	return [
		"---",
		`created: ${createdAt.toISOString()}`,
		"source: pi-plan-mode",
		"status: accepted-for-execution",
		"---",
		"",
		plan.trim(),
		"",
	].join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let lastProposedPlan = "";
	let todoItems: TodoItem[] = [];
	let savedTools: string[] = [];

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only planning and exploration)",
		type: "boolean",
		default: false,
	});

	async function projectRoot(ctx: ExtensionContext): Promise<string> {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd: ctx.cwd,
			timeout: 5000,
			signal: ctx.signal,
		});
		if (result.code === 0) {
			const root = result.stdout.trim().split("\n").pop()?.trim();
			if (root) return root;
		}
		return ctx.cwd;
	}

	async function savePlanForExecution(ctx: ExtensionContext): Promise<string> {
		if (!lastProposedPlan.trim()) throw new Error("No proposed plan is available to save.");

		const root = await projectRoot(ctx);
		const plansDir = join(root, "docs", "plans");
		await mkdir(plansDir, { recursive: true });

		const title = planTitle(lastProposedPlan);
		const filename = `${timestampForFilename()}-${slugifyPlanTitle(title)}.md`;
		const absolutePath = join(plansDir, filename);
		await writeFile(absolutePath, buildSavedPlanMarkdown(lastProposedPlan), "utf8");

		const relativePath = relative(root, absolutePath) || absolutePath;
		pi.appendEntry("plan-mode-saved-plan", {
			path: absolutePath,
			relativePath,
			root,
			title,
			savedAt: new Date().toISOString(),
		});
		return relativePath;
	}

	pi.registerTool({
		name: PLAN_QUESTIONS_TOOL,
		label: "Plan Questions",
		description:
			"Ask the user one or more implementation-detail planning questions in an interactive TUI wizard. Use this instead of writing long numbered A/B/C questionnaires in chat.",
		promptSnippet: "Ask planning clarification questions with an interactive TUI wizard",
		promptGuidelines: [
			"Use plan_questions in Plan Mode whenever you need user answers to implementation-detail questions; do not print long numbered A/B/C questionnaires in normal assistant text.",
			"For plan_questions, batch related questions together, provide concise tab labels, include 2-4 meaningful options, and include a recommended/default option when one is reasonable.",
		],
		parameters: PlanQuestionsParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return planQuestionsError("Error: plan_questions requires interactive TUI mode");
			}
			if (params.questions.length === 0) {
				return planQuestionsError("Error: no planning questions provided");
			}

			const questions: PlanQuestion[] = params.questions.map((q: any, i: number) => ({
				id: q.id || `q${i + 1}`,
				label: q.label || `Q${i + 1}`,
				prompt: q.prompt,
				options: Array.isArray(q.options) ? q.options : [],
				allowOther: q.allowOther !== false,
			}));
			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1;

			const result = await ctx.ui.custom<PlanQuestionsResult>((tui, theme, _kb, done) => {
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, PlanQuestionAnswer>();

				const editorTheme: EditorTheme = {
					borderColor: (s: string) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh(): void {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean): void {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion(): PlanQuestion | undefined {
					return questions[currentTab];
				}

				function currentOptions(): Array<PlanQuestionOption & { isOther?: boolean }> {
					const q = currentQuestion();
					if (!q) return [];
					const opts: Array<PlanQuestionOption & { isOther?: boolean }> = [...q.options];
					if (q.allowOther) opts.push({ value: "__other__", label: "Type a custom answer", isOther: true });
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function advanceAfterAnswer(): void {
					if (!isMulti) {
						submit(false);
						return;
					}
					currentTab = currentTab < questions.length - 1 ? currentTab + 1 : questions.length;
					optionIndex = 0;
					refresh();
				}

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number): void {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index });
				}

				editor.onSubmit = (value: string) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim() || "(no response)";
					saveAnswer(inputQuestionId, trimmed, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function handleInput(data: string): void {
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
					}

					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
						else if (matchesKey(data, Key.escape)) submit(true);
						return;
					}

					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					if (matchesKey(data, Key.enter) && q) {
						const opt = opts[optionIndex];
						if (!opt) return;
						if (opt.isOther) {
							const existing = answers.get(q.id);
							inputMode = true;
							inputQuestionId = q.id;
							editor.setText(existing?.wasCustom ? existing.label : "");
							refresh();
							return;
						}
						saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
						advanceAfterAnswer();
						return;
					}

					if (matchesKey(data, Key.escape)) submit(true);
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;
					const lines: string[] = [];
					const q = currentQuestion();
					const opts = currentOptions();
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					add(theme.fg("accent", "─".repeat(width)));

					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const active = i === currentTab;
							const answered = answers.has(questions[i].id);
							const box = answered ? "■" : "□";
							const text = ` ${box} ${questions[i].label} `;
							tabs.push(active ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answered ? "success" : "muted", text));
						}
						const submitText = " ✓ Submit ";
						tabs.push(
							currentTab === questions.length
								? theme.bg("selectedBg", theme.fg("text", submitText))
								: theme.fg(allAnswered() ? "success" : "dim", submitText),
						);
						add(` ${tabs.join(" ")} →`);
						lines.push("");
					}

					function renderOptions(): void {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const chosen = q ? answers.get(q.id)?.value === opt.value : false;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const marker = chosen ? theme.fg("success", "✓ ") : `${i + 1}. `;
							add(prefix + theme.fg(selected ? "accent" : "text", marker + opt.label));
							if (opt.description) add(`     ${theme.fg("muted", opt.description)}`);
						}
					}

					if (inputMode && q) {
						add(theme.fg("text", ` ${q.prompt}`));
						lines.push("");
						renderOptions();
						lines.push("");
						add(theme.fg("muted", " Your answer:"));
						for (const line of editor.render(width - 2)) add(` ${line}`);
						lines.push("");
						add(theme.fg("dim", " Enter to save • Esc back"));
					} else if (currentTab === questions.length) {
						add(theme.fg("accent", theme.bold(" Review answers")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							add(`${theme.fg("muted", ` ${question.label}: `)}${answer ? theme.fg("text", answer.label) : theme.fg("warning", "unanswered")}`);
						}
						lines.push("");
						add(allAnswered() ? theme.fg("success", " Press Enter to submit") : theme.fg("warning", " Tab back to answer missing questions"));
					} else if (q) {
						add(theme.fg("text", ` ${q.prompt}`));
						lines.push("");
						renderOptions();
					}

					lines.push("");
					if (!inputMode) {
						add(theme.fg("dim", isMulti ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel" : " ↑↓ select • Enter confirm • Esc cancel"));
					}
					add(theme.fg("accent", "─".repeat(width)));
					cachedLines = lines;
					return lines;
				}

				return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
			}, {
				overlay: true,
				overlayOptions: { width: "80%", minWidth: 60, maxHeight: "80%", anchor: "center" },
			});

			if (result.cancelled) {
				return { content: [{ type: "text" as const, text: "User cancelled the planning questions" }], details: result };
			}

			const answerLines = result.answers.map((answer) => {
				const question = questions.find((q) => q.id === answer.id);
				const prefix = question ? `${question.label} (${question.id})` : answer.id;
				return answer.wasCustom ? `${prefix}: user wrote: ${answer.label}` : `${prefix}: user selected: ${answer.index}. ${answer.label}`;
			});

			return { content: [{ type: "text" as const, text: answerLines.join("\n") }], details: result };
		},

		renderCall(args, theme) {
			const qs = ((args.questions as PlanQuestion[]) || []);
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("plan_questions "));
			text += theme.fg("muted", `${qs.length} question${qs.length === 1 ? "" : "s"}`);
			if (labels) text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as PlanQuestionsResult | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.cancelled) return new Text(theme.fg("warning", "Planning questions cancelled"), 0, 0);
			return new Text(
				details.answers
					.map((a) => `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${a.wasCustom ? theme.fg("muted", "(wrote) ") : ""}${a.label}`)
					.join("\n"),
				0,
				0,
			);
		},
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t: TodoItem) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item: TodoItem) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function normalizeToolNames(tools: unknown): string[] {
		if (!Array.isArray(tools)) return [];
		return tools.flatMap((tool) => {
			if (typeof tool === "string") return [tool];
			if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") {
				return [tool.name];
			}
			return [];
		});
	}

	function existingToolNames(names: string[]): string[] {
		const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
		return names.filter((name) => allToolNames.has(name));
	}

	function planModeToolNames(names: string[]): string[] {
		const safeTools = names.filter(
			(name: string) => !MUTATING_TOOLS_IN_PLAN_MODE.has(name) && name !== PLAN_QUESTIONS_TOOL,
		);
		return existingToolNames([...safeTools, PLAN_QUESTIONS_TOOL]);
	}

	function defaultNormalTools(): string[] {
		return existingToolNames(DEFAULT_NORMAL_TOOLS);
	}

	function currentActiveToolNames(): string[] {
		return existingToolNames(normalizeToolNames(pi.getActiveTools()));
	}

	function restoreSavedTools(): void {
		const toolsToRestore = existingToolNames(savedTools.filter((name: string) => name !== PLAN_QUESTIONS_TOOL));
		pi.setActiveTools(toolsToRestore.length > 0 ? toolsToRestore : defaultNormalTools());
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;

		if (planModeEnabled) {
			// Save current tools and filter out edit/write. pi.getActiveTools() returns tool names.
			const currentTools = currentActiveToolNames();
			savedTools = (currentTools.length > 0 ? currentTools : defaultNormalTools()).filter(
				(name: string) => name !== PLAN_QUESTIONS_TOOL,
			);
			pi.setActiveTools(planModeToolNames(savedTools));
			lastProposedPlan = "";
			todoItems = [];
			ctx.ui.notify(`Plan mode enabled. Mutating tools (edit/write) disabled.`);
		} else {
			restoreSavedTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		persistState();
		updateStatus(ctx);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			lastProposedPlan: lastProposedPlan,
			savedTools: savedTools,
		});
	}

	function parseStepSpec(spec: string): number[] {
		const steps = new Set<number>();
		for (const token of spec.split(/\s*(?:,|\s+|and|&)\s*/i)) {
			if (!token.trim()) continue;
			const range = token.match(/^(\d+)\s*(?:-|–|—|\.\.)\s*(\d+)$/);
			if (range) {
				const start = Number(range[1]);
				const end = Number(range[2]);
				const lo = Math.min(start, end);
				const hi = Math.max(start, end);
				for (let i = lo; i <= hi; i++) steps.add(i);
				continue;
			}
			const value = Number(token);
			if (Number.isFinite(value)) steps.add(value);
		}
		return [...steps];
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration & planning)",
		handler: async (_args: any, ctx: ExtensionContext) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show or update current plan todo list. Usage: /todos, /todos done 1-3, /todos reset",
		handler: async (args: any, ctx: ExtensionContext) => {
			const command = String(args ?? "").trim();
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}

			if (/^(done|mark|complete)\b/i.test(command)) {
				const steps = parseStepSpec(command.replace(/^(done|mark|complete)\b/i, ""));
				let changed = 0;
				for (const step of steps) {
					const item = todoItems.find((todo: TodoItem) => todo.step === step);
					if (item && !item.completed) {
						item.completed = true;
						changed++;
					}
				}
				persistState();
				updateStatus(ctx);
				ctx.ui.notify(changed > 0 ? `Marked ${changed} step(s) done.` : "No matching unfinished steps.", "info");
				return;
			}

			if (/^reset\b/i.test(command)) {
				for (const item of todoItems) item.completed = false;
				persistState();
				updateStatus(ctx);
				ctx.ui.notify("Reset plan progress.", "info");
				return;
			}

			const list = todoItems.map((item: TodoItem, i: number) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx: ExtensionContext) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event: any) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event: any) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m: any) => {
				const msg = m as AgentMessage & { customType?: string };
				if (
					msg.customType === "plan-mode-context" ||
					msg.customType === "plan-refinement-context" ||
					msg.customType === "plan-execution-context"
				) {
					return false;
				}
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c: any) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			if (lastProposedPlan) {
				// We have a proposed plan, so the user is refining it!
				return {
					message: {
						customType: "plan-refinement-context",
						content: `[PLAN MODE ACTIVE - REFINING PLAN]
You are in Plan Mode (read-only). Your goal is to refine, enhance, and edit the existing proposed plan based on the user's feedback.

Here is the current proposed plan:
<proposed_plan>
${lastProposedPlan}
</proposed_plan>

Please carefully read the user's feedback/request, and produce an updated, complete replacement plan. Remember:
1. The new plan must be a complete, self-contained replacement for the previous plan. Include all sections (Summary, Implementation Steps, Test Plan, Assumptions, etc.) with the new changes incorporated.
2. It must be wrapped in a single <proposed_plan> block.
3. Include a dedicated \`## Implementation Steps\` or \`## Execution Steps\` section. Put the tracker-level work as a concise top-level numbered list or numbered \`###\` headings; put facts, examples, tests, acceptance criteria, and reference lists in separate sections so they are not treated as todos.
4. Ensure the plan remains decision-complete, highly detailed, and follows all Plan Mode rules.`,
						display: false,
					},
				};
			}

			// No proposed plan yet - output full Codex plan.md mode rules
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You work in 3 phases, and you should *chat your way* to a great plan before finalizing it. A great plan is very detailed—intent- and implementation-wise—so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions.

## Mode rules (strict)
You are in **Plan Mode** until a developer message explicitly ends it.
Plan Mode is not changed by user intent, tone, or imperative language. If a user asks for execution while still in Plan Mode, treat it as a request to **plan the execution**, not perform it.

## Execution vs. mutation in Plan Mode
You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.

### Allowed (non-mutating, plan-improving)
Actions that gather truth, reduce ambiguity, or validate feasibility without changing repo-tracked state. Examples:
* Reading or searching files, configs, schemas, types, manifests, and docs
* Static analysis, inspection, and repo exploration
* Dry-run style commands when they do not edit repo-tracked files
* Tests, builds, or checks that do not edit repo-tracked files

### Not allowed (mutating, plan-executing)
Actions that implement the plan or change repo-tracked state. Examples:
* Editing or writing files (the edit and write tools are disabled)
* Running formatters or linters that rewrite files
* Applying patches, migrations, or codegen that updates repo-tracked files
* Side-effectful commands whose purpose is to carry out the plan rather than refine it

When in doubt: if the action would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## PHASE 1 — Ground in the environment (explore first, ask second)
Begin by grounding yourself in the actual environment. Eliminate unknowns in the prompt by discovering facts, not by asking the user. Resolve all questions that can be answered through exploration or inspection. Identify missing or ambiguous details only if they cannot be derived from the environment. Silent exploration between turns is allowed and encouraged.
Before asking the user any question, perform at least one targeted non-mutating exploration pass (for example: search relevant files, inspect likely entrypoints/configs, confirm current implementation shape), unless no local environment/repo is available.
Exception: you may ask clarifying questions about the user's prompt before exploring, ONLY if there are obvious ambiguities or contradictions in the prompt itself. However, if ambiguity might be resolved by exploring, always prefer exploring first.
Do not ask questions that can be answered from the repo or system. Only ask once you have exhausted reasonable non-mutating exploration.

## PHASE 2 — Intent chat (what they actually want)
* Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.
* Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet—ask.

## PHASE 3 — Implementation chat (what/how we’ll build)
* Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.

## Asking questions
* If you need one or more user answers about implementation details, use the \`plan_questions\` tool instead of writing a long numbered A/B/C questionnaire in chat.
* Batch related questions into one \`plan_questions\` call. Give each question a short label, a clear prompt, 2–4 meaningful choices, and mark/recommend the best default in the option label or description when appropriate.
* Offer only meaningful options; don’t include filler choices that are obviously wrong or irrelevant.
* You SHOULD ask many questions when needed, but each question must materially change the spec/plan, confirm/lock an assumption, or choose between meaningful tradeoffs.

## Two kinds of unknowns (treat differently)
1. **Discoverable facts** (repo/system truth): explore first.
   * Before asking, run targeted searches and check likely sources of truth.
   * Ask only if: multiple plausible candidates; nothing found but you need a missing identifier/context; or ambiguity is actually product intent.
   * If asking, present concrete candidates + recommend one.
2. **Preferences/tradeoffs** (not discoverable): ask early.
   * These are intent or implementation preferences that cannot be derived from exploration.
   * Provide 2–4 mutually exclusive options + a recommended default.
   * If unanswered, proceed with the recommended option and record it as an assumption in the final plan.

## Finalization rule
Only output the final plan when it is decision complete and leaves no decisions to the implementer.
When you present the official plan, wrap it in a \`<proposed_plan>\` block so the client can render it specially:

1) The opening tag must be on its own line.
2) Start the plan content on the next line (no text on the same line as the tag).
3) The closing tag must be on its own line.
4) Use Markdown inside the block.
5) Keep the tags exactly as \`<proposed_plan>\` and \`</proposed_plan>\`.

Plan tracker formatting:
* Include a dedicated \`## Implementation Steps\`, \`## Execution Steps\`, or \`## Action Plan\` section.
* Put only the tracker-level work items in that section, preferably as a top-level numbered list or numbered \`###\` headings.
* Keep facts, inventory, config examples, env var lists, detailed sub-bullets, test matrices, and acceptance criteria in separate sections. They are useful plan detail, but they should not become progress-tracker todos.

Example:
<proposed_plan>
# Clear Title

## Summary
Brief summary section

## Implementation Steps
1. Update the config loader and defaults.
2. Refactor affected runtime code paths.
3. Add or update tests.
4. Update documentation.

## Key Details
Decision-complete implementation details grouped by subsystem/behavior.

## Test Plan
Test cases and scenarios

## Assumptions
Explicit assumptions and defaults chosen where needed
</proposed_plan>

Do not ask "should I proceed?" in the final output. The user can easily switch out of Plan mode and request implementation once you have proposed the plan.

Only produce at most one \`<proposed_plan>\` block per turn, and only when you are presenting a complete spec.
If the user stays in Plan mode and asks for revisions after a prior \`<proposed_plan>\`, any new \`<proposed_plan>\` must be a complete replacement.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t: TodoItem) => !t.completed);
			const todoList = remaining.map((t: TodoItem) => `${t.step}. ${t.text}`).join("\n");
			const allSteps = todoItems.map((t: TodoItem) => `Step ${t.step}: ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

All steps for reference:
${allSteps}

**IMPORTANT**: As you complete each step, you MUST mark it done by including a [DONE:n] tag in your response (e.g. [DONE:1] for step 1, [DONE:5] for step 5). Place the tag right after the section that completes the step, or end your response with a concise status line like \`Completed steps: 1-3\`. Multiple [DONE:n] tags can be included in one response if you complete multiple steps. Without these tags or a clear completion status line, the progress tracker may not update.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event: any, ctx: ExtensionContext) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event: any, ctx: ExtensionContext) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t: TodoItem) => t.completed)) {
				const completedList = todoItems.map((t: TodoItem) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				restoreSavedTools();
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract proposed plan from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		let hasNewPlan = false;
		if (lastAssistant) {
			const text = getTextContent(lastAssistant);
			const planContent = extractProposedPlan(text);
			if (planContent) {
				lastProposedPlan = planContent;
				todoItems = extractTodoItemsFromProposedPlan(planContent);
				hasNewPlan = true;
				persistState();
			}
		}

		// Prompt user if a proposed plan was found in this turn
		if (hasNewPlan && todoItems.length > 0) {
			const todoListText = todoItems.map((t: TodoItem, i: number) => `${i + 1}. ☐ ${t.text}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content: `**Proposed Implementation Steps (${todoItems.length}):**\n\n${todoListText}`,
					display: true,
				},
				{ triggerTurn: false },
			);

			const choice = await ctx.ui.select("Plan proposed - what next?", [
				"Start Implementation",
				"Start Implementation with empty context",
				"Refine the plan (provide feedback)",
				"Stay in plan mode",
			]);

			if (choice?.startsWith("Start Implementation with empty context")) {
				let savedPlanPath: string;
				try {
					savedPlanPath = await savePlanForExecution(ctx);
					ctx.ui.notify(`Saved accepted plan to ${savedPlanPath}`, "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not save the accepted plan; execution cancelled.\n${message}`, "error");
					updateStatus(ctx);
					persistState();
					return;
				}

				const planOnlyPrompt = `Implement the plan saved at ${savedPlanPath}.\n\n<proposed_plan>\n${lastProposedPlan}\n</proposed_plan>\n\nStart with step 1: ${todoItems[0].text}`;

				const result = await ctx.newSession({
					parentSession: ctx.sessionManager.getSessionFile(),
					setup: async (sm) => {
						// Seed the new session with the plan as the only context message
						sm.appendMessage({
							role: "user",
							content: [{ type: "text" as const, text: planOnlyPrompt }],
							timestamp: Date.now(),
						});
						// Persist plan-mode state so the new session shows the todo widget and tracks progress
						sm.appendCustomEntry("plan-mode", {
							enabled: false,
							todos: todoItems,
							executing: true,
							lastProposedPlan,
							savedTools,
						});
					},
					withSession: async (newCtx) => {
						newCtx.ui.notify("Started implementation in a fresh session with the plan only.", "info");
					},
				});

				if (result.cancelled) {
					ctx.ui.notify("New session was cancelled. Plan remains in the current session.", "warning");
				}
				return;
			}

			if (choice?.startsWith("Start Implementation") && !choice?.includes("empty context")) {
				let savedPlanPath: string;
				try {
					savedPlanPath = await savePlanForExecution(ctx);
					ctx.ui.notify(`Saved accepted plan to ${savedPlanPath}`, "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not save the accepted plan; execution cancelled.\n${message}`, "error");
					updateStatus(ctx);
					persistState();
					return;
				}

				planModeEnabled = false;
				executionMode = true;
				restoreSavedTools();
				updateStatus(ctx);
				persistState();

				const execMessage = `Execute the plan saved at ${savedPlanPath}. Start with: ${todoItems[0].text}`;
				pi.sendMessage(
					{ customType: "plan-mode-execute", content: execMessage, display: true },
					{ triggerTurn: true },
				);
			} else if (choice?.startsWith("Refine the plan")) {
				const refinement = await ctx.ui.editor("Provide feedback to refine the plan:", "");
				if (refinement?.trim()) {
					pi.sendUserMessage(refinement.trim());
				}
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as
			| {
					data?: {
						enabled: boolean;
						todos?: TodoItem[];
						executing?: boolean;
						lastProposedPlan?: string;
						savedTools?: string[];
					};
			  }
			| undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			lastProposedPlan = planModeEntry.data.lastProposedPlan ?? lastProposedPlan;
			savedTools = existingToolNames(normalizeToolNames(planModeEntry.data.savedTools ?? savedTools)).filter(
				(name: string) => name !== PLAN_QUESTIONS_TOOL,
			);

			// Migrate older sessions whose todos were over-extracted from every list item.
			// Re-parse the stored proposed plan with the current robust extractor, preserving
			// completion flags by matching step text where possible.
			if (lastProposedPlan) {
				const reparsedTodos = extractTodoItemsFromProposedPlan(lastProposedPlan);
				if (reparsedTodos.length > 0 && (todoItems.length === 0 || todoItems.length > reparsedTodos.length * 2)) {
					for (const item of reparsedTodos) {
						const previous = todoItems.find((todo: TodoItem) => todo.text.toLowerCase() === item.text.toLowerCase());
						item.completed = previous?.completed ?? false;
					}
					todoItems = reparsedTodos;
					persistState();
				}
			}
		}

		// Rebuild execution completed state on resume
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (
					entry.type === "message" &&
					"message" in entry &&
					isAssistantMessage(entry.message as AgentMessage)
				) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			const currentActive = currentActiveToolNames();
			const toolsToFilter = currentActive.length > 0 ? currentActive : savedTools.length > 0 ? savedTools : defaultNormalTools();
			pi.setActiveTools(planModeToolNames(toolsToFilter));
		} else if (planModeEntry?.data) {
			restoreSavedTools();
		}
		updateStatus(ctx);
	});
}
