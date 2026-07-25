import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelRoutingEngine, SqliteRouterStore, loadRouterConfig as loadSharedRouterConfig } from "@svaag/pi-model-router";
import { SubagentRouterAdapter, loadSubagentRouterAdapterSettings } from "@svaag/pi-model-router/subagent";
import { createOpenTelemetryRouterTelemetry, createRouterTelemetryPrivacy, NOOP_ROUTER_TELEMETRY } from "@svaag/pi-model-router/telemetry";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { registerAnalyzeSubagentTelemetryTool } from "./tools/analyzeSubagentTelemetry.ts";
import { registerRateAgentTool } from "./tools/rateAgent.ts";
import { installSubagentRouterAdapter } from "./tools/router.ts";
import { TelemetryAnalysisClient } from "./telemetry/AnalysisClient.ts";
import { loadSubagentTelemetryConfig, safeEndpointOrigin } from "./telemetry/Config.ts";
import { NOOP_SUBAGENT_TELEMETRY } from "./telemetry/NoopTelemetry.ts";
import type { SubagentTelemetry } from "./telemetry/Telemetry.ts";

const CHILD_POLICY_PATH = fileURLToPath(new URL("./child-policy.ts", import.meta.url));

export default function subagentExtension(pi: ExtensionAPI): void {
	let manager: AgentManager | undefined;
	let batchManager: BatchJobManager | undefined;
	let activeContext: ExtensionContext | undefined;
	let telemetry: SubagentTelemetry = NOOP_SUBAGENT_TELEMETRY;
	let telemetryHealthTimer: NodeJS.Timeout | undefined;
	let routingEngine: ModelRoutingEngine | undefined;
	let routerAdapter: SubagentRouterAdapter | undefined;
	const telemetryConfig = loadSubagentTelemetryConfig();

	async function initializeRouter(ctx: ExtensionContext): Promise<void> {
		if (routingEngine) await routingEngine.close().catch(() => undefined);
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		try {
			const trusted = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
			const loaded = loadSharedRouterConfig(ctx.cwd, { agentDir, configDirName: ".pi", projectTrusted: trusted });
			const privacy = await createRouterTelemetryPrivacy({ agentDir });
			const store = new SqliteRouterStore({
				path: loaded.config.storage.path ?? join(agentDir, "model-router", "router.db"),
				busyTimeoutMs: loaded.config.storage.busyTimeoutMs,
				halfLifeDays: loaded.config.learning.halfLifeDays,
				rawRetentionDays: loaded.config.learning.rawRetentionDays,
			});
			const routerTelemetry = loaded.config.telemetry.enabled
				? await createOpenTelemetryRouterTelemetry({ enabled: true, requestedEnabled: true }, { privacy })
				: NOOP_ROUTER_TELEMETRY;
			routingEngine = new ModelRoutingEngine({
				config: loaded.config,
				store,
				telemetry: routerTelemetry,
				hashProject: (projectKey) => privacy.hashIdentifier("project", projectKey),
			});
			const adapterSettings = loadSubagentRouterAdapterSettings(ctx.cwd, { agentDir, configDirName: ".pi", projectTrusted: trusted });
			routerAdapter = new SubagentRouterAdapter({ engine: routingEngine, config: loaded.config, ...adapterSettings });
			installSubagentRouterAdapter(routerAdapter);
		} catch {
			// Router setup must not block the promoted Subagent lifecycle. tools/router
			// will create a compute-only fallback that retains the current model.
			routingEngine = undefined;
			routerAdapter = undefined;
			installSubagentRouterAdapter(undefined);
			console.warn("subagent: shared router unavailable");
		}
	}

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

	function renderTelemetryStatus(ctx: ExtensionContext): void {
		const health = telemetry.getHealth();
		ctx.ui.setStatus("subagent-telemetry", health.enabled && health.degraded ? ctx.ui.theme.fg("error", `OTel degraded · ${health.droppedRecords} dropped`) : undefined);
	}

	function renderWidget(ctx: ExtensionContext, current: AgentManager): void {
		renderTelemetryStatus(ctx);
		const agents = current.summaries({ includeClosed: false });
		const jobs = batchManager?.listJobs({ includeCompleted: false }) ?? [];
		const status = subagentStatusSummary(agents, jobs);
		ctx.ui.setStatus("subagent", status ? ctx.ui.theme.fg(status.color as any, status.text) : undefined);
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
		telemetry.startSession({ sessionId: ctx.sessionManager.getSessionId(), projectPath: ctx.cwd });
		manager = new AgentManager({
			backend: new SubprocessRpcBackend(CHILD_POLICY_PATH),
			store: new StateStore({ appendEntry: appendEntrySafe }),
			rootCwd: ctx.cwd,
			restoredRecords: restored.records,
			restoredEdges: restored.edges,
			restoredLostAgentIds: restored.lostAgentIds,
			telemetry,
			onRouteTerminal: (observation) => routerAdapter?.observeTerminal(observation),
			onChange: (current) => {
				if (activeContext) renderWidget(activeContext, current);
			},
		});
		batchManager = new BatchJobManager({
			agentManager: manager,
			appender: { appendEntry: appendEntrySafe },
			rootCwd: ctx.cwd,
			restoredJobs: BatchJobManager.restore(branch),
			telemetry,
			forkRoutingDecision: async (decision, _item) => routerAdapter
				? await routerAdapter.forkBatchDecision(decision) as typeof decision
				: decision,
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
	registerAnalyzeSubagentTelemetryTool(pi, () => telemetryConfig);
	registerExportAgentJobResultsTool(pi, getBatchManager);
	registerRateAgentTool(pi, getManager);

	pi.registerCommand("subagents", {
		description: "Show subagent status. Use /subagents graph for the persistent tree, /subagents full for summaries.",
		handler: async (args, ctx) => {
			const current = getManager(ctx);
			renderWidget(ctx, current);
			const mode = args.trim().toLowerCase();
			if (mode === "telemetry" || mode === "otel") {
				const health = telemetry.getHealth();
				const availability = await new TelemetryAnalysisClient(telemetryConfig).probe();
				const issues = telemetryConfig.issues.length ? telemetryConfig.issues.map((issue) => `${issue.code}:${issue.field}`).join(", ") : "none";
				const lines = [
					`requested=${telemetryConfig.requestedEnabled} enabled=${health.enabled} degraded=${health.degraded}`,
					`collector=${safeEndpointOrigin(telemetryConfig.traces.endpoint)} sampleRatio=${telemetryConfig.traceSampleRatio}`,
					`lastExport=${health.lastSuccessfulExportAt ? new Date(health.lastSuccessfulExportAt).toISOString() : "never"} lastError=${health.lastErrorCategory ?? "none"} dropped=${health.droppedRecords}`,
					`prometheus=${availability.prometheus ? "available" : "unavailable"} (${safeEndpointOrigin(telemetryConfig.prometheusUrl)})`,
					`jaeger=${availability.jaeger ? "available" : "unavailable"} (${safeEndpointOrigin(telemetryConfig.jaegerUrl)})`,
					`configIssues=${issues}`,
				];
				ctx.ui.notify(lines.join("\n"), health.degraded || telemetryConfig.issues.length ? "warning" : "info");
				return;
			}
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
		telemetry = NOOP_SUBAGENT_TELEMETRY;
		if (telemetryConfig.enabled) {
			try {
				const { createOpenTelemetrySubagentTelemetry } = await import("./telemetry/OpenTelemetry.ts");
				telemetry = await createOpenTelemetrySubagentTelemetry(telemetryConfig);
			} catch {
				telemetry = NOOP_SUBAGENT_TELEMETRY;
			}
		}
		await initializeRouter(ctx);
		initialize(ctx);
		if (telemetryHealthTimer) clearInterval(telemetryHealthTimer);
		telemetryHealthTimer = setInterval(() => {
			if (activeContext) renderTelemetryStatus(activeContext);
		}, 10_000);
		telemetryHealthTimer.unref?.();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		activeContext = undefined;
		batchManager = undefined;
		if (telemetryHealthTimer) clearInterval(telemetryHealthTimer);
		telemetryHealthTimer = undefined;
		if (manager) await manager.shutdownAll("session shutdown");
		telemetry.endSession({ reason: "shutdown" });
		await telemetry.forceFlush();
		await telemetry.shutdown(5_000);
		telemetry = NOOP_SUBAGENT_TELEMETRY;
		installSubagentRouterAdapter(undefined);
		routerAdapter = undefined;
		await routingEngine?.close().catch(() => undefined);
		routingEngine = undefined;
		manager = undefined;
		ctx.ui.setStatus("subagent", undefined);
		ctx.ui.setStatus("subagent-telemetry", undefined);
		ctx.ui.setWidget("subagent-agents", undefined);
	});
}
