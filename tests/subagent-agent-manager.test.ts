import assert from "node:assert/strict";
import test from "node:test";
import type { AgentBackend, AgentBackendEvents, AgentHandle, BackendSpawnRequest } from "../subagent/core/AgentBackend.ts";
import { AgentManager } from "../subagent/core/AgentManager.ts";
import type { AgentResult } from "../subagent/core/AgentTypes.ts";
import { StateStore } from "../subagent/core/StateStore.ts";

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

function manager(backend = new FakeBackend(), limits: any = {}) {
	const entries: any[] = [];
	return {
		backend,
		entries,
		manager: new AgentManager({
			backend,
			store: new StateStore({ appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) }),
			rootCwd: "/tmp",
			limits: { maxAgentsRunning: 1, maxAgentsTotal: 4, maxOpenAgents: 4, ...limits },
		}),
	};
}

test("AgentManager lifecycle: spawn -> running -> succeeded", async () => {
	const h = manager();
	const record = await h.manager.spawnAgent({ taskName: "demo", prompt: "do it" });
	assert(["queued", "running"].includes(record.status));
	const waited = await h.manager.wait({ agentId: record.agentId, timeoutMs: 1000 });
	assert.equal(waited.timedOut, false);
	assert.equal(waited.agents[0].status, "succeeded");
	assert.equal(waited.agents[0].summary, "done");
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
