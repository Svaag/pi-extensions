/**
 * Plan Mode Extension
 *
 * Safe read-only planning and code analysis mode based exactly on OpenAI Codex and Claude Code.
 * Restricted to non-mutating actions until explicitly finalized.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, StringEnum, type AssistantMessage, type Message, type TextContent } from "@earendil-works/pi-ai";
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
import { dirname, isAbsolute, join, relative } from "node:path";
import { Type } from "typebox";
import {
	extractProposedPlan,
	extractTodoItemsFromProposedPlan,
	hasHandoffClaim,
	isSafeCommand,
	isTodoClosed,
	isTodoDone,
	isTodoOpen,
	renderPlanProgressMarkdown,
	shouldUsePlanRefinementContext,
	setTodoStatus,
	upsertPlanProgressSection,
	type TodoItem,
	type TodoStatus,
} from "./utils.js";

const DEFAULT_NORMAL_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_QUESTIONS_TOOL = "plan_questions";
const UPDATE_PLAN_TOOL = "update_plan";
const PLAN_REPO_OVERVIEW_TOOL = "plan_repo_overview";
const PLAN_FILES_TOOL = "plan_files";
const PLAN_SEARCH_TOOL = "plan_search";
const PLAN_READ_MANY_TOOL = "plan_read_many";
const PLAN_EXPLORATION_TOOLS = [PLAN_REPO_OVERVIEW_TOOL, PLAN_FILES_TOOL, PLAN_SEARCH_TOOL, PLAN_READ_MANY_TOOL];
const REQUIRED_PLAN_TOOLS = ["read", "bash", PLAN_QUESTIONS_TOOL, ...PLAN_EXPLORATION_TOOLS];
const PLAN_MODE_OWNED_TOOLS = new Set([PLAN_QUESTIONS_TOOL, UPDATE_PLAN_TOOL, ...PLAN_EXPLORATION_TOOLS]);
const MUTATING_TOOLS_IN_PLAN_MODE = new Set(["edit", "write"]);
const PLAN_MODE_THINKING_LEVEL = "xhigh";
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

type UpdatePlanToolStatus = "pending" | "in_progress" | "completed" | "skipped" | "deferred" | "blocked";

interface UpdatePlanToolItem {
	step: string;
	status: UpdatePlanToolStatus;
}

interface UpdatePlanToolResult {
	explanation?: string;
	todos: TodoItem[];
	closed: number;
	total: number;
	currentStep?: string;
}

const UpdatePlanItemSchema = Type.Object({
	step: Type.String({ description: "Task step text" }),
	status: StringEnum(["pending", "in_progress", "completed", "skipped", "deferred", "blocked"] as const, {
		description: "Step status",
	}),
});

const UpdatePlanParams = Type.Object({
	explanation: Type.Optional(Type.String({ description: "Optional short explanation for why the plan changed" })),
	plan: Type.Array(UpdatePlanItemSchema, { description: "The full current ordered plan" }),
});

const PlanRepoOverviewParams = Type.Object({
	maxFiles: Type.Optional(Type.Number({ description: "Maximum number of sample tracked files to include (default 80, max 200)" })),
});

const PlanFilesParams = Type.Object({
	pattern: Type.Optional(Type.String({ description: "Optional substring or glob-like pattern to filter paths" })),
	maxResults: Type.Optional(Type.Number({ description: "Maximum paths to return (default 200, max 1000)" })),
});

const PlanSearchParams = Type.Object({
	query: Type.String({ description: "Search query or regular expression" }),
	regex: Type.Optional(Type.Boolean({ description: "Treat query as a regex. Defaults to false, which searches literal text." })),
	paths: Type.Optional(Type.Array(Type.String(), { description: "Optional relative paths/directories to search" })),
	maxResults: Type.Optional(Type.Number({ description: "Maximum matches to return (default 80, max 300)" })),
});

const PlanReadManyFileSchema = Type.Object({
	path: Type.String({ description: "File path to read" }),
	offset: Type.Optional(Type.Number({ description: "1-indexed line number to start reading" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const PlanReadManyParams = Type.Object({
	files: Type.Array(PlanReadManyFileSchema, { description: "Files to read in one batch (max 12)" }),
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

const PLAN_MODE_SYSTEM_OVERLAY = `Pi Plan Mode is active as a strict developer-level mode.
- Highest reasoning effort is selected for this mode by default.
- Planning may use read-only exploration tools: read, bash, plan_repo_overview, plan_files, plan_search, plan_read_many, and plan_questions.
- Use plan_repo_overview, plan_files, plan_search, plan_read_many, or read-only bash (rg/fd/find/git grep/git ls-files/git status/git diff/git log/etc.) to inspect the repo before asking user questions that can be answered from files.
- Do not claim grep/find/search are unavailable; use the Plan Mode exploration tools or read-only bash.
- Do not edit, write, apply patches, run fixers/formatters, or intentionally mutate repo-tracked files while in Plan Mode.
- Only use plan_questions for implementation-detail decisions that cannot be resolved through non-mutating exploration.
- Final plans must be wrapped in exactly one <proposed_plan> block and include dedicated tracker-level Implementation/Execution/Action steps.`;

function withPlanModeSystemPrompt(event: any, suffix = ""): string {
	const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
	return `${base}\n\n${PLAN_MODE_SYSTEM_OVERLAY}${suffix ? `\n\n${suffix}` : ""}`;
}

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
	let savedThinkingLevel: string | undefined;
	let savedPlanAbsolutePath: string | undefined;
	let savedPlanRelativePath: string | undefined;
	let savedPlanRoot: string | undefined;
	let pendingEmptyContextPlanPath: string | undefined;
	let contextResetActive = false;
	const planModeBashSnapshots = new Map<string, { root: string; status: string }>();
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

	function clampInt(value: unknown, fallback: number, min: number, max: number): number {
		const numberValue = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
		return Math.max(min, Math.min(max, numberValue));
	}

	function isPlanOwnedTool(name: string): boolean {
		return PLAN_MODE_OWNED_TOOLS.has(name);
	}

	function planToolResult(text: string, details: Record<string, unknown> = {}) {
		return { content: [{ type: "text" as const, text }], details };
	}

	function shouldSkipRepoWalkDir(name: string): boolean {
		return [".git", "node_modules", "vendor", "dist", "build", "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"].includes(name);
	}

	function hasGlobSyntax(pattern: string): boolean {
		return /[*?[\]{}]/.test(pattern);
	}

	function globLikeToRegExp(pattern: string): RegExp {
		const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
		return new RegExp(escaped, "i");
	}

	function pathMatchesPattern(path: string, pattern: string | undefined): boolean {
		const trimmed = pattern?.trim();
		if (!trimmed) return true;
		if (hasGlobSyntax(trimmed)) return globLikeToRegExp(trimmed).test(path);
		return path.toLowerCase().includes(trimmed.toLowerCase());
	}

	async function resolveToolPath(path: string, ctx: ExtensionContext, root?: string): Promise<string> {
		if (isAbsolute(path)) return path;
		const cwdPath = join(ctx.cwd, path);
		try {
			await stat(cwdPath);
			return cwdPath;
		} catch {
			return root && root !== ctx.cwd ? join(root, path) : cwdPath;
		}
	}

	async function walkRepoFiles(root: string, maxFiles: number): Promise<string[]> {
		const files: string[] = [];
		async function walk(dir: string): Promise<void> {
			if (files.length >= maxFiles) return;
			let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}

			entries.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of entries) {
				if (files.length >= maxFiles) return;
				const absolute = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (!shouldSkipRepoWalkDir(entry.name)) await walk(absolute);
					continue;
				}
				if (!entry.isFile()) continue;
				const rel = relative(root, absolute);
				if (rel && !rel.startsWith("..")) files.push(rel);
			}
		}
		await walk(root);
		return files;
	}

	async function listRepoFiles(ctx: ExtensionContext, root: string, maxFiles = 5000): Promise<{ files: string[]; source: "git" | "walk" }> {
		const git = await pi.exec("git", ["-C", root, "ls-files"], { cwd: ctx.cwd, timeout: 10000, signal: ctx.signal });
		if (git.code === 0) {
			const files = git.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, maxFiles);
			if (files.length > 0) return { files, source: "git" };
		}
		return { files: await walkRepoFiles(root, maxFiles), source: "walk" };
	}

	async function runGitLine(ctx: ExtensionContext, root: string, args: string[]): Promise<string | undefined> {
		const result = await pi.exec("git", ["-C", root, ...args], { cwd: ctx.cwd, timeout: 5000, signal: ctx.signal });
		if (result.code !== 0) return undefined;
		return result.stdout.trim().split("\n").find((line) => line.trim().length > 0)?.trim();
	}

	function firstSegments(files: string[], take = 30): string[] {
		const segments = new Set<string>();
		for (const file of files) {
			const first = file.split(/[\\/]/)[0];
			if (first) segments.add(first);
			if (segments.size >= take) break;
		}
		return [...segments];
	}

	function detectManifests(files: string[]): string[] {
		const manifestPatterns = [
			/(^|\/)package\.json$/,
			/(^|\/)pnpm-workspace\.yaml$/,
			/(^|\/)yarn\.lock$/,
			/(^|\/)pyproject\.toml$/,
			/(^|\/)requirements[^/]*\.txt$/,
			/(^|\/)Cargo\.toml$/,
			/(^|\/)go\.mod$/,
			/(^|\/)pom\.xml$/,
			/(^|\/)build\.gradle(?:\.kts)?$/,
			/(^|\/)Makefile$/,
			/(^|\/)justfile$/,
			/(^|\/)AGENTS\.md$/,
			/(^|\/)CLAUDE\.md$/,
		];
		return files.filter((file) => manifestPatterns.some((pattern) => pattern.test(file))).slice(0, 80);
	}

	function detectTestPaths(files: string[]): string[] {
		return files.filter((file) => /(^|\/)(tests?|spec|__tests__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$/i.test(file)).slice(0, 80);
	}

	function formatPathList(paths: string[], empty = "(none found)"): string {
		return paths.length > 0 ? paths.map((path) => `- ${path}`).join("\n") : empty;
	}

	function parseRgLine(line: string): { path: string; lineNumber: number; text: string } | undefined {
		const match = line.match(/^(.*?):(\d+):(.*)$/);
		if (!match) return undefined;
		return { path: match[1], lineNumber: Number(match[2]), text: match[3] };
	}

	function fileIsWithinSearchPaths(file: string, paths: string[] | undefined): boolean {
		if (!paths || paths.length === 0) return true;
		return paths.some((raw) => {
			const path = raw.replace(/^\.\//, "").replace(/\/$/, "");
			return path === "." || file === path || file.startsWith(`${path}/`);
		});
	}

	function escapeRegExp(text: string): string {
		return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	async function fallbackSearch(ctx: ExtensionContext, root: string, query: string, regex: boolean, paths: string[] | undefined, maxResults: number) {
		const matcher = regex ? new RegExp(query) : new RegExp(escapeRegExp(query));
		const { files } = await listRepoFiles(ctx, root, 5000);
		const matches: Array<{ path: string; lineNumber: number; text: string }> = [];

		for (const file of files) {
			if (matches.length >= maxResults) break;
			if (!fileIsWithinSearchPaths(file, paths)) continue;
			const absolute = join(root, file);
			try {
				const info = await stat(absolute);
				if (info.size > 1_500_000) continue;
				const text = await readFile(absolute, "utf8");
				if (text.includes("\0")) continue;
				const lines = text.split(/\r?\n/);
				for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
					if (matcher.test(lines[i])) matches.push({ path: file, lineNumber: i + 1, text: lines[i] });
				}
			} catch {
				// Ignore unreadable files during planning search.
			}
		}
		return matches;
	}

	function renderSearchMatches(matches: Array<{ path: string; lineNumber: number; text: string }>, maxResults: number): string {
		if (matches.length === 0) return "No matches found.";
		const lines = matches.slice(0, maxResults).map((match) => `${match.path}:${match.lineNumber}: ${match.text}`);
		return lines.join("\n");
	}

	pi.registerTool({
		name: PLAN_REPO_OVERVIEW_TOOL,
		label: "Plan Repo Overview",
		description: "Get a concise read-only overview of the current repository/workspace for planning.",
		promptSnippet: "Inspect repo layout, git status, manifests, and likely test paths for planning",
		promptGuidelines: [
			"Use plan_repo_overview at the start of Plan Mode when the repo shape is unknown; it is read-only and summarizes files, manifests, tests, and git state.",
		],
		parameters: PlanRepoOverviewParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const gitRoot = await gitRootForPath(ctx.cwd, ctx);
			const root = gitRoot ?? ctx.cwd;
			const maxFiles = clampInt((params as any).maxFiles, 80, 10, 200);
			const { files, source } = await listRepoFiles(ctx, root, Math.max(1000, maxFiles));
			const branch = gitRoot ? await runGitLine(ctx, root, ["branch", "--show-current"]) : undefined;
			const statusResult = gitRoot
				? await pi.exec("git", ["-C", root, "status", "--short"], { cwd: ctx.cwd, timeout: 5000, signal: ctx.signal })
				: undefined;
			const status = statusResult?.code === 0 && statusResult.stdout.trim() ? statusResult.stdout.trim().split(/\r?\n/).slice(0, 80) : [];
			const manifests = detectManifests(files);
			const tests = detectTestPaths(files);
			const topLevel = firstSegments(files);
			const sampleFiles = files.slice(0, maxFiles);

			const text = [
				"# Repository Overview",
				`- cwd: ${ctx.cwd}`,
				`- root: ${root}${gitRoot ? " (git)" : " (filesystem)"}`,
				`- branch: ${branch || "(unknown)"}`,
				`- file inventory source: ${source}`,
				`- tracked/discovered files shown: ${sampleFiles.length}${files.length > sampleFiles.length ? ` of at least ${files.length}` : ""}`,
				"",
				"## Git Status",
				status.length > 0 ? status.map((line) => `- ${line}`).join("\n") : "- clean or unavailable",
				"",
				"## Top-level Paths",
				formatPathList(topLevel),
				"",
				"## Manifests / Context Files",
				formatPathList(manifests),
				"",
				"## Likely Test Paths",
				formatPathList(tests.slice(0, 30)),
				"",
				"## Sample Files",
				formatPathList(sampleFiles),
			].join("\n");

			return planToolResult(text, { root, gitRoot, branch, source, status, manifests, tests, sampleFiles });
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(`${PLAN_REPO_OVERVIEW_TOOL} `)) + theme.fg("muted", `${args.maxFiles ?? 80} files`), 0, 0);
		},
	});

	pi.registerTool({
		name: PLAN_FILES_TOOL,
		label: "Plan Files",
		description: "List repository files using git ls-files or a read-only filesystem walk. Supports optional pattern filtering.",
		promptSnippet: "List repository files with optional pattern filtering for planning",
		promptGuidelines: ["Use plan_files instead of guessing paths when you need to discover relevant files in Plan Mode."],
		parameters: PlanFilesParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = await projectRoot(ctx);
			const maxResults = clampInt((params as any).maxResults, 200, 1, 1000);
			const pattern = typeof (params as any).pattern === "string" ? (params as any).pattern : undefined;
			const { files, source } = await listRepoFiles(ctx, root, Math.max(5000, maxResults));
			const matches = files.filter((file) => pathMatchesPattern(file, pattern));
			const shown = matches.slice(0, maxResults);
			const text = [`Found ${matches.length} matching file(s) via ${source}${matches.length > shown.length ? `; showing ${shown.length}.` : "."}`, "", formatPathList(shown)].join("\n");
			return planToolResult(text, { root, source, pattern, totalMatches: matches.length, files: shown });
		},
		renderCall(args, theme) {
			const pattern = args.pattern ? ` ${String(args.pattern)}` : "";
			return new Text(theme.fg("toolTitle", theme.bold(`${PLAN_FILES_TOOL}${pattern}`)), 0, 0);
		},
	});

	pi.registerTool({
		name: PLAN_SEARCH_TOOL,
		label: "Plan Search",
		description: "Search repository text read-only using ripgrep when available, with a JavaScript fallback.",
		promptSnippet: "Search code and docs read-only for planning",
		promptGuidelines: [
			"Use plan_search for repo-wide code search in Plan Mode; do not claim grep/find/search are unavailable.",
			"Prefer plan_search before asking the user questions that can be answered from files, symbols, manifests, or docs.",
		],
		parameters: PlanSearchParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const query = String((params as any).query ?? "");
			if (!query.trim()) return planToolResult("Error: query is required", { matches: [] });
			const root = await projectRoot(ctx);
			const maxResults = clampInt((params as any).maxResults, 80, 1, 300);
			const regex = Boolean((params as any).regex);
			const paths = Array.isArray((params as any).paths) ? (params as any).paths.filter((path: unknown): path is string => typeof path === "string" && path.trim()) : undefined;

			const rgArgs = [
				"--line-number",
				"--no-heading",
				"--color",
				"never",
				"--hidden",
				"--glob",
				"!.git/**",
				"--glob",
				"!node_modules/**",
				"--glob",
				"!dist/**",
				"--glob",
				"!build/**",
				"--glob",
				"!target/**",
				"--max-count",
				String(maxResults),
			];
			if (!regex) rgArgs.push("--fixed-strings");
			rgArgs.push(query, ...(paths && paths.length > 0 ? paths : ["."]));

			const rg = await pi.exec("rg", rgArgs, { cwd: root, timeout: 15000, signal: ctx.signal });
			if (rg.code === 0 || rg.code === 1) {
				const matches = rg.stdout.split(/\r?\n/).filter(Boolean).map(parseRgLine).filter((match): match is { path: string; lineNumber: number; text: string } => Boolean(match)).slice(0, maxResults);
				return planToolResult(renderSearchMatches(matches, maxResults), { root, engine: "rg", query, regex, paths, matches });
			}

			let matches: Array<{ path: string; lineNumber: number; text: string }>;
			try {
				matches = await fallbackSearch(ctx, root, query, regex, paths, maxResults);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return planToolResult(`Search failed. ripgrep error: ${rg.stderr.trim() || rg.stdout.trim() || `exit ${rg.code}`}\nFallback error: ${message}`, { root, engine: "error", query, regex, paths });
			}
			return planToolResult(renderSearchMatches(matches, maxResults), { root, engine: "fallback", query, regex, paths, matches, rgError: rg.stderr.trim() });
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(`${PLAN_SEARCH_TOOL} `)) + theme.fg("muted", truncateToWidth(String(args.query ?? ""), 80)), 0, 0);
		},
	});

	pi.registerTool({
		name: PLAN_READ_MANY_TOOL,
		label: "Plan Read Many",
		description: "Read multiple files in one read-only batch for planning. Useful after plan_search or plan_files.",
		promptSnippet: "Read multiple files or line ranges in one batch for planning",
		promptGuidelines: ["Use plan_read_many after plan_search or plan_files when multiple files must be inspected before producing a plan."],
		parameters: PlanReadManyParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const files = Array.isArray((params as any).files) ? (params as any).files.slice(0, 12) : [];
			if (files.length === 0) return planToolResult("Error: provide at least one file to read", { files: [] });

			const root = await projectRoot(ctx);
			const blocks: string[] = [];
			const details: Array<{ path: string; start: number; end: number; totalLines: number; error?: string }> = [];
			for (const request of files) {
				const path = String(request?.path ?? "").trim();
				if (!path) continue;
				const absolute = await resolveToolPath(path, ctx, root);
				try {
					const raw = await readFile(absolute, "utf8");
					if (raw.includes("\0")) throw new Error("appears to be binary");
					const allLines = raw.split(/\r?\n/);
					const start = clampInt(request?.offset, 1, 1, Math.max(1, allLines.length));
					const limit = clampInt(request?.limit, 160, 1, 300);
					const slice = allLines.slice(start - 1, start - 1 + limit);
					const end = start + slice.length - 1;
					blocks.push([`## ${path} (${start}-${end} of ${allLines.length})`, "~~~", slice.join("\n"), "~~~"].join("\n"));
					details.push({ path, start, end, totalLines: allLines.length });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					blocks.push(`## ${path}\nError: ${message}`);
					details.push({ path, start: 0, end: 0, totalLines: 0, error: message });
				}
			}

			return planToolResult(blocks.join("\n\n"), { files: details });
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.files) ? args.files.length : 0;
			return new Text(theme.fg("toolTitle", theme.bold(`${PLAN_READ_MANY_TOOL} `)) + theme.fg("muted", `${count} file${count === 1 ? "" : "s"}`), 0, 0);
		},
	});

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
				let cachedMaxLines: number | undefined;
				let scrollOffset = 0;
				let maxScrollOffset = 0;
				let lastBodyHeight = 0;
				let lastRenderedViewKey = "";
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
					cachedMaxLines = undefined;
					tui.requestRender();
				}

				function resetScroll(): void {
					scrollOffset = 0;
				}

				function maxDialogLines(): number {
					const rows = typeof process !== "undefined" && process.stdout?.rows ? process.stdout.rows : 24;
					return Math.max(6, Math.floor(rows * 0.8) - 1);
				}

				function scrollBy(delta: number): boolean {
					if (maxScrollOffset <= 0) return false;
					const next = Math.max(0, Math.min(maxScrollOffset, scrollOffset + delta));
					if (next === scrollOffset) return false;
					scrollOffset = next;
					refresh();
					return true;
				}

				function scrollPage(direction: 1 | -1): boolean {
					return scrollBy(direction * Math.max(1, lastBodyHeight - 1));
				}

				function handleScrollInput(data: string, allowArrowKeys = false): boolean {
					if (matchesKey(data, "pageUp")) return scrollPage(-1);
					if (matchesKey(data, "pageDown")) return scrollPage(1);
					if (allowArrowKeys && matchesKey(data, Key.up)) return scrollBy(-1);
					if (allowArrowKeys && matchesKey(data, Key.down)) return scrollBy(1);
					return false;
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
						if (handleScrollInput(data)) return;
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

						if (handleScrollInput(data, true)) return;

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

					if (handleScrollInput(data)) return;

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
						if (handleScrollInput(data, true)) return;
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
					const maxLines = maxDialogLines();
					const viewKey = [
						currentTab,
						inputMode ? `input:${inputQuestionId ?? ""}` : "",
						modelSelectMode ? `model:${modelSelectQuestionId ?? ""}` : "",
						agentReviewMode
							? `agent:${agentReviewQuestionId ?? ""}:${agentReviewRunning ? "running" : agentReviewError ? "error" : "done"}`
							: "",
					].join("|");
					if (viewKey !== lastRenderedViewKey) {
						resetScroll();
						lastRenderedViewKey = viewKey;
						cachedLines = undefined;
						cachedWidth = undefined;
						cachedMaxLines = undefined;
					}
					if (cachedLines && cachedWidth === width && cachedMaxLines === maxLines) return cachedLines;

					const renderWidth = Math.max(1, width);
					const q = currentQuestion();
					const opts = currentOptions();
					const headerLines: string[] = [];
					const bodyLines: string[] = [];
					const borderLine = theme.fg("accent", "─".repeat(renderWidth));
					let footerHelp: string | undefined;

					function addWrappedTo(target: string[], text: string): void {
						const wrapped = wrapTextWithAnsi(text, renderWidth);
						if (wrapped.length === 0) target.push("");
						else target.push(...wrapped);
					}

					function addWrappedWithPrefixTo(
						target: string[],
						prefix: string,
						text: string,
						continuationPrefix = " ".repeat(visibleWidth(prefix)),
					): void {
						const prefixWidth = visibleWidth(prefix);
						const continuationWidth = visibleWidth(continuationPrefix);
						const reservedWidth = Math.max(prefixWidth, continuationWidth);
						if (reservedWidth >= renderWidth) {
							addWrappedTo(target, prefix + text);
							return;
						}

						const wrapped = wrapTextWithAnsi(text, renderWidth - reservedWidth);
						if (wrapped.length === 0) {
							target.push(truncateToWidth(prefix, renderWidth, ""));
							return;
						}

						for (let i = 0; i < wrapped.length; i++) {
							target.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					function addWrapped(text: string): void {
						addWrappedTo(bodyLines, text);
					}

					function addWrappedWithPrefix(prefix: string, text: string, continuationPrefix = " ".repeat(visibleWidth(prefix))): void {
						addWrappedWithPrefixTo(bodyLines, prefix, text, continuationPrefix);
					}

					headerLines.push(borderLine);

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
						addWrappedWithPrefixTo(headerLines, " ", `${tabs.join(" ")} →`);
						headerLines.push("");
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
							if (line.length === 0) bodyLines.push("");
							else addWrappedWithPrefix(" ", theme.fg(color, line));
						}
					}

					if (modelSelectMode && q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						bodyLines.push("");
						addWrappedWithPrefix(" ", theme.fg("accent", "Choose a scoped model for the plan-review agent:"));
						bodyLines.push("");
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
						footerHelp = theme.fg("dim", planAgentModelOptions.length > 0 ? "↑↓ select • Enter ask agent • Esc back" : "Esc back");
					} else if (agentReviewMode && q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						bodyLines.push("");
						if (agentReviewRunning) {
							addWrappedWithPrefix(" ", theme.fg("accent", "Asking the selected plan-review model..."));
							bodyLines.push("");
							addWrappedWithPrefix(" ", theme.fg("dim", "Forwarding the current planning conversation and any draft/proposed plan."));
							footerHelp = theme.fg("dim", "Esc cancels");
						} else if (agentReviewError) {
							addWrappedWithPrefix(" ", theme.fg("error", "Agent review failed:"));
							addMultiline(agentReviewError, "error");
							footerHelp = theme.fg("dim", "Esc back");
						} else {
							addWrappedWithPrefix(" ", theme.fg("accent", `Agent recommendation${agentReviewModel ? ` (${agentReviewModel})` : ""}:`));
							bodyLines.push("");
							addMultiline(agentReviewText || "(empty response)");
							footerHelp = theme.fg("dim", "Enter use as answer • E edit before using • Esc back");
						}
					} else if (inputMode && q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						bodyLines.push("");
						renderOptions();
						bodyLines.push("");
						addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
						for (const line of editor.render(Math.max(1, renderWidth - 2))) bodyLines.push(` ${line}`);
						footerHelp = theme.fg("dim", "Enter to save • Esc back");
					} else if (currentTab === questions.length) {
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Review answers")));
						bodyLines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							const prefix = theme.fg("muted", ` ${question.label}: `);
							const text = answer ? theme.fg("text", answer.label) : theme.fg("warning", "unanswered");
							addWrappedWithPrefix(prefix, text);
						}
						footerHelp = allAnswered() ? theme.fg("success", "Enter submit") : theme.fg("warning", "Tab back to answer missing questions");
					} else if (q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						bodyLines.push("");
						renderOptions();
					}

					if (!footerHelp && !inputMode && !agentReviewMode && !modelSelectMode) {
						footerHelp = theme.fg("dim", isMulti ? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel" : "↑↓ select • Enter confirm • Esc cancel");
					}

					function buildFooter(scrollable: boolean, visibleRows: number): string[] {
						const footerLines: string[] = [];
						const parts: string[] = [];
						if (scrollable) {
							const visibleCount = Math.max(1, visibleRows);
							const hintOffset = Math.min(scrollOffset, Math.max(0, bodyLines.length - visibleCount));
							const from = bodyLines.length === 0 ? 0 : hintOffset + 1;
							const to = Math.min(bodyLines.length, hintOffset + visibleCount);
							const scrollKeys = currentTab === questions.length || (agentReviewMode && !agentReviewRunning) ? "↑↓/PgUp/PgDn scroll" : "PgUp/PgDn scroll";
							parts.push(theme.fg("dim", `${scrollKeys} (${from}-${to}/${bodyLines.length})`));
						}
						if (footerHelp) parts.push(footerHelp);
						if (parts.length > 0) {
							footerLines.push("");
							addWrappedWithPrefixTo(footerLines, " ", parts.join(theme.fg("dim", " • ")));
						}
						footerLines.push(borderLine);
						return footerLines;
					}

					let footerLines = buildFooter(false, 0);
					let bodyHeight = Math.max(0, maxLines - headerLines.length - footerLines.length);
					let scrollable = bodyLines.length > bodyHeight;
					footerLines = buildFooter(scrollable, bodyHeight);
					bodyHeight = Math.max(0, maxLines - headerLines.length - footerLines.length);
					scrollable = bodyLines.length > bodyHeight;
					footerLines = buildFooter(scrollable, bodyHeight);
					bodyHeight = Math.max(0, maxLines - headerLines.length - footerLines.length);

					lastBodyHeight = bodyHeight;
					maxScrollOffset = Math.max(0, bodyLines.length - bodyHeight);
					scrollOffset = Math.min(scrollOffset, maxScrollOffset);

					const visibleBody = bodyHeight > 0 ? bodyLines.slice(scrollOffset, scrollOffset + bodyHeight) : [];
					const lines = [...headerLines, ...visibleBody, ...footerLines];
					cachedLines = lines;
					cachedWidth = width;
					cachedMaxLines = maxLines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
						cachedWidth = undefined;
						cachedMaxLines = undefined;
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

	pi.registerTool({
		name: UPDATE_PLAN_TOOL,
		label: "Update Plan",
		description:
			"Update the active Plan Mode execution checklist. Provide the full ordered plan with each step status. At most one step may be in_progress.",
		promptSnippet: "Update the active Plan Mode execution checklist with structured step statuses",
		promptGuidelines: [
			"Use update_plan during Plan Mode execution to keep the todo list current; do not use prose markers like [DONE:n] as the primary progress mechanism.",
			"Call update_plan before starting a new step, marking exactly one step in_progress, and call it again when that step becomes completed, skipped, deferred, or blocked.",
			"Every update_plan call must include the full ordered checklist, not just the changed step.",
		],
		parameters: UpdatePlanParams,
		prepareArguments(args: any) {
			if (!args || typeof args !== "object" || !Array.isArray(args.plan)) return args;
			return {
				...args,
				plan: args.plan.map((item: any) => {
					if (!item || typeof item !== "object") return item;
					const raw = typeof item.status === "string" ? item.status : "";
					const status = raw
						.replace(/-/g, "_")
						.replace(/^inProgress$/i, "in_progress")
						.replace(/^complete$/i, "completed")
						.replace(/^done$/i, "completed")
						.toLowerCase();
					return { ...item, status };
				}),
			};
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (planModeEnabled) {
				throw new Error("update_plan is a TODO/checklist tool for implementation progress and is not allowed while still planning.");
			}
			if (!executionMode || todoItems.length === 0) {
				throw new Error("No active Plan Mode execution checklist. Accept a proposed plan before using update_plan.");
			}

			todoItems = normalizeUpdatePlanItems(params.plan as UpdatePlanToolItem[]);
			const details = buildUpdatePlanToolResult(params.explanation, todoItems);
			persistState();
			const finished = await finishPlanExecutionIfComplete(ctx);
			if (!finished) {
				await updateSavedPlanProgress(ctx);
				updateStatus(ctx);
			}

			return {
				content: [{ type: "text" as const, text: updatePlanToolResultText(details) }],
				details,
			};
		},

		renderCall(args, theme) {
			const count = Array.isArray(args.plan) ? args.plan.length : 0;
			let text = theme.fg("toolTitle", theme.bold("update_plan "));
			text += theme.fg("muted", `${count} step${count === 1 ? "" : "s"}`);
			if (args.explanation) text += theme.fg("dim", ` — ${truncateToWidth(String(args.explanation), 60)}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as UpdatePlanToolResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const lines: string[] = [];
			if (details.explanation?.trim()) lines.push(theme.fg("dim", details.explanation.trim()));
			lines.push(theme.fg("muted", `${details.closed}/${details.total} closed`));
			const display = expanded ? details.todos : details.todos.slice(0, 8);
			for (const todo of display) {
				const status = todo.status ?? (todo.completed ? "done" : "pending");
				const icon = statusIcon(status);
				const color = status === "done" ? "success" : status === "in_progress" ? "accent" : status === "blocked" ? "error" : status === "deferred" ? "warning" : "muted";
				const text = status === "done" || status === "skipped" ? theme.strikethrough(todo.text) : todo.text;
				lines.push(`${theme.fg(color, icon)} ${theme.fg(status === "pending" ? "muted" : color, text)}`);
			}
			if (!expanded && details.todos.length > display.length) {
				lines.push(theme.fg("dim", `... ${details.todos.length - display.length} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	function todoStatusFromUpdatePlanStatus(status: UpdatePlanToolStatus): TodoStatus {
		switch (status) {
			case "completed":
				return "done";
			case "in_progress":
				return "in_progress";
			case "skipped":
				return "skipped";
			case "deferred":
				return "deferred";
			case "blocked":
				return "blocked";
			default:
				return "pending";
		}
	}

	function normalizeUpdatePlanItems(plan: UpdatePlanToolItem[]): TodoItem[] {
		if (plan.length === 0) throw new Error("update_plan requires at least one plan item.");
		const inProgressCount = plan.filter((item) => item.status === "in_progress").length;
		if (inProgressCount > 1) throw new Error("update_plan accepts at most one in_progress step.");

		return plan.map((item, index) => {
			const text = item.step.trim();
			if (!text) throw new Error(`update_plan step ${index + 1} has empty text.`);
			const status = todoStatusFromUpdatePlanStatus(item.status);
			const todo: TodoItem = { step: index + 1, text, completed: false, status };
			setTodoStatus(todo, status);
			return todo;
		});
	}

	function statusIcon(status: TodoStatus): string {
		switch (status) {
			case "done":
				return "✓";
			case "in_progress":
				return "▶";
			case "skipped":
				return "⊘";
			case "deferred":
				return "↷";
			case "blocked":
				return "⚠";
			default:
				return "○";
		}
	}

	function buildUpdatePlanToolResult(explanation: string | undefined, todos: TodoItem[]): UpdatePlanToolResult {
		const closed = todos.filter((todo) => isTodoClosed(todo)).length;
		const currentStep = todos.find((todo) => (todo.status ?? (todo.completed ? "done" : "pending")) === "in_progress")?.text;
		return { explanation, todos: todos.map((todo) => ({ ...todo })), closed, total: todos.length, currentStep };
	}

	function updatePlanToolResultText(details: UpdatePlanToolResult): string {
		const current = details.currentStep ? ` Current: ${details.currentStep}` : "";
		const explanation = details.explanation?.trim() ? `\n${details.explanation.trim()}` : "";
		return `Plan updated: ${details.closed}/${details.total} closed.${current}${explanation}`;
	}

	function coerceTodoStatus(status: unknown, completed = false): TodoStatus {
		switch (status) {
			case "completed":
			case "done":
				return "done";
			case "in_progress":
				return "in_progress";
			case "skipped":
				return "skipped";
			case "deferred":
				return "deferred";
			case "blocked":
				return "blocked";
			default:
				return completed ? "done" : "pending";
		}
	}

	function normalizeStoredTodoItems(raw: unknown): TodoItem[] {
		if (!Array.isArray(raw)) return [];
		return raw.flatMap((item, index): TodoItem[] => {
			if (!item || typeof item !== "object") return [];
			const text = typeof (item as any).text === "string" ? (item as any).text.trim() : "";
			if (!text) return [];
			const status = coerceTodoStatus((item as any).status, Boolean((item as any).completed));
			const todo: TodoItem = { step: index + 1, text, completed: false, status };
			setTodoStatus(todo, status);
			return [todo];
		});
	}

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
				if (status === "in_progress") return `${ctx.ui.theme.fg("accent", "▶ ")}${item.text}`;
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
		const safeTools = names.filter((name: string) => !MUTATING_TOOLS_IN_PLAN_MODE.has(name) && !isPlanOwnedTool(name));
		return existingToolNames([...new Set([...safeTools, ...REQUIRED_PLAN_TOOLS])]);
	}

	function defaultNormalTools(): string[] {
		return existingToolNames(DEFAULT_NORMAL_TOOLS);
	}

	function currentActiveToolNames(): string[] {
		return existingToolNames(normalizeToolNames(pi.getActiveTools()));
	}

	function restoreSavedTools(): void {
		const toolsToRestore = existingToolNames(savedTools.filter((name: string) => !isPlanOwnedTool(name)));
		pi.setActiveTools(toolsToRestore.length > 0 ? toolsToRestore : defaultNormalTools());
	}

	function enableExecutionTools(): void {
		const active = currentActiveToolNames().filter((name: string) => !isPlanOwnedTool(name));
		const base = active.length > 0 ? active : defaultNormalTools();
		pi.setActiveTools(existingToolNames([...new Set([...base, UPDATE_PLAN_TOOL])]));
	}

	function enterPlanThinkingMode(): void {
		if (savedThinkingLevel === undefined) savedThinkingLevel = pi.getThinkingLevel();
		pi.setThinkingLevel(PLAN_MODE_THINKING_LEVEL as any);
	}

	function restoreSavedThinkingLevel(): void {
		if (savedThinkingLevel !== undefined) {
			pi.setThinkingLevel(savedThinkingLevel as any);
			savedThinkingLevel = undefined;
		}
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
			// Save current tools and filter out Plan Mode-owned tools. pi.getActiveTools() returns tool names.
			const currentTools = currentActiveToolNames();
			savedTools = (currentTools.length > 0 ? currentTools : defaultNormalTools()).filter((name: string) => !isPlanOwnedTool(name));
			pi.setActiveTools(planModeToolNames(savedTools));
			enterPlanThinkingMode();
			lastProposedPlan = "";
			todoItems = [];
			contextResetActive = false;
			ctx.ui.notify(`Plan mode enabled. Read-only exploration tools and ${PLAN_MODE_THINKING_LEVEL} thinking enabled; mutating tools (edit/write) disabled.`);
		} else {
			contextResetActive = false;
			planModeBashSnapshots.clear();
			restoreSavedTools();
			restoreSavedThinkingLevel();
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
			savedThinkingLevel,
			savedPlanAbsolutePath,
			savedPlanRelativePath,
			savedPlanRoot,
			contextResetActive,
		});
	}

	function sameTodoTexts(a: TodoItem[], b: TodoItem[]): boolean {
		return a.length === b.length && a.every((item, index) => item.text.toLowerCase() === b[index]?.text.toLowerCase());
	}

	function sameTodoState(a: TodoItem[], b: TodoItem[]): boolean {
		return (
			sameTodoTexts(a, b) &&
			a.every(
				(item, index) =>
					(item.status ?? (item.completed ? "done" : "pending")) ===
					(b[index]?.status ?? (b[index]?.completed ? "done" : "pending")),
			)
		);
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
				planModeBashSnapshots.clear();
				todoItems = [];
				restoreSavedTools();
				restoreSavedThinkingLevel();
				persistState();
				updateStatus(ctx);
				ctx.ui.notify("Plan execution tracking cancelled. Full access restored.", "info");
				return;
			}
			togglePlanMode(ctx);
		},
	});

	pi.registerCommand("todos", {
		description: "Show or update current plan todo list. Usage: /todos, /todos start|done|skip|defer|block|open 1-3, /todos reset",
		handler: async (args: any, ctx: ExtensionContext) => {
			const command = String(args ?? "").trim();
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}

			const stateMatch = command.match(/^(start|progress|in[-_ ]?progress|done|mark|complete|skip|skipped|defer|deferred|block|blocked|open|reopen|pending)\b/i);
			if (stateMatch) {
				const verb = stateMatch[1].toLowerCase();
				const status: TodoStatus = /^(done|mark|complete)$/.test(verb)
					? "done"
					: /^(start|progress|in[-_ ]?progress)$/.test(verb)
						? "in_progress"
						: /^skip/.test(verb)
							? "skipped"
							: /^defer/.test(verb)
								? "deferred"
								: /^block/.test(verb)
									? "blocked"
									: "pending";
				const steps = parseStepSpec(command.slice(stateMatch[0].length));
				let changed = 0;
				if (status === "in_progress" && steps.length > 0) {
					for (const item of todoItems) {
						if ((item.status ?? (item.completed ? "done" : "pending")) === "in_progress" && !steps.includes(item.step)) {
							setTodoStatus(item, "pending");
							changed++;
						}
					}
				}
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
						savedThinkingLevel,
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

	// Block destructive bash commands in plan mode and snapshot tracked-file state.
	pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}

		try {
			const root = await gitRootForPath(ctx.cwd, ctx);
			if (!root) return;
			const status = await pi.exec("git", ["-C", root, "status", "--short", "--untracked-files=no"], { cwd: ctx.cwd, timeout: 5000, signal: ctx.signal });
			if (status.code === 0) planModeBashSnapshots.set(event.toolCallId, { root, status: status.stdout.trim() });
		} catch {
			// Snapshotting is a safety aid; never break an otherwise safe read-only command because of it.
		}
	});

	pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
		if (!planModeEnabled || event.toolName !== "bash") return;
		const snapshot = planModeBashSnapshots.get(event.toolCallId);
		if (!snapshot) return;
		planModeBashSnapshots.delete(event.toolCallId);

		try {
			const status = await pi.exec("git", ["-C", snapshot.root, "status", "--short", "--untracked-files=no"], { cwd: ctx.cwd, timeout: 5000, signal: ctx.signal });
			const after = status.code === 0 ? status.stdout.trim() : snapshot.status;
			if (after !== snapshot.status) {
				const warning = `\n\n⚠️ Plan Mode warning: this bash command changed tracked files under ${snapshot.root}. Planning should remain read-only; inspect git diff before continuing.`;
				const content = Array.isArray(event.content) ? event.content : [];
				ctx.ui.notify(warning.trim(), "warning");
				return { content: [...content, { type: "text" as const, text: warning }] };
			}
		} catch {
			// Ignore post-check failures; the command result remains available to the model.
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
	pi.on("before_agent_start", async (event: any) => {
		if (planModeEnabled) {
			const promptText = typeof event?.prompt === "string" ? event.prompt : "";
			if (lastProposedPlan && shouldUsePlanRefinementContext(promptText, true)) {
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
					systemPrompt: withPlanModeSystemPrompt(
						event,
						`You are refining the current proposed plan. Produce a complete replacement only when the revision is decision-complete.\n\nCurrent proposed plan:\n<proposed_plan>\n${lastProposedPlan}\n</proposed_plan>`,
					),
				};
			}

			// No active refinement this turn - output full Codex plan.md mode rules.
			// If the user pasted a full <proposed_plan>, treat it as fresh user input
			// unless they explicitly asked to revise the previous stored plan.
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
* First-class Plan Mode tools: \`plan_repo_overview\`, \`plan_files\`, \`plan_search\`, and \`plan_read_many\`
* Read-only bash search/list commands such as \`rg\`, \`fd\`, \`find\`, \`grep\`, \`git grep\`, \`git ls-files\`, \`ls\`, and \`tree\`
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
Do not claim search tools like grep/find are unavailable: use \`plan_search\`, \`plan_files\`, \`plan_read_many\`, \`read\`, or read-only \`bash\` commands such as \`rg\`, \`fd\`, \`find\`, and \`git grep\`.

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
				systemPrompt: withPlanModeSystemPrompt(event),
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

**IMPORTANT**: Use the structured \`update_plan\` tool to keep this checklist current. Do not rely on prose markers like \`[DONE:n]\`.

Before starting work on a step, call \`update_plan\` with the full ordered checklist and mark exactly one open step \`in_progress\`. When that step is complete, skipped, deferred, or blocked, call \`update_plan\` again with the full checklist and the updated status before moving on.

If the user explicitly skips or defers a step, use \`update_plan\` or \`/todos skip <n>\` / \`/todos defer <n>\` instead of claiming it is done. If a step is blocked, mark it \`blocked\` and explain the blocker.

Before saying a PR is ready, clean, or ready for human review, check both CI and review state. For GitHub PR work, inspect normal comments and inline review comments/threads (for example with \`gh pr checks\`, \`gh pr view --comments\`, \`gh api repos/:owner/:repo/pulls/:number/comments\`, and GraphQL review thread queries where needed). Resolve or respond to actionable automated-review comments before handoff.

Finish with all items completed, skipped, or deferred before ending the turn. If work remains blocked, leave the blocked item visible in \`update_plan\` and explain the blocker.`,
					display: false,
				},
			};
		}
	});

	// Handoff warning after each assistant turn. Progress itself is updated only
	// through update_plan or explicit /todos commands, never by parsing prose.
	pi.on("turn_end", async (event: any) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (hasHandoffClaim(text)) {
			const open = todoItems.filter((item: TodoItem) => isTodoOpen(item));
			if (open.length > 0) {
				pi.sendMessage(
					{
						customType: "plan-handoff-warning",
						content: `⚠️ **Plan handoff warning:** this response sounds like a handoff, but ${open.length} plan item(s) are still open. Use \`update_plan\` or \`/todos done|skip|defer|block <n>\` before handing off.\n\n${open.map((item) => `${item.step}. ${item.text}`).join("\n")}`,
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
				for (const item of todoItems) setTodoStatus(item, "pending");
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
				planModeBashSnapshots.clear();
				restoreSavedTools();
				restoreSavedThinkingLevel();
				enableExecutionTools();
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
				planModeBashSnapshots.clear();
				restoreSavedTools();
				restoreSavedThinkingLevel();
				enableExecutionTools();
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

		const branchEntries = ctx.sessionManager.getBranch();

		// Restore persisted state from the active branch.
		const planModeEntry = branchEntries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as
			| {
					data?: {
						enabled: boolean;
						todos?: TodoItem[];
						executing?: boolean;
						lastProposedPlan?: string;
						savedTools?: string[];
						savedThinkingLevel?: string;
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
			savedTools = existingToolNames(normalizeToolNames(planModeEntry.data.savedTools ?? savedTools)).filter((name: string) => !isPlanOwnedTool(name));
			savedThinkingLevel = planModeEntry.data.savedThinkingLevel ?? savedThinkingLevel;
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

		// Restore the latest structured update_plan result on resume. Do not infer progress
		// from assistant prose; that is what caused false completions in long plans.
		if (executionMode && todoItems.length > 0) {
			const latestUpdatePlan = branchEntries
				.filter((entry: any) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === UPDATE_PLAN_TOOL)
				.pop() as { message?: { details?: UpdatePlanToolResult } } | undefined;
			const restoredTodos = normalizeStoredTodoItems(latestUpdatePlan?.message?.details?.todos);
			if (restoredTodos.length > 0 && !sameTodoState(todoItems, restoredTodos)) {
				todoItems = restoredTodos;
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
			enterPlanThinkingMode();
		} else if (executionMode && todoItems.length > 0) {
			restoreSavedTools();
			restoreSavedThinkingLevel();
			enableExecutionTools();
		} else if (planModeEntry?.data) {
			restoreSavedTools();
			restoreSavedThinkingLevel();
		} else {
			const active = currentActiveToolNames();
			if (active.some((name: string) => isPlanOwnedTool(name))) {
				const filtered = active.filter((name: string) => !isPlanOwnedTool(name));
				pi.setActiveTools(filtered.length > 0 ? filtered : defaultNormalTools());
			}
		}
		if (restoredPlanProgressNeedsWrite) await updateSavedPlanProgress(ctx);
		updateStatus(ctx);
	});
}
