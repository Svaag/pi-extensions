/**
 * Plan Mode Extension
 *
 * Safe read-only planning and code analysis mode based exactly on OpenAI Codex and Claude Code.
 * Restricted to non-mutating actions until explicitly finalized.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type AssistantMessage, type Message, type TextContent } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Type } from "typebox";
import {
	extractProposedPlan,
	extractTodoItemsFromProposedPlan,
	hasHandoffClaim,
	isSafeCommand,
	isTodoClosed,
	isTodoDone,
	isTodoOpen,
	markCompletedSteps,
	markExplicitNonDoneSteps,
	renderPlanProgressMarkdown,
	setTodoStatus,
	upsertPlanProgressSection,
	type TodoItem,
	type TodoStatus,
} from "./utils.js";

const DEFAULT_NORMAL_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_QUESTIONS_TOOL = "plan_questions";
const MUTATING_TOOLS_IN_PLAN_MODE = new Set(["edit", "write"]);
const PLAN_AGENT_CONTEXT_CAP = 120_000;
const MAX_PLAN_ROOT_CHOICES = 6;
const PLAN_ROOT_SCORE_THRESHOLD = 60;

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

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

function getPlanningConversationText(ctx: ExtensionContext): string {
	const messages = ctx.sessionManager.getBranch().map(entryToMessage).filter((message) => message !== undefined);
	const text = serializeConversation(convertToLlm(messages));
	if (text.length <= PLAN_AGENT_CONTEXT_CAP) return text;
	return `[Earlier conversation truncated to fit the plan-review agent context. Showing the most recent ${PLAN_AGENT_CONTEXT_CAP} characters.]\n\n${text.slice(-PLAN_AGENT_CONTEXT_CAP)}`;
}

function sameModel(a: any, b: any): boolean {
	return a?.provider === b?.provider && a?.id === b?.id;
}

function modelLabel(model: any): string {
	return `${model.provider}/${model.id}`;
}

interface PlanAgentModelOption {
	label: string;
	description?: string;
	model: any;
	apiKey: string;
	headers?: any;
	isCurrent: boolean;
	fromScopedConfig: boolean;
}

async function readEnabledModelPatterns(ctx: ExtensionContext): Promise<string[]> {
	const paths = [join(homedir(), ".pi", "agent", "settings.json")];
	if (ctx.isProjectTrusted()) paths.push(join(ctx.cwd, ".pi", "settings.json"));
	const patterns: string[] = [];
	for (const path of paths) {
		try {
			const settings = JSON.parse(await readFile(path, "utf8"));
			if (Array.isArray(settings.enabledModels)) {
				patterns.push(...settings.enabledModels.filter((pattern: unknown): pattern is string => typeof pattern === "string" && pattern.trim().length > 0));
			}
		} catch {
			// Missing or invalid settings should not break the planning UI.
		}
	}
	return [...new Set(patterns)];
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

function modelMatchesPattern(model: any, pattern: string): boolean {
	const re = globToRegExp(pattern.trim());
	return re.test(model.id) || re.test(model.name ?? "") || re.test(modelLabel(model));
}

async function getPlanAgentModelOptions(ctx: ExtensionContext): Promise<PlanAgentModelOption[]> {
	const enabledPatterns = await readEnabledModelPatterns(ctx);
	if (enabledPatterns.length === 0) return [];
	const available = await ctx.modelRegistry.getAvailable();
	const scoped = available.filter((model: any) => enabledPatterns.some((pattern) => modelMatchesPattern(model, pattern)));

	const options: PlanAgentModelOption[] = [];
	for (const model of scoped) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) continue;
		const isCurrent = sameModel(ctx.model, model);
		options.push({
			label: `${modelLabel(model)}${isCurrent ? " (current)" : ""}`,
			description: "From enabledModels scoped model config",
			model,
			apiKey: auth.apiKey,
			headers: auth.headers,
			isCurrent,
			fromScopedConfig: true,
		});
	}

	const nonCurrent = options.filter((option) => !option.isCurrent);
	return nonCurrent.length > 0 ? nonCurrent : options;
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
	source?: "agent" | "user";
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

const PLAN_AGENT_SYSTEM_PROMPT = `You are a planning-review sub-agent using the scoped model selected by the user.
You are helping answer one implementation-detail planning question inside Pi Plan Mode.
You are not implementing the plan and you cannot ask the user follow-up questions.
Use the forwarded planning conversation, any partial/current proposed plan, and the available choices to recommend the best answer.
If the information is incomplete, choose the safest high-quality default and state the assumption.
Return a concise answer that can be used directly as the user's planning answer: start with "Recommendation:" and include brief reasoning.`;

function formatExistingAnswers(questions: PlanQuestion[], answers: Map<string, PlanQuestionAnswer>): string {
	const lines: string[] = [];
	for (const question of questions) {
		const answer = answers.get(question.id);
		if (answer) lines.push(`- ${question.label} (${question.id}): ${answer.label}`);
	}
	return lines.join("\n") || "(none yet)";
}

async function askPlanAgentForAnswer(
	ctx: ExtensionContext,
	question: PlanQuestion,
	questions: PlanQuestion[],
	answers: Map<string, PlanQuestionAnswer>,
	lastProposedPlan: string,
	selected: PlanAgentModelOption,
	signal: AbortSignal,
): Promise<{ text: string; model: string }> {
	const optionsText = question.options
		.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""} [value: ${option.value}]`)
		.join("\n");
	const conversationText = getPlanningConversationText(ctx);
	const proposedPlanText = lastProposedPlan.trim()
		? lastProposedPlan.trim()
		: "(No complete <proposed_plan> has been produced yet. Use the planning conversation and current question context.)";

	const userMessage: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text: `## Planning Conversation Context\n\n${conversationText}\n\n## Current Proposed Plan / Draft\n\n${proposedPlanText}\n\n## Existing Answers in This Question Flow\n\n${formatExistingAnswers(questions, answers)}\n\n## Question To Answer\n\nLabel: ${question.label}\nID: ${question.id}\nPrompt: ${question.prompt}\n\n## Available Choices\n\n${optionsText || "(No predefined choices; recommend a custom answer.)"}\n\nPlease recommend the best answer for this planning question.`,
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		selected.model,
		{ systemPrompt: PLAN_AGENT_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: selected.apiKey, headers: selected.headers, reasoningEffort: "high", signal },
	);

	if (response.stopReason === "aborted") throw new Error("Plan-review agent was aborted");
	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return { text: text || "(Plan-review agent returned no text.)", model: modelLabel(selected.model) };
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
	let savedPlanAbsolutePath: string | undefined;
	let savedPlanRelativePath: string | undefined;
	let savedPlanRoot: string | undefined;
	let pendingEmptyContextPlanPath: string | undefined;
	let contextResetActive = false;
	const PLAN_CONTEXT_RESET_CUSTOM_TYPE = "plan-empty-context-execute";

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only planning and exploration)",
		type: "boolean",
		default: false,
	});

	async function gitRootForPath(path: string, ctx: ExtensionContext): Promise<string | undefined> {
		const result = await pi.exec("git", ["-C", path, "rev-parse", "--show-toplevel"], {
			cwd: ctx.cwd,
			timeout: 5000,
			signal: ctx.signal,
		});
		if (result.code === 0) return result.stdout.trim().split("\n").pop()?.trim() || undefined;
		return undefined;
	}

	async function projectRoot(ctx: ExtensionContext): Promise<string> {
		return (await gitRootForPath(ctx.cwd, ctx)) ?? ctx.cwd;
	}

	async function hasGitMetadata(path: string): Promise<boolean> {
		try {
			await stat(join(path, ".git"));
			return true;
		} catch {
			return false;
		}
	}

	function pathBaseName(path: string): string {
		return path.split(/[\\/]+/).filter(Boolean).pop() ?? path;
	}

	function shouldSkipRepoSearchDir(name: string): boolean {
		return name.startsWith(".") || ["node_modules", "vendor", "dist", "build", "target", "__pycache__"].includes(name);
	}

	async function discoverGitRootsUnder(searchRoot: string, ctx: ExtensionContext, maxDepth = 3): Promise<string[]> {
		const roots = new Set<string>();
		const visited = new Set<string>();

		async function walk(dir: string, depth: number): Promise<void> {
			if (depth >= maxDepth || visited.has(dir)) return;
			visited.add(dir);

			let entries: { name: string; isDirectory(): boolean }[];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}

			for (const entry of entries) {
				if (!entry.isDirectory() || shouldSkipRepoSearchDir(entry.name)) continue;
				const child = join(dir, entry.name);

				if (await hasGitMetadata(child)) {
					const gitRoot = await gitRootForPath(child, ctx);
					if (gitRoot) {
						roots.add(gitRoot);
						continue;
					}
				}

				await walk(child, depth + 1);
			}
		}

		await walk(searchRoot, 0);
		return [...roots];
	}

	function addParentSearchRoot(searchRoots: Set<string>, path: string): void {
		const parent = dirname(path);
		if (parent !== path && parent !== homedir()) searchRoots.add(parent);
	}

	async function discoverPlanRootCandidates(ctx: ExtensionContext, defaultRoot: string): Promise<string[]> {
		const candidates = new Set<string>([defaultRoot]);
		const searchRoots = new Set<string>([defaultRoot, ctx.cwd]);
		addParentSearchRoot(searchRoots, defaultRoot);
		addParentSearchRoot(searchRoots, ctx.cwd);

		const cwdRoot = await gitRootForPath(ctx.cwd, ctx);
		if (cwdRoot) candidates.add(cwdRoot);

		for (const searchRoot of searchRoots) {
			for (const root of await discoverGitRootsUnder(searchRoot, ctx)) candidates.add(root);
		}

		return [...candidates];
	}

	function scorePlanRootCandidate(root: string, plan: string): number {
		const base = pathBaseName(root).toLowerCase();
		if (base.length < 3) return 0;

		const normalizedPlan = plan.toLowerCase();
		let score = 0;
		if (normalizedPlan.includes(`/${base}`)) score += 120;
		if (normalizedPlan.includes(` ${base}`)) score += 80;
		if (normalizedPlan.includes(`\`${base}\``)) score += 100;
		if (new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(plan)) score += 60;
		return score;
	}

	function planRootOptionLabel(root: string, defaultRoot: string, detectedRoot: string | undefined, score: number): string {
		const display = `${pathBaseName(root)} — ${root}`;
		if (root === detectedRoot && score > 0 && root === defaultRoot) return `Use current project root (matched plan): ${display}`;
		if (root === detectedRoot && score > 0) return `Use best matched repo: ${display}`;
		if (root === defaultRoot) return `Use current project root: ${display}`;
		if (score > 0) return `Use matched repo: ${display}`;
		return `Use repo: ${display}`;
	}

	async function choosePlanRoot(ctx: ExtensionContext, defaultRoot: string): Promise<string> {
		const candidates = await discoverPlanRootCandidates(ctx, defaultRoot);
		const scored = candidates
			.map((root) => ({ root, score: scorePlanRootCandidate(root, lastProposedPlan) }))
			.sort((a, b) => b.score - a.score || a.root.localeCompare(b.root));
		const detected = scored.find((candidate) => candidate.score >= PLAN_ROOT_SCORE_THRESHOLD);

		if (!ctx.hasUI) return detected?.root ?? defaultRoot;

		const sortedForUi = scored
			.filter((candidate) => candidate.root === defaultRoot || candidate.score >= PLAN_ROOT_SCORE_THRESHOLD)
			.sort((a, b) => {
				const rank = (candidate: { root: string; score: number }) =>
					candidate.root === detected?.root && candidate.score >= PLAN_ROOT_SCORE_THRESHOLD ? 0 : candidate.root === defaultRoot ? 1 : 2;
				const rankDiff = rank(a) - rank(b);
				if (rankDiff !== 0) return rankDiff;
				return b.score - a.score || pathBaseName(a.root).localeCompare(pathBaseName(b.root)) || a.root.localeCompare(b.root);
			});

		if (!sortedForUi.some((candidate) => candidate.root === defaultRoot)) {
			sortedForUi.push({ root: defaultRoot, score: 0 });
		}

		const limitedForUi = sortedForUi.slice(0, MAX_PLAN_ROOT_CHOICES);
		if (limitedForUi.length <= 1) return defaultRoot;

		const hiddenCount = sortedForUi.length - limitedForUi.length;
		if (hiddenCount > 0) {
			ctx.ui.notify(`Plan save repo picker narrowed to ${limitedForUi.length} likely choices; ${hiddenCount} lower-ranked matches hidden.`, "info");
		}

		const labels: string[] = [];
		const rootsByLabel = new Map<string, string>();
		for (const candidate of limitedForUi) {
			const label = planRootOptionLabel(candidate.root, defaultRoot, detected?.root, candidate.score);
			labels.push(label);
			rootsByLabel.set(label, candidate.root);
		}
		labels.push("Cancel execution");

		const choice = await ctx.ui.select("Save accepted plan under which project?", labels);
		const selectedRoot = choice ? rootsByLabel.get(choice) : undefined;
		if (selectedRoot) return selectedRoot;
		throw new Error("Plan execution cancelled before saving because no project root was selected.");
	}

	async function savePlanForExecution(ctx: ExtensionContext): Promise<string> {
		if (!lastProposedPlan.trim()) throw new Error("No proposed plan is available to save.");

		const defaultRoot = await projectRoot(ctx);
		const root = await choosePlanRoot(ctx, defaultRoot);
		const plansDir = join(root, "docs", "plans");
		await mkdir(plansDir, { recursive: true });

		const title = planTitle(lastProposedPlan);
		const filename = `${timestampForFilename()}-${slugifyPlanTitle(title)}.md`;
		const absolutePath = join(plansDir, filename);
		await writeFile(absolutePath, upsertPlanProgressSection(buildSavedPlanMarkdown(lastProposedPlan), todoItems), "utf8");

		const relativePath = relative(root, absolutePath) || absolutePath;
		const displayPath = relative(ctx.cwd, absolutePath) || absolutePath;
		savedPlanAbsolutePath = absolutePath;
		savedPlanRelativePath = relativePath;
		savedPlanRoot = root;
		pi.appendEntry("plan-mode-saved-plan", {
			path: absolutePath,
			relativePath,
			root,
			title,
			savedAt: new Date().toISOString(),
		});
		return displayPath;
	}

	async function updateSavedPlanProgress(ctx: ExtensionContext): Promise<void> {
		if (!savedPlanAbsolutePath || todoItems.length === 0) return;
		try {
			const existing = await readFile(savedPlanAbsolutePath, "utf8");
			await writeFile(savedPlanAbsolutePath, upsertPlanProgressSection(existing, todoItems), "utf8");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not update saved plan progress in ${savedPlanRelativePath ?? savedPlanAbsolutePath}: ${message}`, "warning");
		}
	}

	function buildPlanOnlyExecutionPrompt(savedPlanPath: string): string {
		const firstStep = todoItems[0]?.text ?? "the first implementation step";
		return `Implement the plan saved at ${savedPlanPath}.

<proposed_plan>
${lastProposedPlan}
</proposed_plan>

Start with step 1: ${firstStep}`;
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
			const planAgentModelOptions = await getPlanAgentModelOptions(ctx);
			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1;

			const result = await ctx.ui.custom<PlanQuestionsResult>((tui, theme, _kb, done) => {
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let modelSelectMode = false;
				let modelSelectQuestionId: string | null = null;
				let modelSelectIndex = 0;
				let agentReviewMode = false;
				let agentReviewRunning = false;
				let agentReviewQuestionId: string | null = null;
				let agentReviewText = "";
				let agentReviewModel = "";
				let agentReviewError = "";
				let agentReviewAbort: AbortController | null = null;
				let cachedLines: string[] | undefined;
				let cachedWidth: number | undefined;
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
					cachedWidth = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean): void {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion(): PlanQuestion | undefined {
					return questions[currentTab];
				}

				function currentOptions(): Array<PlanQuestionOption & { isOther?: boolean; isAgent?: boolean }> {
					const q = currentQuestion();
					if (!q) return [];
					const opts: Array<PlanQuestionOption & { isOther?: boolean; isAgent?: boolean }> = [...q.options];
					if (q.allowOther) {
						opts.push({
							value: "__agent__",
							label: "Ask an agent for a recommendation",
							description: "Lets you choose one of Pi's scoped models and forwards the current planning context.",
							isAgent: true,
						});
						opts.push({ value: "__other__", label: "Type a custom answer", isOther: true });
					}
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

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number, source?: "agent" | "user"): void {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index, source });
				}

				editor.onSubmit = (value: string) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim() || "(no response)";
					saveAnswer(inputQuestionId, trimmed, trimmed, true, undefined, "user");
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function startAgentReview(question: PlanQuestion, modelOption: PlanAgentModelOption): void {
					if (agentReviewRunning) return;
					agentReviewMode = true;
					agentReviewRunning = true;
					agentReviewQuestionId = question.id;
					agentReviewText = "";
					agentReviewModel = "";
					agentReviewError = "";
					agentReviewAbort = new AbortController();
					refresh();

					askPlanAgentForAnswer(ctx, question, questions, answers, lastProposedPlan, modelOption, agentReviewAbort.signal)
						.then((result) => {
							agentReviewRunning = false;
							agentReviewText = result.text;
							agentReviewModel = result.model;
							refresh();
						})
						.catch((error) => {
							agentReviewRunning = false;
							agentReviewError = error instanceof Error ? error.message : String(error);
							refresh();
						});
				}

				function handleInput(data: string): void {
					if (modelSelectMode) {
						if (matchesKey(data, Key.up)) {
							modelSelectIndex = Math.max(0, modelSelectIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							modelSelectIndex = Math.min(planAgentModelOptions.length - 1, modelSelectIndex + 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.enter) && modelSelectQuestionId && planAgentModelOptions.length > 0) {
							const question = questions.find((candidate) => candidate.id === modelSelectQuestionId);
							const modelOption = planAgentModelOptions[modelSelectIndex];
							modelSelectMode = false;
							modelSelectQuestionId = null;
							if (question && modelOption) startAgentReview(question, modelOption);
							return;
						}
						if (matchesKey(data, Key.escape)) {
							modelSelectMode = false;
							modelSelectQuestionId = null;
							refresh();
						}
						return;
					}

					if (agentReviewMode) {
						if (agentReviewRunning) {
							if (matchesKey(data, Key.escape)) {
								agentReviewAbort?.abort();
								agentReviewRunning = false;
								agentReviewMode = false;
								agentReviewQuestionId = null;
								refresh();
							}
							return;
						}

						if (matchesKey(data, Key.enter) && agentReviewText.trim() && agentReviewQuestionId) {
							const answer = agentReviewText.trim();
							saveAnswer(agentReviewQuestionId, answer, answer, true, undefined, "agent");
							agentReviewMode = false;
							agentReviewQuestionId = null;
							advanceAfterAnswer();
							return;
						}

						if ((data === "e" || data === "E") && agentReviewText.trim() && agentReviewQuestionId) {
							inputMode = true;
							inputQuestionId = agentReviewQuestionId;
							editor.setText(agentReviewText.trim());
							agentReviewMode = false;
							agentReviewQuestionId = null;
							refresh();
							return;
						}

						if (matchesKey(data, Key.escape)) {
							agentReviewMode = false;
							agentReviewQuestionId = null;
							refresh();
						}
						return;
					}

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
						if (opt.isAgent) {
							modelSelectMode = true;
							modelSelectQuestionId = q.id;
							modelSelectIndex = 0;
							refresh();
							return;
						}
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
					if (cachedLines && cachedWidth === width) return cachedLines;
					const lines: string[] = [];
					const renderWidth = Math.max(1, width);
					const q = currentQuestion();
					const opts = currentOptions();

					function addWrapped(text: string): void {
						const wrapped = wrapTextWithAnsi(text, renderWidth);
						if (wrapped.length === 0) lines.push("");
						else lines.push(...wrapped);
					}

					function addWrappedWithPrefix(prefix: string, text: string, continuationPrefix = " ".repeat(visibleWidth(prefix))): void {
						const prefixWidth = visibleWidth(prefix);
						const continuationWidth = visibleWidth(continuationPrefix);
						const reservedWidth = Math.max(prefixWidth, continuationWidth);
						if (reservedWidth >= renderWidth) {
							addWrapped(prefix + text);
							return;
						}

						const wrapped = wrapTextWithAnsi(text, renderWidth - reservedWidth);
						if (wrapped.length === 0) {
							lines.push(truncateToWidth(prefix, renderWidth, ""));
							return;
						}

						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

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
						addWrappedWithPrefix(" ", `${tabs.join(" ")} →`);
						lines.push("");
					}

					function renderOptions(): void {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const chosen = q ? answers.get(q.id)?.value === opt.value : false;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const marker = chosen ? theme.fg("success", "✓ ") : theme.fg(selected ? "accent" : "text", `${i + 1}. `);
							const label = theme.fg(selected ? "accent" : "text", opt.label);
							const continuationPrefix = " ".repeat(visibleWidth(prefix) + visibleWidth(marker));
							addWrappedWithPrefix(prefix + marker, label, continuationPrefix);
							if (opt.description) addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
						}
					}

					function addMultiline(text: string, color: "text" | "muted" | "warning" | "error" | "success" = "text"): void {
						for (const line of text.split("\n")) {
							if (line.length === 0) lines.push("");
							else addWrappedWithPrefix(" ", theme.fg(color, line));
						}
					}

					if (modelSelectMode && q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("accent", "Choose a scoped model for the plan-review agent:"));
						lines.push("");
						if (planAgentModelOptions.length === 0) {
							addWrappedWithPrefix(" ", theme.fg("warning", "No authenticated scoped models found."));
							addWrappedWithPrefix(" ", theme.fg("muted", "Configure enabledModels in ~/.pi/agent/settings.json or .pi/settings.json."));
						} else {
							for (let i = 0; i < planAgentModelOptions.length; i++) {
								const option = planAgentModelOptions[i];
								const selected = i === modelSelectIndex;
								const prefix = selected ? theme.fg("accent", "> ") : "  ";
								const marker = theme.fg(selected ? "accent" : "text", `${i + 1}. `);
								const label = theme.fg(selected ? "accent" : "text", option.label);
								const continuationPrefix = " ".repeat(visibleWidth(prefix) + visibleWidth(marker));
								addWrappedWithPrefix(prefix + marker, label, continuationPrefix);
								if (option.description) addWrappedWithPrefix("     ", theme.fg("muted", option.description));
							}
						}
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("dim", planAgentModelOptions.length > 0 ? "↑↓ select • Enter ask agent • Esc back" : "Esc back"));
					} else if (agentReviewMode && q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						lines.push("");
						if (agentReviewRunning) {
							addWrappedWithPrefix(" ", theme.fg("accent", "Asking the selected plan-review model..."));
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("dim", "Forwarding the current planning conversation and any draft/proposed plan."));
							addWrappedWithPrefix(" ", theme.fg("dim", "Esc cancels"));
						} else if (agentReviewError) {
							addWrappedWithPrefix(" ", theme.fg("error", "Agent review failed:"));
							addMultiline(agentReviewError, "error");
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("dim", "Esc back"));
						} else {
							addWrappedWithPrefix(" ", theme.fg("accent", `Agent recommendation${agentReviewModel ? ` (${agentReviewModel})` : ""}:`));
							lines.push("");
							addMultiline(agentReviewText || "(empty response)");
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("dim", "Enter use as answer • E edit before using • Esc back"));
						}
					} else if (inputMode && q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						lines.push("");
						renderOptions();
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
						for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("dim", "Enter to save • Esc back"));
					} else if (currentTab === questions.length) {
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Review answers")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							const prefix = theme.fg("muted", ` ${question.label}: `);
							const text = answer ? theme.fg("text", answer.label) : theme.fg("warning", "unanswered");
							addWrappedWithPrefix(prefix, text);
						}
						lines.push("");
						addWrappedWithPrefix(" ", allAnswered() ? theme.fg("success", "Press Enter to submit") : theme.fg("warning", "Tab back to answer missing questions"));
					} else if (q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						lines.push("");
						renderOptions();
					}

					lines.push("");
					if (!inputMode && !agentReviewMode && !modelSelectMode) {
						addWrappedWithPrefix(" ", theme.fg("dim", isMulti ? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel" : "↑↓ select • Enter confirm • Esc cancel"));
					}
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					cachedLines = lines;
					cachedWidth = width;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
						cachedWidth = undefined;
					},
					handleInput,
				};
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
				if (answer.source === "agent") return `${prefix}: agent recommended: ${answer.label}`;
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
					.map((a) => {
						const source = a.source === "agent" ? "(agent) " : a.wasCustom ? "(wrote) " : "";
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${source ? theme.fg("muted", source) : ""}${a.label}`;
					})
					.join("\n"),
				0,
				0,
			);
		},
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const closed = todoItems.filter((t: TodoItem) => isTodoClosed(t)).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${closed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item: TodoItem) => {
				const status = item.status ?? (item.completed ? "done" : "pending");
				if (isTodoDone(item)) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				if (status === "skipped") return `${ctx.ui.theme.fg("muted", "⊘ ")}${ctx.ui.theme.strikethrough(item.text)}`;
				if (status === "deferred") return `${ctx.ui.theme.fg("warning", "↷ ")}${item.text}`;
				if (status === "blocked") return `${ctx.ui.theme.fg("error", "⚠ ")}${item.text}`;
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	async function finishPlanExecutionIfComplete(ctx: ExtensionContext): Promise<boolean> {
		if (!executionMode || todoItems.length === 0 || !todoItems.every((todo: TodoItem) => isTodoClosed(todo))) {
			return false;
		}

		await updateSavedPlanProgress(ctx);
		const completedList = todoItems
			.map((todo: TodoItem) => `${isTodoDone(todo) ? "✓" : "↷"} ${todo.text} (${todo.status ?? (todo.completed ? "done" : "pending")})`)
			.join("\n");
		pi.sendMessage(
			{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
			{ triggerTurn: false },
		);
		executionMode = false;
		contextResetActive = false;
		todoItems = [];
		restoreSavedTools();
		updateStatus(ctx);
		persistState();
		return true;
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
		if (executionMode) {
			ctx.ui.notify(
				"Plan execution is already active. /plan will not re-enter planning or replace the current todo tracker. Use /todos to view progress, /todos done 1-3 to update it, or /plan cancel to stop tracking.",
				"warning",
			);
			updateStatus(ctx);
			return;
		}

		planModeEnabled = !planModeEnabled;

		if (planModeEnabled) {
			// Save current tools and filter out edit/write. pi.getActiveTools() returns tool names.
			const currentTools = currentActiveToolNames();
			savedTools = (currentTools.length > 0 ? currentTools : defaultNormalTools()).filter(
				(name: string) => name !== PLAN_QUESTIONS_TOOL,
			);
			pi.setActiveTools(planModeToolNames(savedTools));
			lastProposedPlan = "";
			todoItems = [];
			contextResetActive = false;
			ctx.ui.notify(`Plan mode enabled. Mutating tools (edit/write) disabled.`);
		} else {
			contextResetActive = false;
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
			savedPlanAbsolutePath,
			savedPlanRelativePath,
			savedPlanRoot,
			contextResetActive,
		});
	}

	function sameTodoTexts(a: TodoItem[], b: TodoItem[]): boolean {
		return a.length === b.length && a.every((item, index) => item.text.toLowerCase() === b[index]?.text.toLowerCase());
	}

	function normalizeTodoTextForMigration(text: string): string {
		return text
			.toLowerCase()
			.replace(/\.\.\.$/, "")
			.replace(/[^a-z0-9]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	function findPreviousTodoForReparsed(item: TodoItem, previousItems: TodoItem[], sameLength: boolean): TodoItem | undefined {
		const normalized = normalizeTodoTextForMigration(item.text);
		const exact = previousItems.find((todo: TodoItem) => normalizeTodoTextForMigration(todo.text) === normalized);
		if (exact) return exact;
		const prefix = previousItems.find((todo: TodoItem) => {
			const previous = normalizeTodoTextForMigration(todo.text);
			return previous.length >= 20 && normalized.startsWith(previous);
		});
		if (prefix) return prefix;
		return sameLength ? previousItems.find((todo: TodoItem) => todo.step === item.step) : undefined;
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
		description: "Toggle plan mode (read-only exploration & planning). Use /plan cancel to stop execution tracking.",
		handler: async (args: any, ctx: ExtensionContext) => {
			const command = String(args ?? "").trim();
			if (/^(cancel|stop|clear|reset)\b/i.test(command)) {
				planModeEnabled = false;
				executionMode = false;
				contextResetActive = false;
				todoItems = [];
				restoreSavedTools();
				persistState();
				updateStatus(ctx);
				ctx.ui.notify("Plan execution tracking cancelled. Full access restored.", "info");
				return;
			}
			togglePlanMode(ctx);
		},
	});

	pi.registerCommand("todos", {
		description: "Show or update current plan todo list. Usage: /todos, /todos done|skip|defer|block|open 1-3, /todos reset",
		handler: async (args: any, ctx: ExtensionContext) => {
			const command = String(args ?? "").trim();
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}

			const stateMatch = command.match(/^(done|mark|complete|skip|skipped|defer|deferred|block|blocked|open|reopen|pending)\b/i);
			if (stateMatch) {
				const verb = stateMatch[1].toLowerCase();
				const status: TodoStatus = /^(done|mark|complete)$/.test(verb)
					? "done"
					: /^skip/.test(verb)
						? "skipped"
						: /^defer/.test(verb)
							? "deferred"
							: /^block/.test(verb)
								? "blocked"
								: "pending";
				const steps = parseStepSpec(command.slice(stateMatch[0].length));
				let changed = 0;
				for (const step of steps) {
					const item = todoItems.find((todo: TodoItem) => todo.step === step);
					if (item && (item.status ?? (item.completed ? "done" : "pending")) !== status) {
						setTodoStatus(item, status);
						changed++;
					}
				}
				persistState();
				const completedPlan = await finishPlanExecutionIfComplete(ctx);
				if (!completedPlan) {
					await updateSavedPlanProgress(ctx);
					updateStatus(ctx);
				}
				ctx.ui.notify(changed > 0 ? `Marked ${changed} step(s) ${status}.` : "No matching steps changed.", "info");
				return;
			}

			if (/^reset\b/i.test(command)) {
				for (const item of todoItems) setTodoStatus(item, "pending");
				persistState();
				await updateSavedPlanProgress(ctx);
				updateStatus(ctx);
				ctx.ui.notify("Reset plan progress.", "info");
				return;
			}

			ctx.ui.notify(`Plan Progress:\n${renderPlanProgressMarkdown(todoItems)}`, "info");
		},
	});

	pi.registerCommand("plan-start-empty-context", {
		description: "Advanced: start implementing the accepted plan in a fresh session with only the plan as context",
		handler: async (_args: any, ctx: ExtensionCommandContext) => {
			let savedPlanPath = pendingEmptyContextPlanPath ?? savedPlanRelativePath ?? savedPlanAbsolutePath;
			pendingEmptyContextPlanPath = undefined;

			if (!lastProposedPlan.trim() || todoItems.length === 0) {
				ctx.ui.notify("No accepted plan is available. Propose and accept a plan first.", "error");
				return;
			}

			if (!savedPlanPath) {
				try {
					savedPlanPath = await savePlanForExecution(ctx);
					ctx.ui.notify(`Saved accepted plan to ${savedPlanPath}`, "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not save the accepted plan; fresh-session start cancelled.\n${message}`, "error");
					return;
				}
			}

			const planOnlyPrompt = buildPlanOnlyExecutionPrompt(savedPlanPath);
			const executionTodos = todoItems.map((item) => ({ ...item }));

			const result = await ctx.newSession({
				parentSession: ctx.sessionManager.getSessionFile(),
				setup: async (sm) => {
					// Persist plan-mode state so the new session shows the todo widget and tracks progress.
					// The actual user prompt is sent in withSession so it triggers the first implementation turn.
					sm.appendCustomEntry("plan-mode", {
						enabled: false,
						todos: executionTodos,
						executing: true,
						lastProposedPlan,
						savedTools,
						savedPlanAbsolutePath,
						savedPlanRelativePath,
						savedPlanRoot,
						contextResetActive: false,
					});
				},
				withSession: async (newCtx) => {
					newCtx.ui.notify("Started implementation in a fresh session with the plan only.", "info");
					await newCtx.sendUserMessage(planOnlyPrompt);
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("New session was cancelled. Plan remains in the current session.", "warning");
			}
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

	// Filter context for Plan Mode bookkeeping and optional reset-context execution.
	pi.on("context", async (event: any) => {
		let messages = [...event.messages];

		if (contextResetActive) {
			let resetIndex = -1;
			for (let i = messages.length - 1; i >= 0; i--) {
				if ((messages[i] as AgentMessage & { customType?: string }).customType === PLAN_CONTEXT_RESET_CUSTOM_TYPE) {
					resetIndex = i;
					break;
				}
			}
			if (resetIndex >= 0) messages = messages.slice(resetIndex);
		}

		if (!planModeEnabled) {
			messages = messages.filter((m: any) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context" || msg.customType === "plan-refinement-context") {
					return false;
				}
				if (msg.customType === "plan-execution-context" && !executionMode) {
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
			});
		}

		return { messages };
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
* Read-only Git and GitHub CLI queries such as \`git status\`, \`git log\`, \`git diff\`, \`gh pr view\`, and \`gh issue list\`
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
			const remaining = todoItems.filter((t: TodoItem) => isTodoOpen(t));
			const todoList = remaining.map((t: TodoItem) => `${t.step}. ${t.text}`).join("\n");
			const allSteps = todoItems.map((t: TodoItem) => `Step ${t.step}: ${t.text} (${t.status ?? (t.completed ? "done" : "pending")})`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

All steps for reference:
${allSteps}

**IMPORTANT**: As you complete each step, you MUST mark it done by including a [DONE:n] tag in your response (e.g. [DONE:1] for step 1, [DONE:5] for step 5). Place the tag right after the section that completes the step, or end your response with a concise status line like \`Completed steps: 1-3\`. Multiple [DONE:n] tags can be included in one response if you complete multiple steps.

If the user explicitly skips or defers a step, run \`/todos skip <n>\` or \`/todos defer <n>\` instead of claiming it is done. If a step is blocked, run \`/todos block <n>\` and explain the blocker.

Before saying a PR is ready, clean, or ready for human review, check both CI and review state. For GitHub PR work, inspect normal comments and inline review comments/threads (for example with \`gh pr checks\`, \`gh pr view --comments\`, \`gh api repos/:owner/:repo/pulls/:number/comments\`, and GraphQL review thread queries where needed). Resolve or respond to actionable automated-review comments before handoff.

If you only partially complete the plan, include exactly which step numbers are now complete, skipped, deferred, or blocked. Do not omit this even if you also provide a prose summary. Without these tags or \`/todos\` updates, the progress tracker may not update.`,
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
		if (markExplicitNonDoneSteps(text, todoItems) + markCompletedSteps(text, todoItems) > 0) {
			await updateSavedPlanProgress(ctx);
			updateStatus(ctx);
		}
		if (hasHandoffClaim(text)) {
			const open = todoItems.filter((item: TodoItem) => isTodoOpen(item));
			if (open.length > 0) {
				pi.sendMessage(
					{
						customType: "plan-handoff-warning",
						content: `⚠️ **Plan handoff warning:** this response sounds like a handoff, but ${open.length} plan item(s) are still open. Mark them done, skipped, deferred, or blocked with \`/todos done|skip|defer|block <n>\` before handing off.\n\n${open.map((item) => `${item.step}. ${item.text}`).join("\n")}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			}
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event: any, ctx: ExtensionContext) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			await finishPlanExecutionIfComplete(ctx);
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
		if (hasNewPlan && todoItems.length === 0) {
			pi.sendMessage(
				{
					customType: "plan-format-warning",
					content:
						"⚠️ **Plan format warning:** found a `<proposed_plan>` block, but could not find a dedicated `## Implementation Steps`, `## Execution Steps`, or `## Action Plan` section with tracker-level items. Ask for a revised plan with only executable work items in that section; requirements, checks, tests, and rollout details should stay in separate sections.",
					display: true,
				},
				{ triggerTurn: false },
			);
			ctx.ui.notify("Proposed plan needs a dedicated implementation/action steps section before execution can start.", "warning");
			updateStatus(ctx);
			return;
		}

		if (hasNewPlan && todoItems.length > 0) {
			const todoListText = todoItems.map((t: TodoItem, i: number) => `${i + 1}. ☐ ${t.text}`).join("\n");
			const title = planTitle(lastProposedPlan);
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content: `**Tracked Implementation Steps (${todoItems.length}) — ${title}:**\n\n${todoListText}\n\n_This replaces any earlier proposed implementation-step list in this session._`,
					display: true,
				},
				{ triggerTurn: false },
			);

			const choice = await ctx.ui.select("Plan proposed - what next?", [
				"Start Implementation in current session",
				"Start Implementation with reset model context",
				"Refine the plan (provide feedback)",
				"Stay in plan mode",
			]);

			if (choice?.startsWith("Start Implementation with reset model context")) {
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
				contextResetActive = true;
				restoreSavedTools();
				updateStatus(ctx);
				persistState();

				const planOnlyPrompt = `[PLAN CONTEXT RESET]\n\n${buildPlanOnlyExecutionPrompt(savedPlanPath)}\n\nThe model context for this execution turn is intentionally reset to this marker plus later messages; previous planning conversation is excluded by the Plan Mode extension.`;
				pi.sendMessage(
					{ customType: PLAN_CONTEXT_RESET_CUSTOM_TYPE, content: planOnlyPrompt, display: true },
					{ triggerTurn: true },
				);
				ctx.ui.notify("Started implementation with reset model context. The old transcript remains visible, but is excluded from model context from this marker onward.", "info");
				return;
			}

			if (choice?.startsWith("Start Implementation in current session")) {
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
				contextResetActive = false;
				restoreSavedTools();
				updateStatus(ctx);
				persistState();

				const execMessage = `Execute the plan saved at ${savedPlanPath}. Start with: ${todoItems[0].text}`;
				pi.sendMessage(
					{ customType: "plan-mode-execute", content: execMessage, display: true },
					{ triggerTurn: true },
				);
				ctx.ui.notify("Started implementation in the current session. Use /todos to view or repair progress.", "info");
			} else if (choice?.startsWith("Refine the plan")) {
				const refinement = await ctx.ui.editor("Provide feedback to refine the plan:", "");
				if (refinement?.trim()) {
					// agent_end is still inside Pi's active processing window; queue the refinement until idle.
					pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
				}
			} else {
				ctx.ui.notify("Plan accepted UI dismissed; staying in Plan Mode with the proposed plan available for refinement.", "info");
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
						savedPlanAbsolutePath?: string;
						savedPlanRelativePath?: string;
						savedPlanRoot?: string;
						contextResetActive?: boolean;
					};
			  }
			| undefined;

		let restoredPlanProgressNeedsWrite = false;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			lastProposedPlan = planModeEntry.data.lastProposedPlan ?? lastProposedPlan;
			savedTools = existingToolNames(normalizeToolNames(planModeEntry.data.savedTools ?? savedTools)).filter(
				(name: string) => name !== PLAN_QUESTIONS_TOOL,
			);
			savedPlanAbsolutePath = planModeEntry.data.savedPlanAbsolutePath ?? savedPlanAbsolutePath;
			savedPlanRelativePath = planModeEntry.data.savedPlanRelativePath ?? savedPlanRelativePath;
			savedPlanRoot = planModeEntry.data.savedPlanRoot ?? savedPlanRoot;
			contextResetActive = planModeEntry.data.contextResetActive ?? contextResetActive;

			// Migrate older sessions whose todos were over-extracted from every list item.
			// Re-parse the stored proposed plan with the current robust extractor, preserving
			// completion flags by matching step text where possible.
			if (lastProposedPlan) {
				const reparsedTodos = extractTodoItemsFromProposedPlan(lastProposedPlan);
				if (reparsedTodos.length > 0 && !sameTodoTexts(todoItems, reparsedTodos)) {
					const previousItems = todoItems;
					const sameLength = previousItems.length === reparsedTodos.length;
					for (const item of reparsedTodos) {
						const previous = findPreviousTodoForReparsed(item, previousItems, sameLength);
						setTodoStatus(item, previous?.status ?? (previous?.completed ? "done" : "pending"));
					}
					todoItems = reparsedTodos;
					restoredPlanProgressNeedsWrite = true;
					persistState();
				} else if (reparsedTodos.length === 0 && todoItems.length > 0) {
					// Current extraction rules reject structured plans that lack a dedicated
					// implementation/action steps section. Clear stale trackers created by
					// older broad fallback extraction rather than continuing bogus execution.
					todoItems = [];
					executionMode = false;
					contextResetActive = false;
					persistState();
					ctx.ui.notify(
						"Cleared stale plan todos: the saved proposed plan has no dedicated implementation/action steps section.",
						"warning",
					);
				}
			}
		}

		// Rebuild execution completed state on resume
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute" || entry.customType === PLAN_CONTEXT_RESET_CUSTOM_TYPE) {
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
			if (markExplicitNonDoneSteps(allText, todoItems) + markCompletedSteps(allText, todoItems) > 0) {
				restoredPlanProgressNeedsWrite = true;
				persistState();
			}
		}

		if (executionMode && todoItems.length > 0 && todoItems.every((todo: TodoItem) => isTodoClosed(todo))) {
			executionMode = false;
			contextResetActive = false;
			todoItems = [];
			persistState();
		}
		if (!executionMode) contextResetActive = false;

		if (planModeEnabled) {
			const currentActive = currentActiveToolNames();
			const toolsToFilter = currentActive.length > 0 ? currentActive : savedTools.length > 0 ? savedTools : defaultNormalTools();
			pi.setActiveTools(planModeToolNames(toolsToFilter));
		} else if (planModeEntry?.data) {
			restoreSavedTools();
		}
		if (restoredPlanProgressNeedsWrite) await updateSavedPlanProgress(ctx);
		updateStatus(ctx);
	});
}
