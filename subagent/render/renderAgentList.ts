import { Text } from "@earendil-works/pi-tui";
import type { AgentSummary } from "../core/AgentTypes.ts";
import { formatDuration, statusColor, statusIcon } from "./renderAgent.ts";

export function renderAgentList(summaries: AgentSummary[], theme: any, expanded = false) {
	if (summaries.length === 0) return new Text(theme.fg("muted", "No subagents."), 0, 0);
	const lines: string[] = [];
	for (const summary of summaries) {
		const icon = theme.fg(statusColor(summary.status), statusIcon(summary.status));
		const duration = formatDuration(summary.durationMs);
		lines.push(`${icon} ${theme.fg("accent", summary.taskPath)} ${theme.fg("muted", `[${summary.status}]`)} ${theme.fg("dim", duration)}`.trim());
		if (summary.summary) lines.push(`  ${summary.summary}`);
		else if (summary.error) lines.push(`  ${theme.fg("error", summary.error)}`);
		else if (summary.outputTail) lines.push(`  ${theme.fg("dim", summary.outputTail.replace(/\s+/g, " ").slice(0, expanded ? 300 : 120))}`);
		if (expanded) lines.push(`  ${theme.fg("dim", `${summary.agentId} · parent=${summary.parentAgentId ?? "root"} · ${summary.controllable ? "controllable" : "not controllable"}`)}`);
	}
	return new Text(lines.join("\n"), 0, 0);
}
