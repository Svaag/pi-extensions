import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSummary } from "../subagent/core/AgentTypes.ts";
import { renderSubagentWidgetLines, shortTaskLabel, subagentStatusSummary } from "../subagent/render/renderSubagentWidget.ts";

const theme = {
	fg(_color: string, text: string) { return text; },
	bold(text: string) { return text; },
};

function agent(partial: Partial<AgentSummary> & Pick<AgentSummary, "taskPath" | "status">): AgentSummary {
	const now = 10_000;
	return {
		agentId: partial.agentId ?? partial.taskPath,
		taskName: partial.taskName ?? partial.taskPath.split("/").pop() ?? "task",
		taskPath: partial.taskPath,
		parentAgentId: partial.parentAgentId ?? null,
		status: partial.status,
		processState: partial.processState ?? (partial.status === "running" ? "live_running" : "live_idle"),
		cwd: "/tmp",
		createdAt: partial.createdAt ?? 1_000,
		startedAt: partial.startedAt ?? 2_000,
		finishedAt: partial.finishedAt,
		updatedAt: partial.updatedAt ?? now,
		ageMs: partial.ageMs ?? now - (partial.createdAt ?? 1_000),
		durationMs: partial.durationMs ?? (partial.finishedAt ? partial.finishedAt - (partial.startedAt ?? 2_000) : now - (partial.startedAt ?? 2_000)),
		controllable: partial.controllable ?? partial.status === "running",
		outputTail: partial.outputTail,
		summary: partial.summary,
		output: partial.output,
		error: partial.error,
		metrics: partial.metrics ?? { outputChars: 0 },
		model: partial.model,
		thinkingLevel: partial.thinkingLevel,
		routingDecision: partial.routingDecision,
	};
}

test("shortTaskLabel removes noisy /root prefix and repeated follow-up prefix", () => {
	assert.equal(shortTaskLabel("/root/satlayer_evm_review"), "satlayer_evm_review");
	assert.equal(shortTaskLabel("/root/satlayer_evm_review/satlayer_evm_review_followup"), "satlayer_evm_review › followup");
});

test("subagent widget prioritizes active agents and collapses completed summaries", () => {
	const agents = [
		agent({ taskPath: "/root/satlayer_evm_review", status: "succeeded", summary: "Very long final report that should not consume widget space" }),
		agent({ taskPath: "/root/satlayer_sui_review", status: "succeeded", summary: "Another long final report" }),
		agent({ taskPath: "/root/satlayer_babylon_bvs_review", status: "succeeded", summary: "Another long final report" }),
		agent({ taskPath: "/root/satlayer_app_integrations", status: "succeeded", summary: "Another long final report" }),
		agent({ taskPath: "/root/satlayer_evm_review/satlayer_evm_review_followup", status: "running", updatedAt: 9_000, metrics: { outputChars: 272_000 } }),
		agent({ taskPath: "/root/satlayer_sui_review/satlayer_sui_review_followup", status: "succeeded", summary: "Context-only answer" }),
		agent({ taskPath: "/root/satlayer_babylon_bvs_review/satlayer_babylon_bvs_review_followup", status: "running", updatedAt: 8_000 }),
		agent({ taskPath: "/root/satlayer_app_integrations/satlayer_app_integrations_followup", status: "running", updatedAt: 7_000 }),
	];
	const lines = renderSubagentWidgetLines(agents, [], theme, 120, { nowMs: 10_000 });
	assert.match(lines[0], /3 running/);
	assert.match(lines[1], /satlayer_evm_review › followup/);
	assert.match(lines[2], /satlayer_babylon_bvs_review › followup/);
	assert.match(lines[3], /satlayer_app_integrations › followup/);
	assert.match(lines.at(-1) ?? "", /5 done/);
	assert(!lines.some((line) => line.includes("Very long final report")));
	assert(lines.length <= 5);
});

test("subagent footer status summarizes active and idle states", () => {
	assert.deepEqual(subagentStatusSummary([agent({ taskPath: "/root/a", status: "running" }), agent({ taskPath: "/root/b", status: "queued" })], []), { color: "warning", text: "🤖 1 run +1q" });
	assert.deepEqual(subagentStatusSummary([agent({ taskPath: "/root/a", status: "succeeded" })], []), { color: "accent", text: "🤖 idle" });
	assert.equal(subagentStatusSummary([], []), undefined);
});
