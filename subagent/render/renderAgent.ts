import { Text } from "@earendil-works/pi-tui";
import type { AgentRecord, AgentSummary } from "../core/AgentTypes.ts";
import { formatDuration, statusColor, statusIcon } from "./agentFormat.ts";

export { formatDuration, statusColor, statusIcon } from "./agentFormat.ts";

export function renderAgentSummary(summary: AgentSummary | AgentRecord, theme: any, expanded = false) {
	const icon = theme.fg(statusColor(summary.status), statusIcon(summary.status));
	const lines = [`${icon} ${theme.fg("accent", summary.taskPath)} ${theme.fg("muted", `[${summary.status}]`)}`];
	const duration = "durationMs" in summary ? summary.durationMs : summary.startedAt ? (summary.finishedAt ?? Date.now()) - summary.startedAt : undefined;
	const meta = [summary.agentId, duration !== undefined ? formatDuration(duration) : "", summary.controllable ? "controllable" : "not controllable"].filter(Boolean).join(" · ");
	lines.push(theme.fg("dim", meta));
	const routing = summary.routingDecision;
	const modelMeta = [
		summary.model ? `model:${summary.model}` : "",
		summary.thinkingLevel ? `thinking:${summary.thinkingLevel}` : "",
		routing ? `routed:${routing.intent}/${routing.objective}${routing.applied ? "" : ` (${routing.reason})`}` : "",
	].filter(Boolean).join(" · ");
	if (modelMeta) lines.push(theme.fg("dim", modelMeta));
	const text = "summary" in summary ? summary.summary : summary.result?.summary;
	if (text) lines.push(text);
	const error = summary.error;
	if (error) lines.push(theme.fg("error", error));
	if (routing && expanded) {
		lines.push("", theme.fg("muted", "── routing ──"));
		lines.push(`decision: ${routing.reason}; selected=${routing.selectedModel ?? "(none)"}; thinking=${routing.selectedThinkingLevel ?? "(none)"}`);
		lines.push(`risk=${routing.risk.toFixed(2)} complexity=${routing.complexity.toFixed(2)} estimated=${routing.estimatedInputTokens}+${routing.estimatedOutputTokens} tokens`);
		if (routing.explanation) lines.push(routing.explanation);
		for (const candidate of routing.candidates.slice(0, 3)) {
			lines.push(theme.fg("dim", `• ${candidate.model} score=${candidate.score.toFixed(3)} cost=$${candidate.estimatedCostUsd.toFixed(5)} quality=${candidate.quality.toFixed(2)}`));
		}
	}
	const tail = "outputTail" in summary ? summary.outputTail : undefined;
	if (tail && expanded) lines.push("", theme.fg("muted", "── output tail ──"), tail);
	return new Text(lines.join("\n"), 0, 0);
}
