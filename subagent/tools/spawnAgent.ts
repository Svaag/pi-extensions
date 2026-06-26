import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig, type AgentScope } from "../agents.ts";
import type { ContextMode, WriteMode } from "../core/AgentTypes.ts";
import { sanitizeContextText } from "../core/ContextSanitizer.ts";
import { renderAgentSummary } from "../render/renderAgent.ts";
import { type ManagerGetter, preview, textResult } from "./common.ts";

const SpawnAgentParams = Type.Object({
	taskName: Type.String({ description: "Short lowercase-ish task name for the child agent." }),
	prompt: Type.String({ description: "Delegated task prompt." }),
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
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum runtime for the delegated task." })),
	maxOutputChars: Type.Optional(Type.Number({ description: "Maximum retained output characters for this agent." })),
	model: Type.Optional(Type.String({ description: "Optional model override for the child process." })),
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
		const filePath = resolve(ctx.cwd, String(params.agentDefinitionFile).replace(/^@/, ""));
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

export function registerSpawnAgentTool(pi: ExtensionAPI, getManager: ManagerGetter): void {
	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description: "Spawn a Codex-style Pi subagent for a concrete bounded task. Defaults to read-only and uses an isolated RPC subprocess.",
		promptSnippet: "Spawn bounded read-only or scoped child agents for parallel work",
		promptGuidelines: [
			"Use spawn_agent only for concrete independent subtasks that materially advance the user's request.",
			"Use spawn_agent with writeMode=read_only unless the user explicitly wants a child to modify files and a safe scope is provided.",
			"After spawn_agent, use wait_agent or list_agents to inspect subagent progress; use followup_task for additional work.",
		],
		parameters: SpawnAgentParams,
		async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
			const manager = getManager(ctx);
			const writeMode: WriteMode = params.writeMode ?? "read_only";
			if (writeMode !== "read_only" && ctx.hasUI) {
				const ok = await ctx.ui.confirm("Spawn write-capable subagent?", `Task: ${params.taskName}\nwriteMode=${writeMode}\n\nParallel write-capable agents can conflict. Continue?`);
				if (!ok) throw new Error("Write-capable subagent was not approved.");
			}
			const { definition, agent } = await resolveAgentDefinition(ctx, params);
			const contextMode = (params.contextMode ?? "fresh") as ContextMode;
			const contextSummary = params.contextSummary ?? (contextMode === "summary" ? buildVisibleSessionSummary(ctx) : undefined);
			onUpdate?.(textResult(`Spawning subagent ${params.taskName}...`));
			const record = await manager.spawnAgent({
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
				writeMode,
				allowedPaths: params.allowedPaths,
				timeoutMs: params.timeoutMs,
				maxOutputChars: params.maxOutputChars,
				model: params.model ?? agent?.model,
				tools: agent?.tools,
			}, signal);
			return textResult(`Spawned ${record.taskPath} (${record.status}). agentId=${record.agentId}`, record);
		},
		renderCall(args: any, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("spawn_agent "))}${theme.fg("accent", args.taskName ?? "...")} ${theme.fg("dim", preview(args.prompt, 70))}`, 0, 0);
		},
		renderResult(result: any, { expanded }, theme) {
			return result.details ? renderAgentSummary(result.details, theme, expanded) : new Text(result.content?.[0]?.text ?? "", 0, 0);
		},
	});
}
