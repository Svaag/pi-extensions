import { Text } from "@earendil-works/pi-tui";
import type { AgentSummary } from "../core/AgentTypes.ts";
import { formatDuration, statusColor, statusIcon } from "./agentFormat.ts";
import { compactNumber, shortTaskLabel } from "./renderSubagentWidget.ts";

export function renderAgentList(summaries: AgentSummary[], theme: any, expanded = false) {
	if (summaries.length === 0) return new Text(theme.fg("muted", "No subagents."), 0, 0);
	const lines: string[] = [];
	for (const summary of summaries) {
		const icon = theme.fg(statusColor(summary.status), statusIcon(summary.status));
		const duration = formatDuration(summary.durationMs);
		const output = compactNumber(summary.metrics?.outputChars);
		const meta = [duration, output ? `${output} out` : ""].filter(Boolean).join(" · ");
		const label = expanded ? summary.taskPath : shortTaskLabel(summary.taskPath);
		lines.push(`${icon} ${theme.fg("accent", label)} ${theme.fg("muted", `[${summary.status}]`)}${meta ? ` ${theme.fg("dim", meta)}` : ""}`.trim());
		if (summary.summary) {
			const brief = expanded ? summary.summary : `${summary.summary.replace(/\s+/g, " ").slice(0, 180)}${summary.summary.length > 180 ? "…" : ""}`;
			lines.push(`  ${expanded ? brief : theme.fg("dim", brief)}`);
		} else if (summary.error) lines.push(`  ${theme.fg("error", summary.error)}`);
		else if (expanded && summary.outputTail) lines.push(`  ${theme.fg("dim", summary.outputTail.replace(/\s+/g, " ").slice(0, 300))}`);
		if (expanded) lines.push(`  ${theme.fg("dim", `${summary.agentId} · parent=${summary.parentAgentId ?? "root"} · ${summary.controllable ? "controllable" : "not controllable"}`)}`);
	}
	return new Text(lines.join("\n"), 0, 0);
}
