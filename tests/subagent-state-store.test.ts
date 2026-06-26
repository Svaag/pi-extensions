import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRecord } from "../subagent/core/AgentTypes.ts";
import { StateStore, SUBAGENT_AGENT_STATE_ENTRY, SUBAGENT_EDGE_STATE_ENTRY, SUBAGENT_EVENT_ENTRY } from "../subagent/core/StateStore.ts";

function record(status: AgentRecord["status"] = "running"): AgentRecord {
	return {
		agentId: "agent_1",
		taskName: "demo",
		taskPath: "/root/demo",
		parentAgentId: null,
		status,
		processState: status === "running" ? "live_running" : "exited",
		cwd: "/tmp",
		prompt: "do work",
		createdAt: 1,
		updatedAt: 2,
		contextMode: "fresh",
		writeMode: "read_only",
		allowedPaths: [],
		outputTail: "tail",
		outputChars: 4,
		controllable: status === "running",
	};
}

test("StateStore appends event, agent state, and edge state entries", () => {
	const entries: any[] = [];
	const store = new StateStore({ appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) });
	const r = record("queued");
	store.appendEvent("agent.spawned", { agentId: r.agentId });
	store.appendAgentState(r);
	store.appendEdgeState({ parentAgentId: null, childAgentId: r.agentId, taskName: r.taskName, taskPath: r.taskPath, status: "open", createdAt: 1, updatedAt: 2 });
	assert.deepEqual(entries.map((entry) => entry.customType), [SUBAGENT_EVENT_ENTRY, SUBAGENT_AGENT_STATE_ENTRY, SUBAGENT_EDGE_STATE_ENTRY]);
});

test("StateStore restore marks previously running agents as lost", () => {
	const r = record("running");
	const restored = StateStore.restore([
		{ type: "custom", customType: SUBAGENT_AGENT_STATE_ENTRY, data: { record: r } },
		{ type: "custom", customType: SUBAGENT_EDGE_STATE_ENTRY, data: { edge: { parentAgentId: null, childAgentId: r.agentId, taskName: r.taskName, taskPath: r.taskPath, status: "open", createdAt: 1, updatedAt: 2 } } },
	]);
	assert.equal(restored.records[0].status, "lost");
	assert.equal(restored.records[0].controllable, false);
	assert.equal(restored.edges[0].status, "lost");
	assert.deepEqual(restored.lostAgentIds, ["agent_1"]);
});

test("StateStore restore does not re-emit already persisted lost records", () => {
	const r = { ...record("running"), status: "lost" as const, processState: "unknown" as const, controllable: false };
	const restored = StateStore.restore([
		{ type: "custom", customType: SUBAGENT_AGENT_STATE_ENTRY, data: { record: r } },
		{ type: "custom", customType: SUBAGENT_EDGE_STATE_ENTRY, data: { edge: { parentAgentId: null, childAgentId: r.agentId, taskName: r.taskName, taskPath: r.taskPath, status: "lost", createdAt: 1, updatedAt: 2 } } },
	]);
	assert.equal(restored.records[0].status, "lost");
	assert.deepEqual(restored.lostAgentIds, []);
});
