import type { AgentBackend, AgentHandle, BackendSpawnRequest } from "./AgentBackend.ts";
import { AgentGraph } from "./AgentGraph.ts";
import type {
	AgentGraphEdge,
	AgentRecord,
	AgentResult,
	AgentStatus,
	AgentSummary,
	SpawnAgentRequest,
	WaitAgentOptions,
	WaitAgentResult,
} from "./AgentTypes.ts";
import { buildInheritedContext } from "./ContextSanitizer.ts";
import { DEFAULT_SUBAGENT_LIMITS, normalizeLimits, normalizeRuntimeTimeoutMs, type SubagentLimits } from "./Limits.ts";
import { buildChildSystemPrompt, buildChildUserPrompt } from "./prompt.ts";
import { StateStore } from "./StateStore.ts";
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
	private readonly onChange?: (manager: AgentManager) => void;

	constructor(options: AgentManagerOptions) {
		this.backend = options.backend;
		this.store = options.store;
		this.rootCwd = options.rootCwd;
		this.limits = normalizeLimits(options.limits ?? DEFAULT_SUBAGENT_LIMITS);
		this.graph = new AgentGraph(options.restoredEdges ?? []);
		for (const record of options.restoredRecords ?? []) this.records.set(record.agentId, shallowCloneRecord(record));
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
			return { agentId, delivered: true, queued: false, deliveryMode: "rpc_steer", message: "Message delivered via RPC steer." };
		}

		const mode = handle?.isAlive() ? "mailbox_only" : "unavailable";
		this.store.appendEvent("agent.message", { agentId, taskPath: record.taskPath, data: { ...messageEvent, delivered: false, deliveryMode: mode, kind } });
		return {
			agentId,
			delivered: false,
			queued: mode === "mailbox_only",
			deliveryMode: mode,
			message: mode === "mailbox_only" ? "Message recorded in the parent-side mailbox; it does not trigger a turn." : "Agent is not live/controllable; message was recorded only.",
		};
	}

	async followupTask(agentId: string, prompt: string, mode: "live_if_supported" | "spawn_followup" = "live_if_supported"): Promise<FollowupTaskResult> {
		const record = this.requireRecord(agentId);
		const handle = this.handles.get(agentId);
		this.store.appendEvent("agent.followup", { agentId, taskPath: record.taskPath, data: { prompt: truncateMiddle(prompt, 2000), mode } });

		if (record.status === "running" && handle?.isAlive()) {
			await handle.followupTask(prompt);
			return { agentId, delivered: true, queued: true, deliveryMode: "rpc_follow_up", message: "Follow-up queued via RPC follow_up." };
		}
		if ((record.status === "succeeded" || record.status === "failed") && handle?.isAlive()) {
			this.transition(record, "running", { processState: "live_running", controllable: true, startedAt: nowMs(), finishedAt: undefined, error: undefined });
			await handle.prompt(prompt);
			return { agentId, delivered: true, queued: false, deliveryMode: "rpc_prompt", message: "Follow-up started on the existing live agent." };
		}
		if (mode === "spawn_followup") {
			const spawned = await this.spawnAgent({
				taskName: `${record.taskName}-followup`,
				prompt,
				parentAgentId: agentId,
				cwd: record.cwd,
				contextMode: "summary",
				contextSummary: record.result?.summary ?? record.outputTail,
				writeMode: record.writeMode,
				allowedPaths: record.allowedPaths,
				model: record.model,
				thinkingLevel: record.thinkingLevel,
				tools: record.tools,
				routingMode: record.routingMode,
				routingProfile: record.routingProfile,
				routingDecision: record.routingDecision,
			});
			return { agentId, spawnedAgentId: spawned.agentId, delivered: true, queued: spawned.status === "queued", deliveryMode: "spawn_followup", message: `Spawned follow-up agent ${spawned.agentId}.` };
		}
		return { agentId, delivered: false, queued: false, deliveryMode: "unavailable", message: "Agent is not live. Use mode=spawn_followup to create a follow-up child." };
	}

	async interruptAgent(agentId: string, reason?: string): Promise<AgentRecord> {
		const record = this.requireRecord(agentId);
		const handle = this.handles.get(agentId);
		if (handle?.isAlive()) await handle.interrupt(reason);
		this.clearAgentTimeout(agentId);
		this.handles.delete(agentId);
		const finishedAt = nowMs();
		this.ensureInterruptedResult(record, reason, finishedAt);
		this.transition(record, "interrupted", { processState: "killed", controllable: false, finishedAt, error: reason ?? "Interrupted by parent agent." });
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
		this.transition(record, "closed", { processState: "killed", controllable: false, finishedAt: record.finishedAt ?? nowMs(), error: record.error });
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
			if (record && record.status === "running") this.transition(record, "lost", { processState: "unknown", controllable: false, finishedAt: nowMs(), error: reason });
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

		this.transition(record, "running", { processState: "live_running", controllable: true, startedAt: nowMs() });
		this.store.appendEvent("agent.started", { agentId: record.agentId, taskPath: record.taskPath });
		this.installAgentTimeout(record.agentId, config.timeoutMs);
		try {
			const handle = await this.backend.spawn(backendRequest, {
				onStarted: () => this.markStarted(record.agentId),
				onOutput: (text) => this.appendOutput(record.agentId, text, config.maxOutputChars, config.maxPersistedOutputTailChars),
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
		}
		this.notifyChange(false);
	}

	private completeAgent(agentId: string, result: AgentResult): void {
		const record = this.records.get(agentId);
		if (!record) return;
		this.clearAgentTimeout(agentId);
		const status: AgentStatus = result.status;
		const finishedAt = nowMs();
		record.result = { ...result, metrics: { ...result.metrics, durationMs: statusDurationMs({ ...record, finishedAt }, finishedAt), outputChars: record.outputChars } };
		if (result.output && !record.outputTail.trim()) {
			record.outputTail = appendOutputTail("", result.output, this.limits.maxOutputCharsPerAgent);
		} else if (result.output && !record.outputTail.includes(result.output)) {
			record.outputTail = appendOutputTail(record.outputTail, `\n${result.output}`, this.limits.maxOutputCharsPerAgent);
		}
		if (status === "interrupted") this.ensureInterruptedResult(record, result.summary, finishedAt);
		this.transition(record, status, { processState: "live_idle", controllable: this.handles.get(agentId)?.isAlive() ?? true, finishedAt, error: status === "failed" ? result.summary : undefined });
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
		this.transition(record, "failed", { processState: "exited", controllable: false, finishedAt: nowMs(), error: message });
		this.store.appendEvent("agent.failed", { agentId: record.agentId, taskPath: record.taskPath, data: { error: message } });
		const edge = this.graph.closeEdge(record.agentId, "failed");
		if (edge) this.store.appendEdgeState(edge);
	}

	private failAgent(agentId: string, error: Error): void {
		const record = this.records.get(agentId);
		if (!record) return;
		this.clearAgentTimeout(agentId);
		if (record.status === "closed" || record.status === "interrupted") return;
		this.transition(record, "failed", { processState: "exited", controllable: false, finishedAt: nowMs(), error: error.message });
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
		if (record.status === "running" || record.status === "queued") {
			this.failAgent(agentId, new Error(`Child process exited before completion (${closeSignal ?? exitCode ?? "unknown"})`));
			return;
		}
		record.processState = record.processState === "killed" ? "killed" : "exited";
		record.controllable = false;
		record.updatedAt = nowMs();
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
				durationMs: statusDurationMs(record, now),
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
