import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderAgentGraph } from "../render/renderAgentGraph.ts";
import { type ManagerGetter, textResult } from "./common.ts";

const ListAgentGraphParams = Type.Object({
	includeClosed: Type.Optional(Type.Boolean({ description: "Include closed agents in the graph. Defaults to true." })),
});

function graphText(records: any[], edges: any[]): string {
	if (records.length === 0) return "No subagent graph.";
	const statusById = new Map(records.map((record) => [record.agentId, record.status]));
	const lines = ["/root"];
	for (const edge of edges) {
		const status = statusById.get(edge.childAgentId) ?? edge.status;
		lines.push(`- ${edge.taskPath} [${status}] parent=${edge.parentAgentId ?? "root"} id=${edge.childAgentId}`);
	}
	return lines.join("\n");
}

export function registerListAgentGraphTool(pi: ExtensionAPI, getManager: ManagerGetter): void {
	pi.registerTool({
		name: "list_agent_graph",
		label: "List Agent Graph",
		description: "Render the persistent parent/child subagent graph as task paths with statuses.",
		promptSnippet: "Show the subagent parent/child graph",
		promptGuidelines: ["Use list_agent_graph when you need to understand subagent parent/child relationships or reload-reconciled lost agents."],
		parameters: ListAgentGraphParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const manager = getManager(ctx);
			const records = manager.listRecords({ includeClosed: params.includeClosed !== false });
			const edges = manager.listEdges();
			return textResult(graphText(records, edges), { records, edges });
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("list_agent_graph")), 0, 0);
		},
		renderResult(result: any, _options, theme) {
			return result.details?.records && result.details?.edges
				? renderAgentGraph(result.details.records, result.details.edges, theme)
				: new Text(result.content?.[0]?.text ?? "", 0, 0);
		},
	});
}
