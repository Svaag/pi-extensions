import assert from "node:assert/strict";
import test from "node:test";
import type { SpawnAgentRequest } from "../subagent/core/AgentTypes.ts";
import { registerSpawnAgentTool } from "../subagent/tools/spawnAgent.ts";
import { registerSpawnAgentsOnCsvTool } from "../subagent/tools/spawnAgentsOnCsv.ts";
import { registerSpawnAgentsOnJsonlTool } from "../subagent/tools/spawnAgentsOnJsonl.ts";

function registerTool(register: (pi: any) => void): any {
	let tool: any;
	register({
		registerTool(definition: any) {
			tool = definition;
		},
	});
	assert(tool, "tool was not registered");
	return tool;
}

function interactiveContext(): any {
	return {
		cwd: "/repo",
		hasUI: true,
		thinkingLevel: "high",
		model: { provider: "xai", id: "grok-4.6" },
		sessionManager: { getBranch: () => [] },
		ui: {
			async confirm() {
				throw new Error("write-capable spawn unexpectedly requested confirmation");
			},
		},
	};
}

function batchSummary(request: any): any {
	return {
		...request,
		jobId: `job_${request.sourceType}`,
		name: `${request.sourceType}-test`,
		status: "queued",
		counts: {
			total: request.rows.length,
			queued: request.rows.length,
			running: 0,
			succeeded: 0,
			failed: 0,
			cancelled: 0,
			lost: 0,
		},
	};
}

test("write-capable spawn tools execute without interactive confirmation", async (t) => {
	await t.test("spawn_agent forwards scoped multi-task write access", async () => {
		const requests: SpawnAgentRequest[] = [];
		const manager = {
			async spawnAgent(request: SpawnAgentRequest) {
				requests.push(request);
				return {
					agentId: `agent_${requests.length}`,
					taskName: request.taskName,
					taskPath: `/root/${request.taskName}`,
					status: "queued",
				};
			},
		};
		const tool = registerTool((pi) => registerSpawnAgentTool(pi, () => manager as any));

		await tool.execute("call_spawn", {
			writeMode: "disjoint_scope",
			tasks: [
				{ taskName: "schemas", prompt: "Implement schemas", allowedPaths: ["src/schemas"] },
				{ taskName: "registry", prompt: "Implement registry", allowedPaths: ["src/registry"] },
			],
		}, undefined, undefined, interactiveContext());

		assert.deepEqual(requests.map(({ taskName, writeMode, allowedPaths }) => ({ taskName, writeMode, allowedPaths })), [
			{ taskName: "schemas", writeMode: "disjoint_scope", allowedPaths: ["src/schemas"] },
			{ taskName: "registry", writeMode: "disjoint_scope", allowedPaths: ["src/registry"] },
		]);
		assert.equal(requests[0].model, "xai/grok-4.6");
		assert.equal(requests[0].thinkingLevel, "low");
		assert.equal(requests[0].routingDecision, undefined);
	});

	await t.test("spawn_agents_on_csv forwards scoped write access", async () => {
		let createRequest: any;
		const manager = {
			createJob(request: any) {
				createRequest = request;
				return batchSummary(request);
			},
		};
		const tool = registerTool((pi) => registerSpawnAgentsOnCsvTool(pi, () => manager as any));

		await tool.execute("call_csv", {
			csvText: "id,path\n1,src/a.ts\n",
			idColumn: "id",
			promptTemplate: "Implement {{path}}",
			writeMode: "disjoint_scope",
			allowedPaths: ["src/csv"],
		}, undefined, undefined, interactiveContext());

		assert.equal(createRequest.writeMode, "disjoint_scope");
		assert.deepEqual(createRequest.allowedPaths, ["src/csv"]);
		assert.equal(createRequest.model, "xai/grok-4.6");
		assert.equal(createRequest.routingDecision, undefined);
	});

	await t.test("spawn_agents_on_jsonl forwards scoped write access", async () => {
		let createRequest: any;
		const manager = {
			createJob(request: any) {
				createRequest = request;
				return batchSummary(request);
			},
		};
		const tool = registerTool((pi) => registerSpawnAgentsOnJsonlTool(pi, () => manager as any));

		await tool.execute("call_jsonl", {
			jsonlText: "{\"id\":\"1\",\"path\":\"src/a.ts\"}\n",
			idField: "id",
			promptTemplate: "Implement {{path}}",
			writeMode: "disjoint_scope",
			allowedPaths: ["src/jsonl"],
		}, undefined, undefined, interactiveContext());

		assert.equal(createRequest.writeMode, "disjoint_scope");
		assert.deepEqual(createRequest.allowedPaths, ["src/jsonl"]);
	});
});
