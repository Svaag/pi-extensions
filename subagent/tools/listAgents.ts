import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderAgentList } from "../render/renderAgentList.ts";
import { type ManagerGetter, textResult } from "./common.ts";

const ListAgentsParams = Type.Object({
	includeClosed: Type.Optional(Type.Boolean({ description: "Include closed agents." })),
	parentAgentId: Type.Optional(Type.String({ description: "Filter by parent agent id." })),
	jobId: Type.Optional(Type.String({ description: "Filter by batch job id (reserved)." })),
});

export function registerListAgentsTool(pi: ExtensionAPI, getManager: ManagerGetter): void {
	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: "List active and recent Pi subagents with lifecycle status and brief result/error.",
		promptSnippet: "List active and recent subagents",
		promptGuidelines: ["Use list_agents to inspect subagent state before waiting, messaging, interrupting, or closing agents."],
		parameters: ListAgentsParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const agents = getManager(ctx).summaries({ includeClosed: params.includeClosed, parentAgentId: params.parentAgentId, jobId: params.jobId });
			const text = agents.length === 0 ? "No subagents." : agents.map((agent) => `${agent.taskPath}: ${agent.status}${agent.summary ? ` — ${agent.summary}` : ""}`).join("\n");
			return textResult(text, { agents });
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("list_agents")), 0, 0);
		},
		renderResult(result: any, { expanded }, theme) {
			return result.details?.agents ? renderAgentList(result.details.agents, theme, expanded) : new Text(result.content?.[0]?.text ?? "", 0, 0);
		},
	});
}
