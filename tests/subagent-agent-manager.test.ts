import assert from "node:assert/strict";
import test from "node:test";
import type { AgentBackend, AgentBackendEvents, AgentHandle, BackendSpawnRequest } from "../subagent/core/AgentBackend.ts";
import { AgentManager } from "../subagent/core/AgentManager.ts";
import type { AgentResult } from "../subagent/core/AgentTypes.ts";
import { StateStore } from "../subagent/core/StateStore.ts";
import { NoopSubagentTelemetry } from "../subagent/telemetry/NoopTelemetry.ts";

class FakeHandle implements AgentHandle {
	readonly agentId: string;
	closed = false;
	messages: string[] = [];
	constructor(agentId: string) {
		this.agentId = agentId;
	}
	prompt(message: string): Promise<void> { this.messages.push(message); return Promise.resolve(); }
	sendMessage(message: string): Promise<void> { this.messages.push(message); return Promise.resolve(); }
	followupTask(message: string): Promise<void> { this.messages.push(message); return Promise.resolve(); }
	interrupt(_reason?: string): Promise<void> { this.closed = true; return Promise.resolve(); }
	close(_reason?: string): Promise<void> { this.closed = true; return Promise.resolve(); }
	isAlive(): boolean { return !this.closed; }
}

class FakeBackend implements AgentBackend {
	requests: BackendSpawnRequest[] = [];
	events = new Map<string, AgentBackendEvents>();
	handles = new Map<string, FakeHandle>();
	autoComplete = true;
	async spawn(request: BackendSpawnRequest, events: AgentBackendEvents): Promise<AgentHandle> {
		this.requests.push(request);
		this.events.set(request.record.agentId, events);
		events.onStarted?.();
		if (this.autoComplete) {
			queueMicrotask(() => events.onResult?.({ agentId: request.record.agentId, status: "succeeded", summary: "done", output: "done" } satisfies AgentResult));
		}
		const handle = new FakeHandle(request.record.agentId);
		this.handles.set(request.record.agentId, handle);
		return handle;
	}
}

class DeferredBackend implements AgentBackend {
	handle: FakeHandle | undefined;
	release: (() => void) | undefined;

	async spawn(request: BackendSpawnRequest, events: AgentBackendEvents): Promise<AgentHandle> {
		events.onStarted?.();
		this.handle = new FakeHandle(request.record.agentId);
		await new Promise<void>((resolve) => { this.release = resolve; });
		events.onResult?.({ agentId: request.record.agentId, status: "succeeded", summary: "late result" });
		return this.handle;
	}
}

class ExitOnCloseHandle extends FakeHandle {
	private readonly onExitCallback: () => void;
	constructor(agentId: string, onExit: () => void) {
		super(agentId);
		this.onExitCallback = onExit;
	}
	override close(): Promise<void> {
		this.closed = true;
		this.onExitCallback();
		return Promise.resolve();
	}
}

class ExitOnCloseBackend extends FakeBackend {
	override autoComplete = false;
	override async spawn(request: BackendSpawnRequest, events: AgentBackendEvents): Promise<AgentHandle> {
		this.requests.push(request);
		this.events.set(request.record.agentId, events);
		events.onStarted?.();
		const handle = new ExitOnCloseHandle(request.record.agentId, () => events.onExit?.(null, "SIGTERM"));
		this.handles.set(request.record.agentId, handle);
		return handle;
	}
}

function makeRecord(status: "queued" | "running" | "succeeded" | "failed" | "interrupted" | "closed" | "lost" = "running") {
	return {
		agentId: "agent_restored",
		taskName: "restored",
		taskPath: "/root/restored",
		parentAgentId: null,
		status,
		processState: status === "running" ? "live_running" as const : "unknown" as const,
		cwd: "/tmp",
		prompt: "do work",
		createdAt: 1,
		updatedAt: 2,
		contextMode: "fresh" as const,
		writeMode: "read_only" as const,
		allowedPaths: [],
		outputTail: "",
		outputChars: 0,
		controllable: status === "running",
	};
}

function manager(backend = new FakeBackend(), limits: any = {}, telemetry?: NoopSubagentTelemetry) {
	const entries: any[] = [];
	return {
		backend,
		entries,
		manager: new AgentManager({
			backend,
			store: new StateStore({ appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) }),
			rootCwd: "/tmp",
			limits: { maxAgentsRunning: 1, maxOpenAgents: 4, ...limits },
			telemetry,
		}),
	};
}

