import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BatchJobManager, interpolatePrompt, parseCsvRows, parseJsonlRows } from "../subagent/core/BatchJobManager.ts";
import type { AgentRecord, SpawnAgentRequest } from "../subagent/core/AgentTypes.ts";

function delay(ms = 20): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRecord(agentId: string, request: SpawnAgentRequest): AgentRecord {
	const now = Date.now();
	return {
		agentId,
		taskName: request.taskName,
		taskPath: `/root/${request.taskName}`,
		parentAgentId: null,
		jobId: request.jobId,
		status: "running",
		processState: "live_running",
		cwd: request.cwd ?? "/tmp",
		prompt: request.prompt,
		createdAt: now,
		startedAt: now,
		updatedAt: now,
		contextMode: request.contextMode ?? "fresh",
		writeMode: request.writeMode ?? "read_only",
		allowedPaths: request.allowedPaths ?? [],
		outputTail: "",
		outputChars: 0,
		controllable: true,
	};
}

class FakeAgentManager {
	records = new Map<string, AgentRecord>();
	spawnRequests: SpawnAgentRequest[] = [];
	async spawnAgent(request: SpawnAgentRequest): Promise<AgentRecord> {
		this.spawnRequests.push(request);
		const record = makeRecord(`agent_${this.spawnRequests.length}`, request);
		this.records.set(record.agentId, record);
		return record;
	}
	getRecord(agentId: string): AgentRecord | undefined {
		return this.records.get(agentId);
	}
	async interruptAgent(agentId: string, reason?: string): Promise<AgentRecord> {
		const record = this.records.get(agentId)!;
		record.status = "interrupted";
		record.error = reason;
		record.finishedAt = Date.now();
		return record;
	}
	complete(agentId: string, output: string): void {
		const record = this.records.get(agentId)!;
		record.status = "succeeded";
		record.processState = "live_idle";
		record.outputTail = output;
		record.outputChars = output.length;
		record.finishedAt = Date.now();
		record.updatedAt = record.finishedAt;
		record.result = { agentId, status: "succeeded", summary: output, output };
	}
}

test("parseCsvRows handles quoted commas and id column", () => {
	const rows = parseCsvRows('id,question\na,"hello, world"\nb,"next"\n', "id");
	assert.deepEqual(rows.map((row) => row.itemId), ["a", "b"]);
	assert.equal(rows[0].data.question, "hello, world");
});

test("parseJsonlRows parses objects and ids", () => {
	const rows = parseJsonlRows('{"id":"x","path":"a.ts"}\n{"id":"y","path":"b.ts"}\n');
	assert.deepEqual(rows.map((row) => row.itemId), ["x", "y"]);
	assert.equal(rows[1].data.path, "b.ts");
});

test("interpolatePrompt supports mustache and brace placeholders", () => {
	assert.equal(interpolatePrompt("Check {{path}} for {question}", { path: "a.ts", question: "risk" }), "Check a.ts for risk");
});

test("BatchJobManager respects maxConcurrency and starts queued workers", async () => {
	const fake = new FakeAgentManager();
	const entries: any[] = [];
	const manager = new BatchJobManager({
		agentManager: fake as any,
		appender: { appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) },
		rootCwd: "/tmp",
	});
	const job = manager.createJob({
		sourceType: "csv",
		rows: parseCsvRows("id,path\n1,a.ts\n2,b.ts\n3,c.ts\n", "id"),
		promptTemplate: "Inspect {{path}}",
		maxConcurrency: 2,
	});
	await delay(50);
	assert.equal(fake.spawnRequests.length, 2);
	assert.equal(manager.getJob(job.jobId)?.counts.running, 2);
	fake.complete("agent_1", "done one");
	await delay(1200);
	assert.equal(fake.spawnRequests.length, 3);
	fake.complete("agent_2", "done two");
	fake.complete("agent_3", "done three");
	const final = await manager.waitJob(job.jobId, 2000);
	assert.equal(final.status, "succeeded");
	assert.equal(final.counts.succeeded, 3);
	assert(entries.some((entry) => entry.data?.job?.jobId === job.jobId));
});

test("BatchJobManager can cancel queued/running jobs", async () => {
	const fake = new FakeAgentManager();
	const manager = new BatchJobManager({ agentManager: fake as any, appender: { appendEntry() {} }, rootCwd: "/tmp" });
	const job = manager.createJob({
		sourceType: "jsonl",
		rows: parseJsonlRows('{"id":"1"}\n{"id":"2"}\n'),
		promptTemplate: "Do {id}",
		maxConcurrency: 1,
	});
	await delay(50);
	const cancelled = await manager.cancelJob(job.jobId, "stop");
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.counts.cancelled, 2);
});

test("BatchJobManager exports JSONL results", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-batch-test-"));
	try {
		const fake = new FakeAgentManager();
		const manager = new BatchJobManager({ agentManager: fake as any, appender: { appendEntry() {} }, rootCwd: dir });
		const job = manager.createJob({ sourceType: "jsonl", rows: parseJsonlRows('{"id":"1"}\n'), promptTemplate: "Do {id}", maxConcurrency: 1 });
		await delay(50);
		fake.complete("agent_1", "result one");
		await manager.waitJob(job.jobId, 2000);
		const exported = await manager.exportResults(job.jobId, "results.jsonl", "jsonl");
		const text = await readFile(exported.path, "utf8");
		assert(text.includes("result one"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
