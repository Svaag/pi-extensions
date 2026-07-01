import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { AgentManager } from "./core/AgentManager.ts";
import { BatchJobManager } from "./core/BatchJobManager.ts";
import { SubprocessRpcBackend } from "./core/SubprocessRpcBackend.ts";
import { StateStore } from "./core/StateStore.ts";
import { formatDuration } from "./render/agentFormat.ts";
import { renderSubagentWidgetLines, subagentStatusSummary } from "./render/renderSubagentWidget.ts";
import { registerCancelAgentJobTool } from "./tools/cancelAgentJob.ts";
import { registerCloseAgentTool } from "./tools/closeAgent.ts";
import { registerExportAgentJobResultsTool } from "./tools/exportAgentJobResults.ts";
import { registerFollowupTaskTool } from "./tools/followupTask.ts";
import { registerInterruptAgentTool } from "./tools/interruptAgent.ts";
import { registerListAgentGraphTool } from "./tools/listAgentGraph.ts";
import { registerListAgentJobsTool } from "./tools/listAgentJobs.ts";
import { registerListAgentsTool } from "./tools/listAgents.ts";
import { registerSendMessageTool } from "./tools/sendMessage.ts";
import { registerSpawnAgentTool } from "./tools/spawnAgent.ts";
import { registerSpawnAgentsOnCsvTool } from "./tools/spawnAgentsOnCsv.ts";
import { registerSpawnAgentsOnJsonlTool } from "./tools/spawnAgentsOnJsonl.ts";
import { registerWaitAgentTool } from "./tools/waitAgent.ts";
import { registerWaitAgentJobTool } from "./tools/waitAgentJob.ts";

const CHILD_POLICY_PATH = fileURLToPath(new URL("./child-policy.ts", import.meta.url));

export default function subagentExtension(pi: ExtensionAPI): void {
	let manager: AgentManager | undefined;
	let batchManager: BatchJobManager | undefined;
	let activeContext: ExtensionContext | undefined;

	function appendEntrySafe(customType: string, data?: unknown): void {
		try {
			pi.appendEntry(customType, data);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("ctx is stale") && !message.includes("Extension runtime not initialized")) {
				console.warn(`subagent: failed to append ${customType}: ${message}`);
			}
		}
	}

	function renderWidget(ctx: ExtensionContext, current: AgentManager): void {
		const agents = current.summaries({ includeClosed: false });
		const jobs = batchManager?.listJobs({ includeCompleted: false }) ?? [];
		const status = subagentStatusSummary(agents, jobs);
		ctx.ui.setStatus("subagent", status ? ctx.ui.theme.fg(status.color, status.text) : undefined);
		if (agents.length === 0 && jobs.length === 0) {
			ctx.ui.setWidget("subagent-agents", undefined);
			return;
		}
		ctx.ui.setWidget("subagent-agents", (_tui, theme) => ({
			invalidate() {},
			render(width: number) {
				return renderSubagentWidgetLines(agents, jobs, theme, width, { maxActiveRows: 5 });
			},
		}));
	}

	function initialize(ctx: ExtensionContext): AgentManager {
		activeContext = ctx;
		const branch = ctx.sessionManager.getBranch();
		const restored = StateStore.restore(branch);
		manager = new AgentManager({
			backend: new SubprocessRpcBackend(CHILD_POLICY_PATH),
			store: new StateStore({ appendEntry: appendEntrySafe }),
			rootCwd: ctx.cwd,
			restoredRecords: restored.records,
			restoredEdges: restored.edges,
			restoredLostAgentIds: restored.lostAgentIds,
			onChange: (current) => {
				if (activeContext) renderWidget(activeContext, current);
			},
		});
		batchManager = new BatchJobManager({
			agentManager: manager,
			appender: { appendEntry: appendEntrySafe },
			rootCwd: ctx.cwd,
			restoredJobs: BatchJobManager.restore(branch),
			onChange: () => {
				if (activeContext && manager) renderWidget(activeContext, manager);
			},
		});
		renderWidget(ctx, manager);
		return manager;
	}

	function getManager(ctx: ExtensionContext): AgentManager {
		if (!manager) return initialize(ctx);
		activeContext = ctx;
		return manager;
	}

	function getBatchManager(ctx: ExtensionContext): BatchJobManager {
		if (!manager || !batchManager) initialize(ctx);
		activeContext = ctx;
		return batchManager!;
	}

	registerSpawnAgentTool(pi, getManager);
	registerWaitAgentTool(pi, getManager);
	registerSendMessageTool(pi, getManager);
	registerFollowupTaskTool(pi, getManager);
	registerListAgentsTool(pi, getManager);
	registerListAgentGraphTool(pi, getManager);
	registerInterruptAgentTool(pi, getManager);
	registerCloseAgentTool(pi, getManager);
	registerSpawnAgentsOnCsvTool(pi, getBatchManager);
	registerSpawnAgentsOnJsonlTool(pi, getBatchManager);
	registerListAgentJobsTool(pi, getBatchManager);
	registerWaitAgentJobTool(pi, getBatchManager);
	registerCancelAgentJobTool(pi, getBatchManager);
	registerExportAgentJobResultsTool(pi, getBatchManager);

	pi.registerCommand("subagents", {
		description: "Show subagent status. Use /subagents graph for the persistent tree, /subagents full for summaries.",
		handler: async (args, ctx) => {
			const current = getManager(ctx);
			renderWidget(ctx, current);
			const mode = args.trim().toLowerCase();
			if (mode === "graph") {
				const records = current.listRecords({ includeClosed: true });
				const edges = current.listEdges();
				if (records.length === 0) ctx.ui.notify("No subagent graph in this session.", "info");
				else ctx.ui.notify(edges.map((edge) => `${edge.taskPath}: ${edge.status} parent=${edge.parentAgentId ?? "root"}`).join("\n") || "No graph edges.", "info");
				return;
			}
			const agents = current.summaries({ includeClosed: true });
			if (agents.length === 0) {
				ctx.ui.notify("No subagents in this session.", "info");
				return;
			}
			const includeSummaries = mode === "full" || mode === "verbose";
			const lines = agents.map((agent) => {
				const duration = formatDuration(agent.durationMs);
				const base = `${agent.taskPath}: ${agent.status}${duration ? ` ${duration}` : ""}`;
				if (!includeSummaries) return base;
				return `${base}${agent.summary ? ` — ${agent.summary}` : agent.error ? ` — ${agent.error}` : ""}`;
			});
			ctx.ui.notify(`${lines.join("\n")}\n\nTip: /subagents full shows summaries; /subagents graph shows the tree.`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		initialize(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		activeContext = undefined;
		batchManager = undefined;
		if (manager) await manager.shutdownAll("session shutdown");
		manager = undefined;
		ctx.ui.setStatus("subagent", undefined);
		ctx.ui.setWidget("subagent-agents", undefined);
	});
}
