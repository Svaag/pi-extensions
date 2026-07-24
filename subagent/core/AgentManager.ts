import type { AgentBackend, AgentHandle, BackendObservation, BackendSpawnRequest } from "./AgentBackend.ts";
import { AgentGraph } from "./AgentGraph.ts";
import type {
	AgentGraphEdge,
	AgentMetrics,
	AgentRecord,
	AgentResult,
	AgentStatus,
	AgentSummary,
	RoutingDecision,
	SpawnAgentRequest,
	WaitAgentOptions,
	WaitAgentResult,
} from "./AgentTypes.ts";
import { buildInheritedContext } from "./ContextSanitizer.ts";
import { DEFAULT_SUBAGENT_LIMITS, normalizeLimits, normalizeRuntimeTimeoutMs, type SubagentLimits } from "./Limits.ts";
import { buildChildSystemPrompt, buildChildUserPrompt } from "./prompt.ts";
import { StateStore } from "./StateStore.ts";
import { NOOP_SUBAGENT_TELEMETRY } from "../telemetry/NoopTelemetry.ts";
import { mergeCumulativeAgentMetrics } from "../telemetry/Usage.ts";
import type { SubagentTelemetry, TelemetryDeliveryMode, TelemetryMessageKind, TelemetryOutcome, TelemetryTurnKind } from "../telemetry/Telemetry.ts";
import {
	appendOutputTail,
	childTaskPath,
	createId,
	normalizeTaskPath,
	isTerminalStatus,
	nowMs,
	recordAgeMs,
	resolveCwd,
	resolvePathList,
	shallowCloneRecord,
	statusDurationMs,
	summarizeText,
	taskDepth,
	truncateMiddle,
} from "./utils.ts";

interface PendingStartConfig {
	agentDefinition?: string;
	contextSummary?: string;
	timeoutMs: number;
	maxOutputChars: number;
	maxPersistedOutputTailChars: number;
}

export interface AgentManagerOptions {
	backend: AgentBackend;
	store: StateStore;
	rootCwd: string;
	limits?: Partial<SubagentLimits>;
	restoredRecords?: AgentRecord[];
	restoredEdges?: AgentGraphEdge[];
	restoredLostAgentIds?: string[];
	onChange?: (manager: AgentManager) => void;
	telemetry?: SubagentTelemetry;
}

export interface MessageDeliveryResult {
	agentId: string;
	delivered: boolean;
	queued: boolean;
	deliveryMode: "rpc_steer" | "mailbox_only" | "unavailable";
	message: string;
}

export interface FollowupTaskResult {
	agentId: string;
	spawnedAgentId?: string;
	delivered: boolean;
	queued: boolean;
	deliveryMode: "rpc_follow_up" | "rpc_prompt" | "spawn_followup" | "unavailable";
	message: string;
}

export interface FollowupSpawnOptions {
	contextMode?: SpawnAgentRequest["contextMode"];
	model?: string;
	thinkingLevel?: SpawnAgentRequest["thinkingLevel"];
	routingMode?: SpawnAgentRequest["routingMode"];
	routingProfile?: SpawnAgentRequest["routingProfile"];
	routingDecision?: RoutingDecision;
	inheritModelAndThinking?: boolean;
}

function inheritedRoutingDecision(record: AgentRecord, selectedModel: string | undefined, selectedThinkingLevel: SpawnAgentRequest["thinkingLevel"]): RoutingDecision | undefined {
	const base = record.routingDecision;
	const candidates = (base?.candidates ?? []).map((candidate) => ({ ...candidate, notes: [...(candidate.notes ?? [])] }));
	if (!base && !selectedModel && !selectedThinkingLevel) return undefined;
	return {
		mode: base?.mode ?? record.routingMode ?? "auto",
		objective: base?.objective ?? record.routingProfile ?? "balanced",
		applied: Boolean(selectedModel || selectedThinkingLevel),
		reason: "inherited",
		selectedModel,
		selectedThinkingLevel,
		explicitModel: base?.explicitModel,
		explicitThinkingLevel: base?.explicitThinkingLevel,
		intent: base?.intent ?? "scout",
		risk: base?.risk ?? 0,
		complexity: base?.complexity ?? 0,
		complexityTier: base?.complexityTier ?? "simple",
		complexityScore: base?.complexityScore ?? base?.complexity ?? 0,
		confidence: base?.confidence ?? 0,
		classificationReason: base?.classificationReason ?? "Inherited from parent subagent.",
		signals: [...(base?.signals ?? []), "followup-inherited"],
		classifierUsed: base?.classifierUsed,
		classifierModel: base?.classifierModel,
		estimatedInputTokens: base?.estimatedInputTokens ?? 0,
		estimatedOutputTokens: base?.estimatedOutputTokens ?? 0,
		explanation: "Spawned follow-up inherited model and thinking level from the parent subagent.",
		candidates,
	};
}

export class AgentManager {
	readonly limits: SubagentLimits;
	private readonly backend: AgentBackend;
	private readonly store: StateStore;
	private readonly rootCwd: string;
	private readonly graph: AgentGraph;
	private readonly records = new Map<string, AgentRecord>();
	private readonly handles = new Map<string, AgentHandle>();
	private readonly pendingStart = new Map<string, PendingStartConfig>();
	private readonly waiters = new Set<() => void>();
	private readonly timeoutHandles = new Map<string, NodeJS.Timeout>();
	private readonly timeoutRecoveryHandles = new Map<string, NodeJS.Timeout>();
	private readonly lastOutputPersistAt = new Map<string, number>();
	private readonly activeTurnIds = new Map<string, string>();
	private readonly activeTurnKinds = new Map<string, TelemetryTurnKind>();
	private readonly activeTurnStartedAt = new Map<string, number>();
	private readonly firstProgressTurnIds = new Set<string>();
	private readonly firstProgressAt = new Map<string, number>();
	private readonly processSpawnedAt = new Map<string, number>();
	private readonly runtimeRecoveryStartedAt = new Map<string, number>();
	private readonly telemetry: SubagentTelemetry;
	private readonly onChange?: (manager: AgentManager) => void;

