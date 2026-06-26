import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { AgentManager } from "./core/AgentManager.ts";
import { SubprocessRpcBackend } from "./core/SubprocessRpcBackend.ts";
import { StateStore } from "./core/StateStore.ts";
import { formatDuration, statusColor, statusIcon } from "./render/renderAgent.ts";
import { registerCloseAgentTool } from "./tools/closeAgent.ts";
import { registerFollowupTaskTool } from "./tools/followupTask.ts";
import { registerInterruptAgentTool } from "./tools/interruptAgent.ts";
import { registerListAgentsTool } from "./tools/listAgents.ts";
import { registerSendMessageTool } from "./tools/sendMessage.ts";
import { registerSpawnAgentTool } from "./tools/spawnAgent.ts";
import { registerWaitAgentTool } from "./tools/waitAgent.ts";

const CHILD_POLICY_PATH = fileURLToPath(new URL("./child-policy.ts", import.meta.url));

export default function subagentExtension(pi: ExtensionAPI): void {
	let manager: AgentManager | undefined;
	let activeContext: ExtensionContext | undefined;

	function renderWidget(ctx: ExtensionContext, current: AgentManager): void {
		const agents = current.summaries({ includeClosed: false }).slice(-8);
		if (agents.length === 0) {
			ctx.ui.setStatus("subagent", undefined);
			ctx.ui.setWidget("subagent-agents", undefined);
			return;
		}
		const running = agents.filter((agent) => agent.status === "running").length;
		const queued = agents.filter((agent) => agent.status === "queued").length;
		ctx.ui.setStatus("subagent", ctx.ui.theme.fg(running > 0 ? "warning" : "accent", `🤖 ${running}${queued ? `+${queued}` : ""}`));
		const lines = [ctx.ui.theme.fg("accent", "Subagents")];
		for (const agent of agents) {
			const icon = ctx.ui.theme.fg(statusColor(agent.status), statusIcon(agent.status));
			const duration = formatDuration(agent.durationMs);
			const brief = agent.summary || agent.error || agent.outputTail || "";
			lines.push(`${icon} ${ctx.ui.theme.fg("accent", agent.taskPath)} ${ctx.ui.theme.fg("muted", `[${agent.status}${duration ? ` ${duration}` : ""}]`)}`);
			if (brief) lines.push(ctx.ui.theme.fg("dim", `  ${brief.replace(/\s+/g, " ").slice(0, 100)}`));
		}
		ctx.ui.setWidget("subagent-agents", lines);
	}

	function initialize(ctx: ExtensionContext): AgentManager {
		activeContext = ctx;
		const restored = StateStore.restore(ctx.sessionManager.getBranch());
		manager = new AgentManager({
			backend: new SubprocessRpcBackend(CHILD_POLICY_PATH),
			store: new StateStore({ appendEntry: (customType, data) => pi.appendEntry(customType, data) }),
			rootCwd: ctx.cwd,
			restoredRecords: restored.records,
			restoredEdges: restored.edges,
			onChange: (current) => {
				if (activeContext) renderWidget(activeContext, current);
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

	registerSpawnAgentTool(pi, getManager);
	registerWaitAgentTool(pi, getManager);
	registerSendMessageTool(pi, getManager);
	registerFollowupTaskTool(pi, getManager);
	registerListAgentsTool(pi, getManager);
	registerInterruptAgentTool(pi, getManager);
	registerCloseAgentTool(pi, getManager);

	pi.registerCommand("subagents", {
		description: "Show subagent status",
		handler: async (_args, ctx) => {
			const current = getManager(ctx);
			renderWidget(ctx, current);
			const agents = current.summaries({ includeClosed: true });
			if (agents.length === 0) ctx.ui.notify("No subagents in this session.", "info");
			else ctx.ui.notify(agents.map((agent) => `${agent.taskPath}: ${agent.status}${agent.summary ? ` — ${agent.summary}` : ""}`).join("\n"), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		initialize(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		activeContext = undefined;
		if (manager) await manager.shutdownAll("session shutdown");
		manager = undefined;
		ctx.ui.setStatus("subagent", undefined);
		ctx.ui.setWidget("subagent-agents", undefined);
	});
}
