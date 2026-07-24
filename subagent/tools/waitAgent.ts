import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderAgentList } from "../render/renderAgentList.ts";
import { type ManagerGetter, textResult } from "./common.ts";

const WaitAgentParams = Type.Object({
	agentId: Type.Optional(Type.String({ description: "Single agent id to wait on." })),
	agentIds: Type.Optional(Type.Array(Type.String(), { description: "Agent ids to wait on." })),
	all: Type.Optional(Type.Boolean({ description: "Wait for all non-closed agents." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout in milliseconds." })),
	returnMode: Type.Optional(StringEnum(["summary", "full", "events"] as const, { description: "Amount of result detail to return." })),
});

export function registerWaitAgentTool(pi: ExtensionAPI, getManager: ManagerGetter): void {
	pi.registerTool({
		name: "wait_agent",
		label: "Wait Agent",
		description: "Wait for one or more subagents to finish or until timeout.",
		promptSnippet: "Wait for subagents to finish and return their results",
		promptGuidelines: ["Use wait_agent when you need delegated subagent results before continuing; prefer reasonable timeouts and avoid busy polling."],
		parameters: WaitAgentParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const result = await getManager(ctx).wait(params);
			const lines = result.agents.map((agent) => `${agent.taskPath}: ${agent.status}${agent.summary ? ` — ${agent.summary}` : agent.error ? ` — ${agent.error}` : ""}`);
			return textResult(`${result.timedOut ? "Timed out" : "Wait complete"}\n${lines.join("\n")}`, result);
		},
		renderCall(args: any, theme) {
			const target = args.all ? "all" : args.agentId ?? (Array.isArray(args.agentIds) ? `${args.agentIds.length} agents` : "...");
			return new Text(`${theme.fg("toolTitle", theme.bold("wait_agent "))}${theme.fg("accent", target)}`, 0, 0);
		},
		renderResult(result: any, { expanded }, theme) {
			return result.details?.agents ? renderAgentList(result.details.agents, theme, expanded) : new Text(result.content?.[0]?.text ?? "", 0, 0);
		},
	});
}
