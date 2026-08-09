import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSummary, WaitAgentResult } from "../subagent/core/AgentTypes.ts";
import { renderAgentList } from "../subagent/render/renderAgentList.ts";
import { formatWaitAgentResult, registerWaitAgentTool } from "../subagent/tools/waitAgent.ts";

const theme = {
	fg(_color: string, text: string) { return text; },
	bold(text: string) { return text; },
};

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
	return {
		agentId: "agent_test",
		taskName: "test",
		taskPath: "/root/test",
		parentAgentId: null,
		status: "succeeded",
		processState: "live_idle",
		cwd: "/tmp",
		createdAt: 1,
		startedAt: 2,
		finishedAt: 3,
		updatedAt: 3,
		ageMs: 2,
		durationMs: 1,
		controllable: true,
		metrics: { outputChars: 141_414 },
		...overrides,
	};
}

function renderedText(component: any, width = 10_000): string {
	return component.render(width).map((line: string) => line.trimEnd()).join("\n");
}

test("wait_agent full mode exposes the complete final output to the model", async () => {
	const finalOutput = "# Complete report\n\nEvidence omitted by the summary.\nTERMINAL_SENTINEL";
	const result: WaitAgentResult = {
		timedOut: false,
		agents: [agent({ summary: "# Complete report Evidence…", output: finalOutput, outputTail: "transcript tail" })],
	};
	let registered: any;
	registerWaitAgentTool({ registerTool(tool: any) { registered = tool; } } as any, () => ({
		async wait(params: any) {
			assert.equal(params.returnMode, "full");
			return result;
		},
	}) as any);

	const toolResult = await registered.execute("call_1", { agentId: "agent_test", returnMode: "full" }, undefined, undefined, {});
	const text = toolResult.content[0].text;
	assert.match(text, /TERMINAL_SENTINEL/);
	assert.equal(text, `Wait complete\n/root/test: succeeded\n${finalOutput}`);
	assert.deepEqual(toolResult.details, result);
});

test("wait_agent summary mode remains concise", () => {
	const result: WaitAgentResult = {
		timedOut: false,
		agents: [agent({ summary: "Concise result", output: "FULL_OUTPUT_MUST_NOT_APPEAR" })],
	};

	assert.equal(formatWaitAgentResult(result), "Wait complete\n/root/test: succeeded — Concise result");
});

test("wait_agent full mode falls back to retained output when no final output exists", () => {
	const result: WaitAgentResult = {
		timedOut: true,
		agents: [agent({ status: "running", summary: undefined, output: undefined, outputTail: "partial retained output" })],
	};

	assert.equal(formatWaitAgentResult(result, "full"), "Timed out\n/root/test: running\npartial retained output");
});

test("agent list keeps a compact collapsed preview and shows full output when expanded", () => {
	const summary = "Summary ".repeat(40);
	const output = "# Full report\n\nComplete evidence.\nTERMINAL_SENTINEL";
	const item = agent({ summary, output });

	const collapsed = renderedText(renderAgentList([item], theme, false));
	assert.doesNotMatch(collapsed, /TERMINAL_SENTINEL/);
	assert.match(collapsed, /…/);
	assert(collapsed.length < summary.length);

	const expanded = renderedText(renderAgentList([item], theme, true));
	assert.match(expanded, /# Full report/);
	assert.match(expanded, /TERMINAL_SENTINEL/);
	assert.doesNotMatch(expanded, /Summary Summary/);
});