	constructor(options: AgentManagerOptions) {
		this.backend = options.backend;
		this.store = options.store;
		this.rootCwd = options.rootCwd;
		this.limits = normalizeLimits(options.limits ?? DEFAULT_SUBAGENT_LIMITS);
		this.graph = new AgentGraph(options.restoredEdges ?? []);
		for (const record of options.restoredRecords ?? []) this.records.set(record.agentId, shallowCloneRecord(record));
		this.telemetry = options.telemetry ?? NOOP_SUBAGENT_TELEMETRY;
		this.onChange = options.onChange;
		this.persistRestoredLostAgents(options.restoredLostAgentIds ?? []);
	}

	listRecords(opts: { includeClosed?: boolean; parentAgentId?: string; jobId?: string } = {}): AgentRecord[] {
		return [...this.records.values()]
			.filter((record) => opts.includeClosed || record.status !== "closed")
			.filter((record) => opts.parentAgentId === undefined || record.parentAgentId === opts.parentAgentId)
			.filter((record) => opts.jobId === undefined || record.jobId === opts.jobId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(shallowCloneRecord);
	}

	listEdges(): AgentGraphEdge[] {
		return this.graph.list();
	}

	getRecord(agentId: string): AgentRecord | undefined {
		const record = this.records.get(agentId);
		return record ? shallowCloneRecord(record) : undefined;
	}

	async spawnAgent(request: SpawnAgentRequest, signal?: AbortSignal): Promise<AgentRecord> {
		const now = nowMs();
		const openCount = [...this.records.values()].filter((record) => record.status !== "closed").length;
		if (this.records.size >= this.limits.maxAgentsTotal) throw new Error(`maxAgentsTotal reached (${this.limits.maxAgentsTotal})`);
		if (openCount >= this.limits.maxOpenAgents) throw new Error(`maxOpenAgents reached (${this.limits.maxOpenAgents})`);
		if (request.writeMode === "git_worktree") throw new Error("writeMode=git_worktree is not implemented yet.");

		const parent = request.parentAgentId ? this.records.get(request.parentAgentId) : undefined;
		if (request.parentAgentId && !parent) throw new Error(`Unknown parentAgentId: ${request.parentAgentId}`);
		const taskPath = request.taskPath ? normalizeTaskPath(request.taskPath) : childTaskPath(parent?.taskPath, request.taskName);
		if (taskDepth(taskPath) > this.limits.maxDepth) throw new Error(`maxDepth reached (${this.limits.maxDepth}) for ${taskPath}`);
		if (request.prompt.length > this.limits.maxTaskPromptChars) throw new Error(`prompt exceeds maxTaskPromptChars (${this.limits.maxTaskPromptChars})`);

		const cwd = resolveCwd(this.rootCwd, request.cwd, this.limits.allowedCwdRoots);
		const writeMode = request.writeMode ?? "read_only";
		const allowedPaths = resolvePathList(cwd, request.allowedPaths);
		let tools = request.tools ? [...request.tools] : undefined;
		if (writeMode === "read_only" && tools) tools = tools.filter((tool) => tool !== "edit" && tool !== "write");
		const timeoutMs = normalizeRuntimeTimeoutMs(request.timeoutMs, this.limits);
		const agentId = createId("agent");
		const record: AgentRecord = {
			agentId,
			taskName: request.taskName,
			taskPath,
			parentAgentId: parent?.agentId ?? null,
			jobId: request.jobId,
			status: "queued",
			processState: "not_started",
			cwd,
			prompt: request.prompt,
			model: request.model,
			thinkingLevel: request.thinkingLevel,
			tools,
			timeoutMs,
			routingMode: request.routingMode,
			routingProfile: request.routingProfile,
			routingDecision: request.routingDecision,
			createdAt: now,
			updatedAt: now,
			contextMode: request.contextMode ?? "fresh",
			writeMode,
			allowedPaths,
			outputTail: "",
			outputChars: 0,
			controllable: false,
			agentName: request.agentName,
			agentSource: request.agentSource ?? "none",
		};
		this.records.set(agentId, record);
		this.observeTelemetry((telemetry) => {
			telemetry.agentQueued(this.telemetryDescriptor(record));
			if (record.routingDecision) telemetry.routingResolved({
				agentId: record.agentId,
				mode: record.routingDecision.mode,
				profile: record.routingDecision.objective,
				intent: record.routingDecision.intent,
				complexityTier: record.routingDecision.complexityTier,
				complexityScore: record.routingDecision.complexityScore,
				selectedModel: record.routingDecision.selectedModel,
				selectedThinkingLevel: record.routingDecision.selectedThinkingLevel,
				estimatedInputTokens: record.routingDecision.estimatedInputTokens,
				estimatedOutputTokens: record.routingDecision.estimatedOutputTokens,
				applied: record.routingDecision.applied,
				at: now,
			});
		});
		this.pendingStart.set(agentId, {
			agentDefinition: request.agentDefinition,
			contextSummary: request.contextSummary,
			timeoutMs,
			maxOutputChars: request.maxOutputChars ?? this.limits.maxOutputCharsPerAgent,
			maxPersistedOutputTailChars: this.limits.maxPersistedOutputTailChars,
		});

		this.store.appendEvent("agent.spawned", { agentId, parentAgentId: record.parentAgentId, taskPath, data: { taskName: record.taskName } });
		this.store.appendAgentState(record);
		const edge = this.graph.openEdge(record);
		this.store.appendEvent("graph.edge_opened", { agentId, parentAgentId: record.parentAgentId, childAgentId: agentId, taskPath, data: { edge } });
		this.store.appendEdgeState(edge);
		this.notifyChange();
		void this.startQueued(signal);
		return shallowCloneRecord(record);
	}

	async sendMessage(agentId: string, content: string, kind = "message"): Promise<MessageDeliveryResult> {
		const record = this.requireRecord(agentId);
		const handle = this.handles.get(agentId);
		const messageEvent = {
			id: createId("msg"),
			from: "/root",
			to: record.taskPath,
			role: "parent" as const,
			kind: "message" as const,
			content,
			createdAt: nowMs(),
		};

		if (record.status === "running" && handle?.isAlive()) {
			await handle.sendMessage(content);
			this.store.appendEvent("agent.message", { agentId, taskPath: record.taskPath, data: { ...messageEvent, delivered: true, deliveryMode: "rpc_steer", kind } });
			this.recordMessageTelemetry(agentId, kind, "rpc_steer", true, false, messageEvent.createdAt);
			return { agentId, delivered: true, queued: false, deliveryMode: "rpc_steer", message: "Message delivered via RPC steer." };
		}

		const mode = handle?.isAlive() ? "mailbox_only" : "unavailable";
		this.store.appendEvent("agent.message", { agentId, taskPath: record.taskPath, data: { ...messageEvent, delivered: false, deliveryMode: mode, kind } });
		this.recordMessageTelemetry(agentId, kind, mode, false, mode === "mailbox_only", messageEvent.createdAt);
		return {
			agentId,
			delivered: false,
			queued: mode === "mailbox_only",
			deliveryMode: mode,
			message: mode === "mailbox_only" ? "Message recorded in the parent-side mailbox; it does not trigger a turn." : "Agent is not live/controllable; message was recorded only.",
		};
	}

	async followupTask(agentId: string, prompt: string, mode: "live_if_supported" | "spawn_followup" = "live_if_supported", spawnOptions: FollowupSpawnOptions = {}): Promise<FollowupTaskResult> {
		const record = this.requireRecord(agentId);
		const handle = this.handles.get(agentId);
		this.store.appendEvent("agent.followup", { agentId, taskPath: record.taskPath, data: { prompt: truncateMiddle(prompt, 2000), mode } });

		if (mode === "live_if_supported" && record.status === "running" && handle?.isAlive()) {
			await handle.followupTask(prompt);
			this.recordMessageTelemetry(agentId, "followup", "rpc_follow_up", true, true);
			return { agentId, delivered: true, queued: true, deliveryMode: "rpc_follow_up", message: "Follow-up queued via RPC follow_up." };
		}
		if (mode === "live_if_supported" && (record.status === "succeeded" || record.status === "failed") && handle?.isAlive()) {
			const startedAt = nowMs();
			this.transition(record, "running", { processState: "live_running", controllable: true, startedAt, finishedAt: undefined, error: undefined });
			this.beginTurn(record, "live_followup", startedAt);
			await handle.prompt(prompt);
			this.recordMessageTelemetry(agentId, "followup", "rpc_prompt", true, false, startedAt);
			return { agentId, delivered: true, queued: false, deliveryMode: "rpc_prompt", message: "Follow-up started on the existing live agent." };
		}
		if (mode === "spawn_followup") {
			const inheritModelAndThinking = spawnOptions.inheritModelAndThinking ?? true;
			const model = spawnOptions.model ?? (inheritModelAndThinking ? record.model : undefined);
			const thinkingLevel = spawnOptions.thinkingLevel ?? (inheritModelAndThinking ? record.thinkingLevel : undefined);
			const routingMode = spawnOptions.routingMode ?? (inheritModelAndThinking ? record.routingMode : undefined);
			const routingProfile = spawnOptions.routingProfile ?? (inheritModelAndThinking ? record.routingProfile : undefined);
			const routingDecision = spawnOptions.routingDecision ?? (inheritModelAndThinking ? inheritedRoutingDecision(record, model, thinkingLevel) : undefined);
			const spawned = await this.spawnAgent({
				taskName: `${record.taskName}-followup`,
				prompt,
				parentAgentId: agentId,
				cwd: record.cwd,
				contextMode: spawnOptions.contextMode ?? "summary",
				contextSummary: record.result?.summary ?? record.outputTail,
				writeMode: record.writeMode,
				allowedPaths: record.allowedPaths,
				model,
				thinkingLevel,
				tools: record.tools,
				routingMode,
				routingProfile,
				routingDecision,
			});
			this.recordMessageTelemetry(agentId, "followup", "spawn_followup", true, spawned.status === "queued");
			return { agentId, spawnedAgentId: spawned.agentId, delivered: true, queued: spawned.status === "queued", deliveryMode: "spawn_followup", message: `Spawned follow-up agent ${spawned.agentId}.` };
		}
		this.recordMessageTelemetry(agentId, "followup", "unavailable", false, false);
		return { agentId, delivered: false, queued: false, deliveryMode: "unavailable", message: "Agent is not live. Use mode=spawn_followup to create a follow-up child." };
	}

	async interruptAgent(agentId: string, reason?: string): Promise<AgentRecord> {
		const record = this.requireRecord(agentId);
		const handle = this.handles.get(agentId);
		if (handle?.isAlive()) await handle.interrupt(reason);
		this.clearAgentTimeout(agentId);
		this.handles.delete(agentId);
		const finishedAt = nowMs();
		const previousMetrics = record.result?.metrics;
		const turnMetrics = this.completedTurnMetrics(record, undefined, finishedAt);
		this.ensureInterruptedResult(record, reason, finishedAt);
		if (this.activeTurnIds.has(record.agentId)) record.result!.metrics = mergeCumulativeAgentMetrics(previousMetrics, turnMetrics, { outputChars: record.outputChars });
		this.transition(record, "interrupted", { processState: "killed", controllable: false, finishedAt, error: reason ?? "Interrupted by parent agent." });
		const outcome: TelemetryOutcome = reason?.toLowerCase().includes("timed out") ? "timeout" : "interrupted";
		this.finishRuntimeRecovery(record, outcome, finishedAt, reason);
		this.finishTurn(record, outcome, finishedAt, reason, turnMetrics);
		this.recordAgentCompletion(record, outcome, finishedAt, reason);
		const edge = this.graph.closeEdge(agentId, "interrupted");
		this.store.appendEvent("agent.interrupted", { agentId, taskPath: record.taskPath, data: { reason, result: record.result, outputTail: record.outputTail.slice(-this.limits.maxPersistedOutputTailChars) } });
		if (edge) {
			this.store.appendEvent("graph.edge_closed", { agentId, parentAgentId: record.parentAgentId, childAgentId: agentId, taskPath: record.taskPath, data: { edge } });
			this.store.appendEdgeState(edge);
		}
		void this.startQueued();
		return shallowCloneRecord(record);
	}

	async closeAgent(agentId: string, reason?: string): Promise<AgentRecord> {
		const record = this.requireRecord(agentId);
		const handle = this.handles.get(agentId);
		if (handle?.isAlive()) await handle.close(reason);
		this.clearAgentTimeout(agentId);
		this.handles.delete(agentId);
		const hadActiveTurn = this.activeTurnIds.has(agentId);
		const closedAt = hadActiveTurn ? nowMs() : record.finishedAt ?? nowMs();
		const turnMetrics = this.completedTurnMetrics(record, undefined, closedAt);
		if (hadActiveTurn) {
			record.result = { agentId, status: "interrupted", summary: reason ?? "Closed by parent agent.", output: record.outputTail, metrics: mergeCumulativeAgentMetrics(record.result?.metrics, turnMetrics, { outputChars: record.outputChars }) };
		}
		this.transition(record, "closed", { processState: "killed", controllable: false, finishedAt: closedAt, error: record.error });
		this.finishTurn(record, "closed", closedAt, reason, turnMetrics);
		if (hadActiveTurn) this.recordAgentCompletion(record, "closed", closedAt, reason);
		const edge = this.graph.closeEdge(agentId, "closed");
		this.store.appendEvent("agent.closed", { agentId, taskPath: record.taskPath, data: { reason } });
		if (edge) {
			this.store.appendEvent("graph.edge_closed", { agentId, parentAgentId: record.parentAgentId, childAgentId: agentId, taskPath: record.taskPath, data: { edge } });
			this.store.appendEdgeState(edge);
		}
		void this.startQueued();
		return shallowCloneRecord(record);
	}

	async shutdownAll(reason = "session shutdown"): Promise<void> {
		const handles = [...this.handles.entries()];
		await Promise.allSettled(handles.map(async ([agentId, handle]) => {
			if (handle.isAlive()) await handle.close(reason);
			const record = this.records.get(agentId);
			if (record && record.status === "running") {
				const lostAt = nowMs();
				const turnMetrics = this.completedTurnMetrics(record, undefined, lostAt);
				if (this.activeTurnIds.has(record.agentId)) {
					record.result = { agentId, status: "interrupted", summary: reason, output: record.outputTail, metrics: mergeCumulativeAgentMetrics(record.result?.metrics, turnMetrics, { outputChars: record.outputChars }) };
				}
				this.transition(record, "lost", { processState: "unknown", controllable: false, finishedAt: lostAt, error: reason });
				this.finishRuntimeRecovery(record, "lost", lostAt, reason);
				this.finishTurn(record, "lost", lostAt, reason, turnMetrics);
				this.recordAgentCompletion(record, "lost", lostAt, reason);
			}
		}));
		this.handles.clear();
		for (const timeout of this.timeoutHandles.values()) clearTimeout(timeout);
		this.timeoutHandles.clear();
		for (const timeout of this.timeoutRecoveryHandles.values()) clearTimeout(timeout);
		this.timeoutRecoveryHandles.clear();
	}

	async wait(options: WaitAgentOptions): Promise<WaitAgentResult> {
		const timeoutMs = options.timeoutMs ?? 60_000;
		const returnMode = options.returnMode ?? "summary";
		const targets = this.resolveWaitTargets(options);
		const deadline = nowMs() + timeoutMs;
		while (targets.some((id) => {
			const record = this.records.get(id);
			return record && !isTerminalStatus(record.status) && record.status !== "succeeded" && record.status !== "failed";
		})) {
			const remaining = deadline - nowMs();
			if (remaining <= 0) break;
			await this.waitForChange(Math.min(remaining, 1000));
		}
		const timedOut = targets.some((id) => {
			const record = this.records.get(id);
			return record?.status === "queued" || record?.status === "running";
		});
		return { agents: targets.map((id) => this.summaryFor(this.requireRecord(id), returnMode)), timedOut };
	}

	summaries(opts: { includeClosed?: boolean; parentAgentId?: string; jobId?: string; returnMode?: "summary" | "full" | "events" } = {}): AgentSummary[] {
		return this.listRecords(opts).map((record) => this.summaryFor(record, opts.returnMode ?? "summary"));
	}

	private persistRestoredLostAgents(agentIds: string[]): void {
		for (const agentId of agentIds) {
			const record = this.records.get(agentId);
			if (!record || record.status !== "lost") continue;
			this.observeTelemetry((telemetry) => {
				telemetry.agentQueued(this.telemetryDescriptor(record));
				telemetry.agentCompleted({ agentId, status: "lost", processState: "unknown", controllable: false, outcome: "lost", at: record.updatedAt, outputChars: record.outputChars, error: record.error });
				telemetry.processExited({ agentId, status: "lost", processState: "unknown", controllable: false, at: record.updatedAt, error: record.error });
			});
			this.store.appendEvent("agent.lost", { agentId, taskPath: record.taskPath, data: { error: record.error, restored: true } });
			this.store.appendAgentState(record);
			const edge = this.graph.closeEdge(agentId, "lost");
			if (edge) {
				this.store.appendEvent("graph.edge_lost", { agentId, parentAgentId: record.parentAgentId, childAgentId: agentId, taskPath: record.taskPath, data: { edge, restored: true } });
				this.store.appendEdgeState(edge);
			}
		}
	}

	private async startQueued(signal?: AbortSignal): Promise<void> {
		while (this.runningCount() < this.limits.maxAgentsRunning) {
			const next = [...this.records.values()].find((record) => record.status === "queued");
			if (!next) return;
			await this.startAgent(next, signal);
		}
	}

	private async startAgent(record: AgentRecord, signal?: AbortSignal): Promise<void> {
		const config = this.pendingStart.get(record.agentId);
		if (!config) return;
		this.pendingStart.delete(record.agentId);
		const parentRecords = record.parentAgentId ? [this.requireRecord(record.parentAgentId)] : [];
		let inheritedContext = "";
		try {
			inheritedContext = buildInheritedContext({ mode: record.contextMode, contextSummary: config.contextSummary, parentRecords });
		} catch (error) {
			this.failBeforeStart(record, error instanceof Error ? error.message : String(error));
			return;
		}
		const systemPrompt = buildChildSystemPrompt({ record, agentDefinition: config.agentDefinition, inheritedContext, maxTaskPromptChars: this.limits.maxTaskPromptChars });
		const userPrompt = buildChildUserPrompt(record);
		const backendRequest: BackendSpawnRequest = {
			record,
			systemPrompt,
			userPrompt,
			policy: {
				agentId: record.agentId,
				writeMode: record.writeMode,
				allowedPaths: record.allowedPaths,
				cwd: record.cwd,
				maxOutputChars: config.maxOutputChars,
			},
			timeoutMs: config.timeoutMs,
			maxOutputChars: config.maxOutputChars,
		};

		const startedAt = nowMs();
		this.transition(record, "running", { processState: "live_running", controllable: true, startedAt });
		this.beginTurn(record, "initial", startedAt);
		this.observeTelemetry((telemetry) => telemetry.agentStarted({ agentId: record.agentId, status: record.status, processState: record.processState, controllable: record.controllable, at: startedAt }));
		this.store.appendEvent("agent.started", { agentId: record.agentId, taskPath: record.taskPath });
		this.installAgentTimeout(record.agentId, config.timeoutMs);
		try {
			const handle = await this.backend.spawn(backendRequest, {
				onStarted: () => this.markStarted(record.agentId),
				onOutput: (text) => this.appendOutput(record.agentId, text, config.maxOutputChars, config.maxPersistedOutputTailChars),
				onObservation: (observation) => this.handleBackendObservation(record.agentId, observation),
				onResult: (result) => this.completeAgent(record.agentId, result),
				onError: (error) => this.failAgent(record.agentId, error),
				onExit: (exitCode, closeSignal) => this.onExit(record.agentId, exitCode, closeSignal),
			}, signal);
			this.handles.set(record.agentId, handle);
		} catch (error) {
			this.failAgent(record.agentId, error instanceof Error ? error : new Error(String(error)));
		}
	}

	private markStarted(agentId: string): void {
		const record = this.records.get(agentId);
		if (!record || record.status !== "running") return;
		record.startedAt = record.startedAt ?? nowMs();
		record.processState = "live_running";
		record.controllable = true;
		record.updatedAt = nowMs();
		if (!this.activeTurnIds.has(agentId)) this.beginTurn(record, "live_followup", record.updatedAt);
		this.store.appendAgentState(record);
		this.notifyChange();
	}

	private appendOutput(agentId: string, text: string, maxOutputChars: number, maxPersistedTail: number): void {
		const record = this.records.get(agentId);
		if (!record) return;
		record.outputChars += text.length;
		record.outputTail = appendOutputTail(record.outputTail, text, maxOutputChars);
		record.updatedAt = nowMs();
		const last = this.lastOutputPersistAt.get(agentId) ?? 0;
		if (record.updatedAt - last > 1500) {
			this.lastOutputPersistAt.set(agentId, record.updatedAt);
			this.store.appendEvent("agent.output_tail", { agentId, taskPath: record.taskPath, data: { outputTail: record.outputTail.slice(-maxPersistedTail), outputChars: record.outputChars } });
			this.store.appendAgentState(record);
			this.notifyChange();
			return;
		}
		this.notifyChange(false);
	}

	private completeAgent(agentId: string, result: AgentResult): void {
		const record = this.records.get(agentId);
		if (!record) return;
		this.clearAgentTimeout(agentId);
		const status: AgentStatus = result.status;
		const finishedAt = nowMs();
		const turnMetrics = this.completedTurnMetrics(record, result.metrics, finishedAt);
		const cumulativeMetrics = mergeCumulativeAgentMetrics(record.result?.metrics, turnMetrics, { outputChars: record.outputChars });
		record.result = { ...result, metrics: cumulativeMetrics };
		if (result.output && !record.outputTail.trim()) {
			record.outputTail = appendOutputTail("", result.output, this.limits.maxOutputCharsPerAgent);
		} else if (result.output && !record.outputTail.includes(result.output)) {
			record.outputTail = appendOutputTail(record.outputTail, `\n${result.output}`, this.limits.maxOutputCharsPerAgent);
		}
		if (status === "interrupted") this.ensureInterruptedResult(record, result.summary, finishedAt);
		this.transition(record, status, { processState: "live_idle", controllable: this.handles.get(agentId)?.isAlive() ?? true, finishedAt, error: status === "failed" ? result.summary : undefined });
		const outcome: TelemetryOutcome = status === "succeeded" ? "succeeded" : status === "interrupted" ? "interrupted" : "failed";
		this.finishRuntimeRecovery(record, outcome, finishedAt, status === "succeeded" ? undefined : result.summary);
		this.finishTurn(record, outcome, finishedAt, status === "succeeded" ? undefined : result.summary, turnMetrics);
		this.recordAgentCompletion(record, outcome, finishedAt, status === "succeeded" ? undefined : result.summary);
		this.store.appendEvent(status === "succeeded" ? "agent.succeeded" : status === "interrupted" ? "agent.interrupted" : "agent.failed", {
			agentId,
			taskPath: record.taskPath,
			data: { result: record.result, outputTail: record.outputTail.slice(-this.limits.maxPersistedOutputTailChars) },
		});
		if (status === "failed" || status === "interrupted") {
			const edge = this.graph.closeEdge(agentId, status === "failed" ? "failed" : "interrupted");
			if (edge) {
				this.store.appendEvent("graph.edge_closed", { agentId, parentAgentId: record.parentAgentId, childAgentId: agentId, taskPath: record.taskPath, data: { edge } });
				this.store.appendEdgeState(edge);
			}
		}
		void this.startQueued();
	}

	private ensureInterruptedResult(record: AgentRecord, reason: string | undefined, finishedAt: number): void {
		const existing = record.result;
		const abortLike = !existing || !existing.output || /^Request was aborted\.?$/i.test(existing.summary.trim());
		if (!abortLike) return;
		const output = existing?.output || record.outputTail;
		const recovered = output.trim().length > 0;
		const timedOut = reason?.toLowerCase().includes("timed out") ?? false;
		const summary = recovered
			? `${timedOut ? "Timed out" : "Interrupted"}; recovered ${record.outputChars} chars of partial output in output/outputTail.`
			: reason ?? "Interrupted before a final answer was produced.";
		record.result = {
			agentId: record.agentId,
			status: "interrupted",
			summary,
			output,
			metrics: { ...existing?.metrics, durationMs: statusDurationMs({ ...record, finishedAt }, finishedAt), outputChars: record.outputChars },
		};
	}

	private failBeforeStart(record: AgentRecord, message: string): void {
		const failedAt = nowMs();
		this.transition(record, "failed", { processState: "exited", controllable: false, finishedAt: failedAt, error: message });
		this.finishTurn(record, "failed", failedAt, message);
		this.recordAgentCompletion(record, "failed", failedAt, message);
		this.observeTelemetry((telemetry) => telemetry.processExited({ agentId: record.agentId, status: record.status, processState: record.processState, controllable: false, at: failedAt, error: message }));
		this.store.appendEvent("agent.failed", { agentId: record.agentId, taskPath: record.taskPath, data: { error: message } });
		const edge = this.graph.closeEdge(record.agentId, "failed");
		if (edge) this.store.appendEdgeState(edge);
	}

	private failAgent(agentId: string, error: Error): void {
		const record = this.records.get(agentId);
		if (!record) return;
		this.clearAgentTimeout(agentId);
		if (record.status === "closed" || record.status === "interrupted" || record.status === "failed") return;
		const failedAt = nowMs();
		const turnMetrics = this.completedTurnMetrics(record, undefined, failedAt);
		if (this.activeTurnIds.has(record.agentId)) {
			record.result = {
				agentId,
				status: "failed",
				summary: error.message,
				output: record.outputTail,
				metrics: mergeCumulativeAgentMetrics(record.result?.metrics, turnMetrics, { outputChars: record.outputChars }),
			};
		}
		this.transition(record, "failed", { processState: "exited", controllable: false, finishedAt: failedAt, error: error.message });
		this.finishRuntimeRecovery(record, "failed", failedAt, error);
		this.finishTurn(record, "failed", failedAt, error, turnMetrics);
		this.recordAgentCompletion(record, "failed", failedAt, error);
		this.store.appendEvent("agent.failed", { agentId, taskPath: record.taskPath, data: { error: error.message, outputTail: record.outputTail.slice(-this.limits.maxPersistedOutputTailChars) } });
		const edge = this.graph.closeEdge(agentId, "failed");
		if (edge) {
			this.store.appendEvent("graph.edge_closed", { agentId, parentAgentId: record.parentAgentId, childAgentId: agentId, taskPath: record.taskPath, data: { edge } });
			this.store.appendEdgeState(edge);
		}
		void this.startQueued();
	}

	private onExit(agentId: string, exitCode: number | null, closeSignal: NodeJS.Signals | null): void {
		const record = this.records.get(agentId);
		if (!record) return;
		record.exitCode = exitCode ?? undefined;
		const exitError = record.status === "running" || record.status === "queued" ? new Error(`Child process exited before completion (${closeSignal ?? exitCode ?? "unknown"})`) : undefined;
		if (exitError) this.failAgent(agentId, exitError);
		record.processState = record.processState === "killed" ? "killed" : "exited";
		record.controllable = false;
		if (record.result?.metrics) record.result.metrics.exitCode = record.exitCode;
		record.updatedAt = nowMs();
		this.observeTelemetry((telemetry) => telemetry.processExited({ agentId, status: record.status, processState: record.processState, controllable: false, at: record.updatedAt, exitCode: exitCode ?? undefined, signal: closeSignal ?? undefined, error: exitError }));
		this.store.appendAgentState(record);
		this.notifyChange();
	}

	private installAgentTimeout(agentId: string, timeoutMs: number): void {
		this.clearAgentTimeout(agentId);
		const timeout = setTimeout(() => {
			void this.requestTimeoutRecovery(agentId, timeoutMs);
		}, timeoutMs);
		timeout.unref?.();
		this.timeoutHandles.set(agentId, timeout);
	}

	private async requestTimeoutRecovery(agentId: string, timeoutMs: number): Promise<void> {
		this.timeoutHandles.delete(agentId);
		const record = this.records.get(agentId);
		if (!record || record.status !== "running") return;
		const graceMs = Math.max(0, this.limits.timeoutRecoveryGraceMs);
		const reason = `Timed out after ${timeoutMs} ms`;
		record.error = graceMs > 0 ? `${reason}; requested a final partial summary before hard abort.` : reason;
		record.updatedAt = nowMs();
		this.runtimeRecoveryStartedAt.set(agentId, record.updatedAt);
		this.observeTelemetry((telemetry) => telemetry.recovery({ agentId, turnId: this.activeTurnIds.get(agentId), type: "runtime_timeout", phase: "started", at: record.updatedAt }));
		this.store.appendEvent("agent.timeout_recovery", { agentId, taskPath: record.taskPath, data: { timeoutMs, graceMs, outputTail: record.outputTail.slice(-this.limits.maxPersistedOutputTailChars) } });
		this.store.appendAgentState(record);
		this.notifyChange();

		if (graceMs <= 0) {
			void this.interruptAgent(agentId, reason);
			return;
		}
		const hardTimeout = setTimeout(() => {
			void this.interruptAgent(agentId, `${reason}; recovery grace ${graceMs} ms expired`);
		}, graceMs);
		hardTimeout.unref?.();
		this.timeoutRecoveryHandles.set(agentId, hardTimeout);

		const handle = this.handles.get(agentId);
		if (handle?.isAlive()) {
			try {
				await handle.sendMessage("TIME BUDGET EXPIRED. Stop running tools now. Return a concise final answer using only what you already inspected. Include partial findings, useful file paths, commands/results seen, uncertainty, and next recommended checks. Do not call any more tools.");
			} catch {
				// Hard timeout above still preserves outputTail if steering cannot be delivered.
			}
		}
	}

	private handleBackendObservation(agentId: string, observation: BackendObservation): void {
		const turnId = this.activeTurnIds.get(agentId);
		this.observeTelemetry((telemetry) => {
			switch (observation.kind) {
				case "process.spawned":
					this.processSpawnedAt.set(agentId, observation.at);
					telemetry.processSpawned({ agentId, at: observation.at, pid: observation.pid });
					break;
				case "process.exited":
					// onExit records the authoritative manager state and terminal process observation.
					break;
				case "rpc.started":
					telemetry.rpcStarted({ agentId, turnId, requestId: observation.requestId, command: observation.command, at: observation.at });
					break;
				case "rpc.completed":
					telemetry.rpcCompleted({ agentId, turnId, requestId: observation.requestId, command: observation.command, at: observation.at, durationMs: observation.durationMs, outcome: observation.success ? "succeeded" : "failed", error: observation.error });
					break;
				case "model.first_output":
					if (!turnId || !this.firstProgressTurnIds.has(turnId)) {
						if (turnId) {
							this.firstProgressTurnIds.add(turnId);
							this.firstProgressAt.set(turnId, observation.at);
						}
						telemetry.agentFirstProgress(agentId, observation.at);
					}
					break;
				case "tool.started":
					telemetry.toolStarted({ agentId, turnId, toolCallId: observation.toolCallId, toolName: observation.toolName, at: observation.at });
					break;
				case "tool.completed":
					telemetry.toolCompleted({ agentId, turnId, toolCallId: observation.toolCallId, toolName: observation.toolName, at: observation.at, durationMs: observation.durationMs, outcome: observation.success ? "succeeded" : "failed", resultChars: observation.resultChars, resultTruncated: observation.resultTruncated, error: observation.error });
					break;
				case "compaction.started":
					telemetry.recovery({ agentId, turnId, type: "compaction", phase: "started", at: observation.at });
					break;
				case "compaction.completed":
					telemetry.recovery({ agentId, turnId, type: "compaction", phase: "completed", at: observation.at, durationMs: observation.durationMs, outcome: observation.success ? "succeeded" : "failed", error: observation.error });
					break;
				case "context_overflow.detected":
					telemetry.recovery({ agentId, turnId, type: "context_overflow", phase: "started", at: observation.at });
					break;
				case "context_overflow.recovery":
					telemetry.recovery({ agentId, turnId, type: "context_overflow", phase: observation.phase, at: observation.at, durationMs: observation.durationMs, outcome: observation.phase === "completed" ? observation.success ? "succeeded" : "failed" : undefined, error: observation.error });
					break;
				case "rpc.malformed":
					telemetry.protocolError({ agentId, at: observation.at, error: observation.error });
					break;
				case "provider.error":
					telemetry.providerError({ agentId, turnId, at: observation.at, error: observation.error });
					break;
			}
		});
	}

	private telemetryDescriptor(record: AgentRecord) {
		return {
			agentId: record.agentId,
			parentAgentId: record.parentAgentId,
			jobId: record.jobId,
			taskPath: record.taskPath,
			projectPath: this.rootCwd,
			model: record.model,
			thinkingLevel: record.thinkingLevel,
			routingMode: record.routingMode,
			routingProfile: record.routingProfile,
			intent: record.routingDecision?.intent,
			complexityTier: record.routingDecision?.complexityTier,
			complexityScore: record.routingDecision?.complexityScore,
			writeMode: record.writeMode,
			contextMode: record.contextMode,
			promptChars: record.prompt.length,
			createdAt: record.createdAt,
		};
	}

	private beginTurn(record: AgentRecord, kind: TelemetryTurnKind, at = nowMs()): string {
		const existing = this.activeTurnIds.get(record.agentId);
		if (existing) return existing;
		const turnId = createId("turn");
		this.activeTurnIds.set(record.agentId, turnId);
		this.activeTurnKinds.set(record.agentId, kind);
		this.activeTurnStartedAt.set(turnId, at);
		this.observeTelemetry((telemetry) => telemetry.turnStarted({ agentId: record.agentId, turnId, kind, at }));
		return turnId;
	}

	private completedTurnMetrics(record: AgentRecord, supplied: AgentMetrics | undefined, at: number): AgentMetrics {
		const turnId = this.activeTurnIds.get(record.agentId);
		const turnStartedAt = turnId ? this.activeTurnStartedAt.get(turnId) : undefined;
		const firstProgressAt = turnId ? this.firstProgressAt.get(turnId) : undefined;
		const processSpawnedAt = this.processSpawnedAt.get(record.agentId);
		return {
			...supplied,
			durationMs: turnStartedAt === undefined ? supplied?.durationMs : Math.max(0, at - turnStartedAt),
			queueDurationMs: supplied?.queueDurationMs ?? (record.startedAt ? Math.max(0, record.startedAt - record.createdAt) : undefined),
			startupDurationMs: supplied?.startupDurationMs ?? (processSpawnedAt !== undefined && record.startedAt ? Math.max(0, processSpawnedAt - record.startedAt) : undefined),
			firstProgressMs: supplied?.firstProgressMs ?? (firstProgressAt !== undefined && turnStartedAt !== undefined ? Math.max(0, firstProgressAt - turnStartedAt) : undefined),
			turns: supplied?.turns ?? 1,
		};
	}

	private finishTurn(record: AgentRecord, outcome: TelemetryOutcome, at = nowMs(), error?: unknown, metrics: AgentMetrics = this.completedTurnMetrics(record, undefined, at)): void {
		const turnId = this.activeTurnIds.get(record.agentId);
		if (!turnId) return;
		this.activeTurnIds.delete(record.agentId);
		const kind = this.activeTurnKinds.get(record.agentId) ?? "initial";
		this.activeTurnKinds.delete(record.agentId);
		this.activeTurnStartedAt.delete(turnId);
		this.firstProgressTurnIds.delete(turnId);
		this.firstProgressAt.delete(turnId);
		this.observeTelemetry((telemetry) => telemetry.turnCompleted({
			agentId: record.agentId,
			turnId,
			kind,
			at,
			outcome,
			durationMs: metrics.durationMs,
			outputChars: metrics.outputChars,
			toolCalls: metrics.toolCalls,
			providerRequests: metrics.providerRequests,
			compactions: metrics.compactions,
			inputTokens: metrics.inputTokens,
			outputTokens: metrics.outputTokens,
			cacheReadTokens: metrics.cacheReadTokens,
			cacheWriteTokens: metrics.cacheWriteTokens,
			totalTokens: metrics.totalTokens,
			costUsd: metrics.costUsd,
			error,
		}));
	}

	private recordAgentCompletion(record: AgentRecord, outcome: TelemetryOutcome, at = nowMs(), error?: unknown): void {
		const metrics = record.result?.metrics;
		this.observeTelemetry((telemetry) => telemetry.agentCompleted({
			agentId: record.agentId,
			status: record.status,
			processState: record.processState,
			controllable: record.controllable,
			outcome,
			at,
			outputChars: record.outputChars,
			durationMs: metrics?.durationMs ?? statusDurationMs(record, at),
			queueDurationMs: metrics?.queueDurationMs ?? (record.startedAt ? Math.max(0, record.startedAt - record.createdAt) : undefined),
			startupDurationMs: metrics?.startupDurationMs,
			firstProgressMs: metrics?.firstProgressMs,
			turns: metrics?.turns,
			toolCalls: metrics?.toolCalls,
			providerRequests: metrics?.providerRequests,
			compactions: metrics?.compactions,
			inputTokens: metrics?.inputTokens,
			outputTokens: metrics?.outputTokens,
			cacheReadTokens: metrics?.cacheReadTokens,
			cacheWriteTokens: metrics?.cacheWriteTokens,
			totalTokens: metrics?.totalTokens,
			costUsd: metrics?.costUsd,
			error,
		}));
	}

	private finishRuntimeRecovery(record: AgentRecord, outcome: TelemetryOutcome, at = nowMs(), error?: unknown): void {
		const startedAt = this.runtimeRecoveryStartedAt.get(record.agentId);
		if (startedAt === undefined) return;
		this.runtimeRecoveryStartedAt.delete(record.agentId);
		this.observeTelemetry((telemetry) => telemetry.recovery({
			agentId: record.agentId,
			turnId: this.activeTurnIds.get(record.agentId),
			type: "runtime_timeout",
			phase: "completed",
			outcome,
			at,
			durationMs: Math.max(0, at - startedAt),
			error,
		}));
	}

	private recordMessageTelemetry(agentId: string, kind: string, deliveryMode: TelemetryDeliveryMode, delivered: boolean, queued: boolean, at = nowMs()): void {
		const normalizedKind: TelemetryMessageKind = kind === "correction" || kind === "constraint" || kind === "note" || kind === "followup" ? kind : "message";
		this.observeTelemetry((telemetry) => telemetry.messageDelivered({ agentId, kind: normalizedKind, deliveryMode, delivered, queued, at }));
	}

	private observeTelemetry(observe: (telemetry: SubagentTelemetry) => void): void {
		try { observe(this.telemetry); } catch { /* telemetry must never alter agent behavior */ }
	}

	private clearAgentTimeout(agentId: string): void {
		const timeout = this.timeoutHandles.get(agentId);
		if (timeout) clearTimeout(timeout);
		this.timeoutHandles.delete(agentId);
		const recoveryTimeout = this.timeoutRecoveryHandles.get(agentId);
		if (recoveryTimeout) clearTimeout(recoveryTimeout);
		this.timeoutRecoveryHandles.delete(agentId);
	}

	private transition(record: AgentRecord, status: AgentStatus, patch: Partial<AgentRecord> = {}): void {
		Object.assign(record, patch);
		record.status = status;
		record.updatedAt = nowMs();
		this.store.appendAgentState(record);
		this.notifyChange();
	}

	private runningCount(): number {
		return [...this.records.values()].filter((record) => record.status === "running").length;
	}

	private resolveWaitTargets(options: WaitAgentOptions): string[] {
		if (options.all) return this.listRecords({ includeClosed: false }).map((record) => record.agentId);
		const ids = options.agentIds?.length ? options.agentIds : options.agentId ? [options.agentId] : [];
		if (ids.length === 0) throw new Error("wait_agent requires agentId, agentIds, or all=true");
		for (const id of ids) this.requireRecord(id);
		return ids;
	}

	private summaryFor(record: AgentRecord, returnMode: "summary" | "full" | "events" = "summary"): AgentSummary {
		const now = nowMs();
		const resultOutput = returnMode === "full" ? record.result?.output : undefined;
		return {
			agentId: record.agentId,
			taskName: record.taskName,
			taskPath: record.taskPath,
			parentAgentId: record.parentAgentId,
			status: record.status,
			processState: record.processState,
			cwd: record.cwd,
			createdAt: record.createdAt,
			startedAt: record.startedAt,
			finishedAt: record.finishedAt,
			updatedAt: record.updatedAt,
			ageMs: recordAgeMs(record, now),
			durationMs: statusDurationMs(record, now),
			controllable: record.controllable,
			outputTail: returnMode === "full" ? record.outputTail : summarizeText(record.outputTail, 600),
			summary: record.result?.summary,
			output: resultOutput,
			error: record.error,
			metrics: {
				...record.result?.metrics,
				durationMs: record.result?.metrics?.durationMs ?? statusDurationMs(record, now),
				outputChars: record.outputChars,
				exitCode: record.exitCode,
			},
			model: record.model,
			thinkingLevel: record.thinkingLevel,
			routingDecision: record.routingDecision,
		};
	}

	private waitForChange(timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				this.waiters.delete(done);
				resolve();
			}, timeoutMs);
			const done = () => {
				clearTimeout(timeout);
				this.waiters.delete(done);
				resolve();
			};
			this.waiters.add(done);
		});
	}

	private notifyChange(runHook = true): void {
		for (const waiter of [...this.waiters]) waiter();
		if (runHook) this.onChange?.(this);
	}

	private requireRecord(agentId: string): AgentRecord {
		const record = this.records.get(agentId);
		if (!record) throw new Error(`Unknown agentId: ${agentId}`);
		return record;
	}
}
