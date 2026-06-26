import { Text } from "@earendil-works/pi-tui";
import type { AgentGraphEdge, AgentRecord } from "../core/AgentTypes.ts";
import { statusColor, statusIcon } from "./renderAgent.ts";

export function renderAgentGraph(records: AgentRecord[], edges: AgentGraphEdge[], theme: any) {
	if (records.length === 0) return new Text(theme.fg("muted", "No subagent graph."), 0, 0);
	const byParent = new Map<string, AgentGraphEdge[]>();
	for (const edge of edges) {
		const key = edge.parentAgentId ?? "root";
		const list = byParent.get(key) ?? [];
		list.push(edge);
		byParent.set(key, list);
	}
	for (const list of byParent.values()) list.sort((a, b) => a.createdAt - b.createdAt);
	const recordsById = new Map(records.map((record) => [record.agentId, record]));
	const lines = [theme.fg("accent", "/root")];
	function walk(parentId: string | null, prefix: string): void {
		const children = byParent.get(parentId ?? "root") ?? [];
		children.forEach((edge, index) => {
			const isLast = index === children.length - 1;
			const record = recordsById.get(edge.childAgentId);
			const status = record?.status ?? edge.status;
			const icon = theme.fg(statusColor(status), statusIcon(status));
			lines.push(`${prefix}${isLast ? "└─" : "├─"} ${icon} ${theme.fg("accent", edge.taskPath)} ${theme.fg("muted", `[${status}]`)}`);
			walk(edge.childAgentId, `${prefix}${isLast ? "   " : "│  "}`);
		});
	}
	walk(null, "");
	return new Text(lines.join("\n"), 0, 0);
}
