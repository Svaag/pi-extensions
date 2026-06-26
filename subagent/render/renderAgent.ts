import { Text } from "@earendil-works/pi-tui";
import type { AgentRecord, AgentSummary } from "../core/AgentTypes.ts";

export function statusIcon(status: string): string {
	switch (status) {
		case "queued": return "…";
		case "running": return "⏳";
		case "succeeded": return "✓";
		case "failed": return "✗";
		case "interrupted": return "⚠";
		case "lost": return "?";
		case "closed": return "■";
		default: return "•";
	}
}

export function statusColor(status: string): string {
	switch (status) {
		case "running": return "warning";
		case "queued": return "muted";
		case "succeeded": return "success";
		case "failed": return "error";
		case "interrupted":
		case "lost": return "warning";
		case "closed": return "muted";
		default: return "accent";
	}
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m${rest ? `${rest}s` : ""}`;
}

export function renderAgentSummary(summary: AgentSummary | AgentRecord, theme: any, expanded = false) {
	const icon = theme.fg(statusColor(summary.status), statusIcon(summary.status));
	const lines = [`${icon} ${theme.fg("accent", summary.taskPath)} ${theme.fg("muted", `[${summary.status}]`)}`];
	const duration = "durationMs" in summary ? summary.durationMs : summary.startedAt ? (summary.finishedAt ?? Date.now()) - summary.startedAt : undefined;
	const meta = [summary.agentId, duration !== undefined ? formatDuration(duration) : "", summary.controllable ? "controllable" : "not controllable"].filter(Boolean).join(" · ");
	lines.push(theme.fg("dim", meta));
	const text = "summary" in summary ? summary.summary : summary.result?.summary;
	if (text) lines.push(text);
	const error = summary.error;
	if (error) lines.push(theme.fg("error", error));
	const tail = "outputTail" in summary ? summary.outputTail : undefined;
	if (tail && expanded) lines.push("", theme.fg("muted", "── output tail ──"), tail);
	return new Text(lines.join("\n"), 0, 0);
}
