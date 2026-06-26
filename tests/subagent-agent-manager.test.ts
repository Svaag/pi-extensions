import assert from "node:assert/strict";
import test from "node:test";
import type { AgentBackend, AgentBackendEvents, AgentHandle, BackendSpawnRequest } from "../subagent/core/AgentBackend.ts";
import { AgentManager } from "../subagent/core/AgentManager.ts";
import type { AgentResult } from "../subagent/core/AgentTypes.ts";
import { StateStore } from "../subagent/core/StateStore.ts";

class FakeHandle implements AgentHandle {
	readonly agentId: string;
	closed = false;
	constructor(agentId: string) {
		this.agentId = agentId;
	}
	prompt(_message: string): Promise<void> { return Promise.resolve(); }
	sendMessage(_message: string): Promise<void> { return Promise.resolve(); }
	followupTask(_message: string): Promise<void> { return Promise.resolve(); }
	interrupt(_reason?: string): Promise<void> { this.closed = true; return Promise.resolve(); }
	close(_reason?: string): Promise<void> { this.closed = true; return Promise.resolve(); }
	isAlive(): boolean { return !this.closed; }
}

class FakeBackend implements AgentBackend {
	requests: BackendSpawnRequest[] = [];
	events = new Map<string, AgentBackendEvents>();
	autoComplete = true;
	async spawn(request: BackendSpawnRequest, events: AgentBackendEvents): Promise<AgentHandle> {
		this.requests.push(request);
		this.events.set(request.record.agentId, events);
		events.onStarted?.();
		if (this.autoComplete) {
			queueMicrotask(() => events.onResult?.({ agentId: request.record.agentId, status: "succeeded", summary: "done", output: "done" } satisfies AgentResult));
		}
		return new FakeHandle(request.record.agentId);
	}
}

function manager(backend = new FakeBackend()) {
	const entries: any[] = [];
	return {
		backend,
		entries,
		manager: new AgentManager({
			backend,
			store: new StateStore({ appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) }),
			rootCwd: "/tmp",
			limits: { maxAgentsRunning: 1, maxAgentsTotal: 4, maxOpenAgents: 4 },
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
