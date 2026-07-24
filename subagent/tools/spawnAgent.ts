import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig, type AgentScope } from "../agents.ts";
import type { AgentRecord, ContextMode, RoutingMode, RoutingObjective, ThinkingLevel, WriteMode } from "../core/AgentTypes.ts";
import { sanitizeContextText } from "../core/ContextSanitizer.ts";
import { renderAgentSummary } from "../render/renderAgent.ts";
import { type ManagerGetter, preview, textResult } from "./common.ts";
import { resolveRouting } from "./router.ts";
import { expandSpawnParams } from "./spawnParams.ts";

const TaskNameParam = Type.String({ description: "Short lowercase-ish task name for the child agent." });
const PromptParam = Type.String({ description: "Delegated task prompt." });

const SpawnAgentCommonParams = {
	cwd: Type.Optional(Type.String({ description: "Working directory for the child agent. Defaults to the current project cwd." })),
	parentAgentId: Type.Optional(Type.String({ description: "Parent agent id. Omit for root-spawned agents." })),
	taskPath: Type.Optional(Type.String({ description: "Canonical task path. Omit to derive from parent/taskName." })),
	agentName: Type.Optional(Type.String({ description: "Markdown agent definition name from ~/.pi/agent/agents or .pi/agents." })),
	agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, { description: "Agent definition scope. Defaults to user." })),
	confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Prompt before using project-local agent definitions. Defaults to true." })),
	agentDefinition: Type.Optional(Type.String({ description: "Inline extra system prompt for this child." })),
	agentDefinitionFile: Type.Optional(Type.String({ description: "File containing extra system prompt for this child." })),
	contextMode: Type.Optional(StringEnum(["fresh", "summary", "last_n_turns", "full_sanitized"] as const, { description: "Context inheritance mode. Defaults to fresh." })),
	contextTurns: Type.Optional(Type.Number({ description: "Reserved for last_n_turns context mode." })),
	contextSummary: Type.Optional(Type.String({ description: "Explicit inherited summary when contextMode=summary." })),
	writeMode: Type.Optional(StringEnum(["read_only", "disjoint_scope", "git_worktree"] as const, { description: "Child write policy. Defaults to read_only." })),
	allowedPaths: Type.Optional(Type.Array(Type.String(), { description: "Allowed paths for disjoint_scope write mode." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum runtime for the delegated task. Values below 300000ms are ignored and use the default 30-minute runtime." })),
	maxOutputChars: Type.Optional(Type.Number({ description: "Maximum retained output characters for this agent." })),
	model: Type.Optional(Type.String({ description: "Optional model override for the child process. Defaults to the current main Pi model." })),
	thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Optional thinking level override for the child process." })),
	routingMode: Type.Optional(StringEnum(["auto", "off", "explain"] as const, { description: "Smart router mode. Defaults to off/inherit current main Pi model; set auto to route." })),
	routingProfile: Type.Optional(StringEnum(["balanced", "cost_first", "quality_first", "latency_first"] as const, { description: "Router objective for cost/reward/quality/latency tradeoff." })),
};

const SpawnAgentTaskParams = Type.Object({
	taskName: TaskNameParam,
	prompt: PromptParam,
	...SpawnAgentCommonParams,
});

const SpawnAgentParams = Type.Object({
	taskName: Type.Optional(TaskNameParam),
	prompt: Type.Optional(PromptParam),
	tasks: Type.Optional(Type.Array(SpawnAgentTaskParams, { description: "Spawn multiple independent subagents in one tool call. Top-level fields are defaults; per-task fields override them. Prefer this over emitting several spawn_agent calls in one assistant response." })),
	...SpawnAgentCommonParams,
});

function textFromMessageContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function buildVisibleSessionSummary(ctx: any, maxChars = 16_000): string {
	const entries = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
	const lines: string[] = [];
	for (const entry of entries.slice(-24)) {
		const message = entry?.message;
		if (!message) continue;
		if (message.role === "user") {
			const text = textFromMessageContent(message.content);
			if (text.trim()) lines.push(`User: ${text.trim()}`);
		} else if (message.role === "assistant") {
			const text = textFromMessageContent(message.content);
			if (text.trim()) lines.push(`Assistant: ${text.trim()}`);
		}
	}
	if (lines.length === 0) return "";
	return sanitizeContextText(`Recent visible parent conversation excerpt (not hidden reasoning, not tool results):\n\n${lines.join("\n\n")}`, maxChars);
}

async function resolveAgentDefinition(ctx: any, params: any): Promise<{ definition?: string; agent?: AgentConfig }> {
	let definition = params.agentDefinition?.trim() || "";
	let agent: AgentConfig | undefined;
	if (params.agentDefinitionFile) {
		const baseCwd = params.cwd ? resolve(ctx.cwd, String(params.cwd)) : ctx.cwd;
		const filePath = resolve(baseCwd, String(params.agentDefinitionFile).replace(/^@/, ""));
		definition += `${definition ? "\n\n" : ""}${await readFile(filePath, "utf8")}`;
	}
	if (params.agentName) {
		const scope: AgentScope = params.agentScope ?? "user";
		const discovery = discoverAgents(ctx.cwd, scope);
		agent = discovery.agents.find((candidate) => candidate.name === params.agentName);
		if (!agent) {
			const available = discovery.agents.map((candidate) => `${candidate.name} (${candidate.source})`).join(", ") || "none";
			throw new Error(`Unknown agentName ${params.agentName}. Available agents: ${available}`);
		}
		if (agent.source === "project" && (params.confirmProjectAgents ?? true)) {
			if (!ctx.hasUI) throw new Error(`Project-local agent ${agent.name} requires interactive confirmation.`);
			const ok = await ctx.ui.confirm("Run project-local subagent?", `Agent: ${agent.name}\nSource: ${agent.filePath}\n\nProject agents are repo-controlled prompts. Continue only for trusted repositories.`);
			if (!ok) throw new Error("Project-local agent was not approved.");
		}
		definition = `${agent.systemPrompt.trim()}${definition ? `\n\n${definition}` : ""}`;
	}
	return { definition: definition || undefined, agent };
}

async function confirmWriteCapability(ctx: any, spawnParams: any[]): Promise<void> {
	if (!ctx.hasUI) return;
	const writeTasks = spawnParams.filter((item) => (item.writeMode ?? "read_only") !== "read_only");
	if (writeTasks.length === 0) return;
	const names = writeTasks.slice(0, 8).map((item) => `${item.taskName}: ${item.writeMode}`).join("\n");
	const suffix = writeTasks.length > 8 ? `\n... ${writeTasks.length - 8} more` : "";
	const ok = await ctx.ui.confirm("Spawn write-capable subagent(s)?", `${writeTasks.length} task(s) request write access:\n${names}${suffix}\n\nParallel write-capable agents can conflict. Continue?`);
	if (!ok) throw new Error("Write-capable subagent was not approved.");
}

async function spawnOne(ctx: any, manager: ReturnType<ManagerGetter>, params: any, signal?: AbortSignal): Promise<AgentRecord> {
	const { definition, agent } = await resolveAgentDefinition(ctx, params);
	const contextMode = (params.contextMode ?? "fresh") as ContextMode;
	const contextSummary = params.contextSummary ?? (contextMode === "summary" ? buildVisibleSessionSummary(ctx) : undefined);
	const explicitModel = params.model ?? agent?.model;
	const explicitThinkingLevel = (params.thinkingLevel ?? agent?.thinkingLevel) as ThinkingLevel | undefined;
	const routingMode = (params.routingMode ?? agent?.routingMode) as RoutingMode | undefined;
	const routingProfile = (params.routingProfile ?? agent?.routingProfile) as RoutingObjective | undefined;
	const routed = await resolveRouting(ctx, {
		taskName: params.taskName,
		prompt: params.prompt,
		agentName: agent?.name ?? params.agentName,
		agentDefinition: definition,
		contextSummary,
		contextMode,
		writeMode: (params.writeMode ?? "read_only") as WriteMode,
		tools: agent?.tools,
		explicitModel,
		explicitThinkingLevel,
		routingMode,
		routingProfile,
	});
	return manager.spawnAgent({
		taskName: params.taskName,
		prompt: params.prompt,
		cwd: params.cwd,
		parentAgentId: params.parentAgentId,
		taskPath: params.taskPath,
		agentName: agent?.name ?? params.agentName,
		agentSource: agent?.source ?? (definition ? "inline" : "none"),
		agentDefinition: definition,
		contextMode,
		contextTurns: params.contextTurns,
		contextSummary,
		writeMode: params.writeMode,
		allowedPaths: params.allowedPaths,
		timeoutMs: params.timeoutMs,
		maxOutputChars: params.maxOutputChars,
		model: routed.model,
		thinkingLevel: routed.thinkingLevel,
		tools: agent?.tools,
		routingMode,
		routingProfile,
		routingDecision: routed.decision,
	}, signal);
}

function spawnedText(records: AgentRecord[]): string {
	if (records.length === 1) {
		const record = records[0];
		return `Spawned ${record.taskPath} (${record.status}). agentId=${record.agentId}`;
	}
	return [`Spawned ${records.length} subagents:`, ...records.map((record) => `- ${record.taskPath} (${record.status}). agentId=${record.agentId}`)].join("\n");
}

export function registerSpawnAgentTool(pi: ExtensionAPI, getManager: ManagerGetter): void {
	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description: "Spawn one or more Codex-style Pi subagents for concrete bounded tasks. Defaults to read-only and uses isolated RPC subprocesses.",
		promptSnippet: "Spawn bounded read-only or scoped child agents for one task, or tasks:[...] for several",
		promptGuidelines: [
			"Use spawn_agent only for concrete independent subtasks that materially advance the user's request.",
			"Use one spawn_agent call with tasks:[...] or spawn_agents_on_jsonl/csv when spawning multiple independent subagents; do not emit several spawn_agent tool calls in the same assistant response.",
			"Use spawn_agent with writeMode=read_only unless the user explicitly wants a child to modify files and a safe scope is provided.",
			"After spawn_agent, use wait_agent or list_agents to inspect subagent progress; use followup_task for additional work.",
		],
		parameters: SpawnAgentParams,
		async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
			const manager = getManager(ctx);
			const spawnParams = expandSpawnParams(params);
			await confirmWriteCapability(ctx, spawnParams);
			onUpdate?.(textResult(spawnParams.length === 1 ? `Spawning subagent ${spawnParams[0].taskName}...` : `Spawning ${spawnParams.length} subagents...`));
			const records: AgentRecord[] = [];
			for (const item of spawnParams) records.push(await spawnOne(ctx, manager, item, signal));
			return textResult(spawnedText(records), records.length === 1 ? records[0] : { records });
		},
		renderCall(args: any, theme) {
			if (Array.isArray(args.tasks)) {
				const previewTasks = args.tasks.slice(0, 3).map((task: any) => task.taskName).join(", ");
				const suffix = args.tasks.length > 3 ? ` +${args.tasks.length - 3}` : "";
				return new Text(`${theme.fg("toolTitle", theme.bold("spawn_agent "))}${theme.fg("accent", `${args.tasks.length} tasks`)} ${theme.fg("dim", `${previewTasks}${suffix}`)}`, 0, 0);
			}
			return new Text(`${theme.fg("toolTitle", theme.bold("spawn_agent "))}${theme.fg("accent", args.taskName ?? "...")} ${theme.fg("dim", preview(args.prompt, 70))}`, 0, 0);
		},
		renderResult(result: any, { expanded }, theme) {
			if (result.details?.agentId) return renderAgentSummary(result.details, theme, expanded);
			return new Text(result.content?.[0]?.text ?? "", 0, 0);
		},
	});
}