class RecordingTelemetry extends NoopSubagentTelemetry {
	events: string[] = [];
	override agentQueued(): void { this.events.push("agent.queued"); }
	override agentStarted(): void { this.events.push("agent.started"); }
	override turnStarted(): void { this.events.push("turn.started"); }
	override rpcStarted(): void { this.events.push("rpc.started"); }
	override rpcCompleted(): void { this.events.push("rpc.completed"); }
	override toolStarted(): void { this.events.push("tool.started"); }
	override toolCompleted(): void { this.events.push("tool.completed"); }
	override turnCompleted(): void { this.events.push("turn.completed"); }
	override agentCompleted(): void { this.events.push("agent.completed"); }
}

test("AgentManager maps backend observations into the telemetry lifecycle", async () => {
	const backend = new FakeBackend();
	backend.autoComplete = false;
	const telemetry = new RecordingTelemetry();
	const h = manager(backend, {}, telemetry);
	const record = await h.manager.spawnAgent({ taskName: "observed", prompt: "do it" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	backend.events.get(record.agentId)?.onObservation?.({ kind: "rpc.started", at: Date.now(), requestId: "rpc_1", command: "prompt" });
	backend.events.get(record.agentId)?.onObservation?.({ kind: "rpc.completed", at: Date.now(), requestId: "rpc_1", command: "prompt", durationMs: 1, success: true });
	backend.events.get(record.agentId)?.onObservation?.({ kind: "tool.started", at: Date.now(), toolCallId: "tool_1", toolName: "read" });
	backend.events.get(record.agentId)?.onObservation?.({ kind: "tool.completed", at: Date.now(), toolCallId: "tool_1", toolName: "read", success: true, resultChars: 10, resultTruncated: false });
	backend.events.get(record.agentId)?.onResult?.({ agentId: record.agentId, status: "succeeded", summary: "done", metrics: { turns: 1 } });
	await h.manager.wait({ agentId: record.agentId, timeoutMs: 1000 });
	assert.deepEqual(telemetry.events, ["agent.queued", "turn.started", "agent.started", "rpc.started", "rpc.completed", "tool.started", "tool.completed", "turn.completed", "agent.completed"]);
});

test("AgentManager lifecycle: spawn -> running -> succeeded", async () => {
	const h = manager();
	const record = await h.manager.spawnAgent({ taskName: "demo", prompt: "do it" });
	assert(["queued", "running"].includes(record.status));
	const waited = await h.manager.wait({ agentId: record.agentId, timeoutMs: 1000 });
	assert.equal(waited.timedOut, false);
	assert.equal(waited.agents[0].status, "succeeded");
	assert.equal(waited.agents[0].summary, "done");
});

test("AgentManager starts full_sanitized follow-ups instead of rejecting the context mode", async () => {
	const h = manager();
	const record = await h.manager.spawnAgent({
		taskName: "sanitized",
		prompt: "do it",
		contextMode: "full_sanitized",
		contextSummary: "TOKEN=secret-value useful parent finding",
	});
	const waited = await h.manager.wait({ agentId: record.agentId, timeoutMs: 1000 });
	assert.equal(waited.agents[0].status, "succeeded");
	assert.match(h.backend.requests[0].systemPrompt, /useful parent finding/);
	assert.doesNotMatch(h.backend.requests[0].systemPrompt, /secret-value/);
});

test("AgentManager does not cap closed session history", async () => {
	const h = manager(new FakeBackend(), { maxOpenAgents: 1 });
	for (let index = 0; index < 40; index += 1) {
		const record = await h.manager.spawnAgent({ taskName: `history-${index}`, prompt: "do it" });
		await h.manager.wait({ agentId: record.agentId, timeoutMs: 1000 });
		await h.manager.closeAgent(record.agentId, "test cleanup");
	}
	assert.equal(h.manager.listRecords({ includeClosed: true }).length, 40);
});

test("AgentManager reaps idle children before enforcing open-process capacity", async () => {
	const backend = new FakeBackend();
	const h = manager(backend, { maxOpenAgents: 1 });
	const first = await h.manager.spawnAgent({ taskName: "first", prompt: "do it" });
	await h.manager.wait({ agentId: first.agentId, timeoutMs: 1000 });
	await new Promise((resolve) => setTimeout(resolve, 10));
	const second = await h.manager.spawnAgent({ taskName: "second", prompt: "do it" });
	assert.equal(h.manager.getRecord(first.agentId)?.status, "closed");
	assert.notEqual(second.status, "closed");
});

test("AgentManager validates spawn requests before reaping idle children", async () => {
	const backend = new FakeBackend();
	const h = manager(backend, { maxOpenAgents: 1 });
	const first = await h.manager.spawnAgent({ taskName: "first", prompt: "do it" });
	await h.manager.wait({ agentId: first.agentId, timeoutMs: 1000 });
	await new Promise((resolve) => setTimeout(resolve, 10));
	await assert.rejects(() => h.manager.spawnAgent({ taskName: "invalid", prompt: "no", writeMode: "git_worktree" }), /not implemented/);
	assert.equal(h.manager.getRecord(first.agentId)?.status, "succeeded");
	assert.equal(backend.handles.get(first.agentId)?.isAlive(), true);
});

test("AgentManager automatically closes idle completed children", async () => {
	const backend = new FakeBackend();
	const h = manager(backend, { idleTtlMs: 10 });
	const record = await h.manager.spawnAgent({ taskName: "idle", prompt: "do it" });
	await h.manager.wait({ agentId: record.agentId, timeoutMs: 1000 });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(h.manager.getRecord(record.agentId)?.status, "closed");
	assert.equal(backend.handles.get(record.agentId)?.closed, true);
});

test("AgentManager suppresses expected exit failures while interrupting and shutting down", async () => {
	const interrupted = manager(new ExitOnCloseBackend());
	const interruptedRecord = await interrupted.manager.spawnAgent({ taskName: "interrupt", prompt: "do it" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	await interrupted.manager.interruptAgent(interruptedRecord.agentId, "stop");
	assert.equal(interrupted.manager.getRecord(interruptedRecord.agentId)?.status, "interrupted");
	assert.equal(interrupted.entries.some((entry) => entry.data?.type === "agent.failed"), false);

	const stopped = manager(new ExitOnCloseBackend());
	const stoppedRecord = await stopped.manager.spawnAgent({ taskName: "shutdown", prompt: "do it" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	await stopped.manager.shutdownAll("test shutdown");
	assert.equal(stopped.manager.getRecord(stoppedRecord.agentId)?.status, "lost");
	assert.equal(stopped.entries.some((entry) => entry.data?.type === "agent.failed"), false);
});

test("AgentManager closes a handle that resolves after shutdown", async () => {
	const backend = new DeferredBackend();
	const current = new AgentManager({
		backend,
		store: new StateStore({ appendEntry: () => undefined }),
		rootCwd: "/tmp",
	});
	const record = await current.spawnAgent({ taskName: "late", prompt: "do it" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	await current.shutdownAll("test shutdown");
	assert.equal(current.getRecord(record.agentId)?.status, "lost");
	backend.release?.();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(backend.handle?.closed, true);
	assert.equal(current.getRecord(record.agentId)?.status, "lost");
	await assert.rejects(() => current.spawnAgent({ taskName: "too-late", prompt: "no" }), /shutting down/);
});

test("AgentManager ignores too-short runtime timeouts", async () => {
	const backend = new FakeBackend();
	backend.autoComplete = false;
	const h = manager(backend);
	await h.manager.spawnAgent({ taskName: "demo", prompt: "do it", timeoutMs: 120_000 });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(backend.requests[0].timeoutMs, 30 * 60_000);
});

test("AgentManager stores routed model, thinking, and routing decision", async () => {
	const backend = new FakeBackend();
	backend.autoComplete = false;
	const h = manager(backend);
	const routingDecision: any = {
		mode: "auto",
		objective: "balanced",
		applied: true,
		reason: "selected",
		selectedModel: "local-llamacpp/local-model",
		selectedThinkingLevel: "off",
		intent: "lookup",
		risk: 0.1,
		complexity: 0.1,
		complexityTier: "trivial",
		complexityScore: 0.08,
		confidence: 0.8,
		classificationReason: "test classification",
		signals: ["lookup"],
		estimatedInputTokens: 1000,
		estimatedOutputTokens: 1000,
		explanation: "test",
		candidates: [],
	};
	const record = await h.manager.spawnAgent({
		taskName: "demo",
		prompt: "do it",
		model: "local-llamacpp/local-model",
		thinkingLevel: "off",
		routingMode: "auto",
		routingProfile: "balanced",
		routingDecision,
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(h.manager.getRecord(record.agentId)?.model, "local-llamacpp/local-model");
	assert.equal(h.manager.getRecord(record.agentId)?.thinkingLevel, "off");
	assert.equal(h.manager.summaries({ returnMode: "full" })[0].routingDecision?.reason, "selected");
	assert.equal(backend.requests[0].record.routingDecision?.selectedModel, "local-llamacpp/local-model");
});

test("AgentManager spawned follow-up inherits model, thinking, and records inherited routing", async () => {
	const backend = new FakeBackend();
	const h = manager(backend, { maxAgentsRunning: 2 });
	const parentRouting: any = {
		mode: "auto",
		objective: "balanced",
		applied: true,
		reason: "selected",
		selectedModel: "local-llamacpp/local-model",
		selectedThinkingLevel: "off",
		intent: "lookup",
		risk: 0,
		complexity: 0,
		complexityTier: "trivial",
		complexityScore: 0.05,
		confidence: 0.8,
		classificationReason: "lookup",
		signals: ["lookup"],
		estimatedInputTokens: 1000,
		estimatedOutputTokens: 1000,
		explanation: "test",
		candidates: [],
	};
	const parent = await h.manager.spawnAgent({ taskName: "demo", prompt: "do it", model: "local-llamacpp/local-model", thinkingLevel: "off", routingDecision: parentRouting });
	await h.manager.wait({ agentId: parent.agentId, timeoutMs: 1000 });
	const result = await h.manager.followupTask(parent.agentId, "check another file", "spawn_followup");
	const child = h.manager.getRecord(result.spawnedAgentId!)!;
	assert.equal(child.model, "local-llamacpp/local-model");
	assert.equal(child.thinkingLevel, "off");
	assert.equal(child.routingDecision?.reason, "inherited");
	assert.equal(child.routingDecision?.complexityTier, "trivial");
	assert.deepEqual(child.routingDecision?.signals.at(-1), "followup-inherited");
});

test("AgentManager spawned follow-up can use routed overrides instead of inheriting", async () => {
	const backend = new FakeBackend();
	const h = manager(backend, { maxAgentsRunning: 2 });
	const parent = await h.manager.spawnAgent({ taskName: "demo", prompt: "do it", model: "local-llamacpp/local-model", thinkingLevel: "off" });
	await h.manager.wait({ agentId: parent.agentId, timeoutMs: 1000 });
	const routed: any = {
		mode: "auto",
		objective: "quality_first",
		applied: true,
		reason: "selected",
		selectedModel: "anthropic/claude-sonnet-4-6",
		selectedThinkingLevel: "high",
		intent: "review",
		risk: 0.9,
		complexity: 0.8,
		complexityTier: "critical",
		complexityScore: 0.82,
		confidence: 0.9,
		classificationReason: "critical follow-up",
		signals: ["review"],
		estimatedInputTokens: 2000,
		estimatedOutputTokens: 3000,
		explanation: "rerouted",
		candidates: [],
	};
	const result = await h.manager.followupTask(parent.agentId, "critical review", "spawn_followup", {
		model: "anthropic/claude-sonnet-4-6",
		thinkingLevel: "high",
		routingMode: "auto",
		routingProfile: "quality_first",
		routingDecision: routed,
		inheritModelAndThinking: false,
	});
	const child = h.manager.getRecord(result.spawnedAgentId!)!;
	assert.equal(child.model, "anthropic/claude-sonnet-4-6");
	assert.equal(child.thinkingLevel, "high");
	assert.equal(child.routingDecision?.reason, "selected");
	assert.equal(child.routingDecision?.complexityTier, "critical");
});

test("AgentManager live follow-up keeps existing process and ignores spawn overrides", async () => {
	const backend = new FakeBackend();
	backend.autoComplete = false;
	const h = manager(backend, { maxAgentsRunning: 2 });
	const parent = await h.manager.spawnAgent({ taskName: "demo", prompt: "do it", model: "local-llamacpp/local-model", thinkingLevel: "off" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	const result = await h.manager.followupTask(parent.agentId, "live follow-up", "live_if_supported", {
		model: "anthropic/claude-sonnet-4-6",
		thinkingLevel: "high",
		inheritModelAndThinking: false,
	});
	assert.equal(result.deliveryMode, "rpc_follow_up");
	assert.equal(backend.requests.length, 1);
	assert.deepEqual(backend.handles.get(parent.agentId)?.messages, ["live follow-up"]);
});

test("AgentManager accumulates token, cost, tool, and turn metrics across live follow-ups", async () => {
	const backend = new FakeBackend();
	backend.autoComplete = false;
	const h = manager(backend, { maxAgentsRunning: 2 });
	const record = await h.manager.spawnAgent({ taskName: "metrics", prompt: "first" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	backend.events.get(record.agentId)?.onResult?.({
		agentId: record.agentId,
		status: "succeeded",
		summary: "first done",
		output: "first",
		metrics: { turns: 1, toolCalls: 2, providerRequests: 3, inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.01 },
	});
	await h.manager.wait({ agentId: record.agentId, timeoutMs: 1000 });
	await h.manager.followupTask(record.agentId, "second", "live_if_supported");
	backend.events.get(record.agentId)?.onResult?.({
		agentId: record.agentId,
		status: "succeeded",
		summary: "second done",
		output: "second",
		metrics: { turns: 1, toolCalls: 1, providerRequests: 1, inputTokens: 40, outputTokens: 10, totalTokens: 50, costUsd: 0.005 },
	});
	const final = await h.manager.wait({ agentId: record.agentId, timeoutMs: 1000, returnMode: "full" });
	assert.equal(final.agents[0].metrics.turns, 2);
	assert.equal(final.agents[0].metrics.toolCalls, 3);
	assert.equal(final.agents[0].metrics.providerRequests, 4);
	assert.equal(final.agents[0].metrics.inputTokens, 140);
	assert.equal(final.agents[0].metrics.outputTokens, 30);
	assert.equal(final.agents[0].metrics.totalTokens, 170);
	assert.equal(final.agents[0].metrics.costUsd, 0.015);
});

test("AgentManager preserves tool output tail after successful final output", async () => {
	const backend = new FakeBackend();
	backend.autoComplete = false;
	const h = manager(backend);
	const record = await h.manager.spawnAgent({ taskName: "demo", prompt: "do it" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	backend.events.get(record.agentId)?.onOutput?.("← bash result\n/home/svag/Dev/evm-hunter\n");
	backend.events.get(record.agentId)?.onResult?.({ agentId: record.agentId, status: "succeeded", summary: "final", output: "final answer" });
	const waited = await h.manager.wait({ agentId: record.agentId, timeoutMs: 1000, returnMode: "full" });
	assert.match(waited.agents[0].outputTail ?? "", /← bash result/);
	assert.match(waited.agents[0].outputTail ?? "", /final answer/);
});

test("AgentManager recovers partial output when interrupting timed-out agents", async () => {
	const backend = new FakeBackend();
	backend.autoComplete = false;
	const h = manager(backend);
	const record = await h.manager.spawnAgent({ taskName: "demo", prompt: "do it" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	backend.events.get(record.agentId)?.onOutput?.("partial finding: inspect storage/models.py");
	const interrupted = await h.manager.interruptAgent(record.agentId, "Timed out after 300000 ms");
	assert.equal(interrupted.status, "interrupted");
	assert.match(interrupted.result?.summary ?? "", /recovered/);
	assert.equal(interrupted.result?.output, "partial finding: inspect storage/models.py");
});

test("AgentManager enforces max running by queueing", async () => {
	const backend = new FakeBackend();
	backend.autoComplete = false;
	const h = manager(backend);
	const first = await h.manager.spawnAgent({ taskName: "one", prompt: "one" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	const second = await h.manager.spawnAgent({ taskName: "two", prompt: "two" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(h.manager.getRecord(first.agentId)?.status, "running");
	assert.equal(h.manager.getRecord(second.agentId)?.status, "queued");
	backend.events.get(first.agentId)?.onResult?.({ agentId: first.agentId, status: "succeeded", summary: "one done" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(h.manager.getRecord(second.agentId)?.status, "running");
});

test("AgentManager interrupt marks agent interrupted", async () => {
	const backend = new FakeBackend();
	backend.autoComplete = false;
	const h = manager(backend);
	const record = await h.manager.spawnAgent({ taskName: "demo", prompt: "do it" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	const interrupted = await h.manager.interruptAgent(record.agentId, "stop");
	assert.equal(interrupted.status, "interrupted");
	assert.equal(interrupted.controllable, false);
});

test("AgentManager persists restored lost agents once", () => {
	const entries: any[] = [];
	const r = {
		...makeRecord("lost"),
		processState: "unknown" as const,
		controllable: false,
		error: "lost during reload",
	};
	new AgentManager({
		backend: new FakeBackend(),
		store: new StateStore({ appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) }),
		rootCwd: "/tmp",
		restoredRecords: [r],
		restoredEdges: [{ parentAgentId: null, childAgentId: r.agentId, taskName: r.taskName, taskPath: r.taskPath, status: "lost", createdAt: 1, updatedAt: 2 }],
		restoredLostAgentIds: [r.agentId],
	});
	const eventTypes = entries.map((entry) => entry.data?.type).filter(Boolean);
	assert(eventTypes.includes("agent.lost"));
	assert(eventTypes.includes("graph.edge_lost"));
});
