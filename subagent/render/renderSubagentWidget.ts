import type { AgentStatus, AgentSummary } from "../core/AgentTypes.ts";
import type { BatchJobSummary } from "../core/BatchTypes.ts";
import { formatDuration, statusColor, statusIcon } from "./agentFormat.ts";

interface ThemeLike {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

export interface SubagentStatusSummary {
	text: string;
	color: string;
}

export interface RenderSubagentWidgetOptions {
	maxActiveRows?: number;
	nowMs?: number;
}

const ACTIVE_AGENT_STATUSES = new Set<AgentStatus>(["running", "queued"]);
const PROBLEM_AGENT_STATUSES = new Set<AgentStatus>(["failed", "interrupted", "lost"]);

function countAgents(agents: AgentSummary[], status: AgentStatus): number {
	return agents.filter((agent) => agent.status === status).length;
}

function activeJobs(jobs: BatchJobSummary[]): BatchJobSummary[] {
	return jobs.filter((job) => job.status === "running" || job.status === "queued");
}

function visibleCharWidth(char: string): number {
	// Good enough for compact status lines; avoids pulling TUI internals into pure render tests.
	return /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1;
}

function walkAnsiLine(line: string, onAnsi: (ansi: string) => void, onChar: (char: string, width: number) => boolean): void {
	for (let i = 0; i < line.length;) {
		if (line.charCodeAt(i) === 0x1b && line[i + 1] === "[") {
			let end = i + 2;
			while (end < line.length && !/[@-~]/.test(line[end] ?? "")) end++;
			onAnsi(line.slice(i, Math.min(end + 1, line.length)));
			i = Math.min(end + 1, line.length);
			continue;
		}
		const codePoint = line.codePointAt(i);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		if (!onChar(char, visibleCharWidth(char))) return;
		i += char.length;
	}
}

function visibleWidth(line: string): number {
	let width = 0;
	walkAnsiLine(line, () => {}, (_char, charWidth) => {
		width += charWidth;
		return true;
	});
	return width;
}

function fit(line: string, width: number): string {
	if (!Number.isFinite(width) || width <= 0) return line;
	if (visibleWidth(line) <= width) return line;
	const limit = Math.max(0, width - 1);
	let visible = 0;
	let out = "";
	walkAnsiLine(line, (ansi) => { out += ansi; }, (char, charWidth) => {
		if (visible + charWidth > limit) return false;
		out += char;
		visible += charWidth;
		return true;
	});
	return `${out}…`;
}

function plural(count: number, singular: string, pluralText = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralText}`;
}

export function compactNumber(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return "";
	if (value >= 1_000_000) {
		const scaled = value / 1_000_000;
		return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)}M`;
	}
	if (value >= 1_000) {
		const scaled = value / 1_000;
		return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)}k`;
	}
	return String(Math.round(value));
}

function compactOneLine(text: string, maxChars: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= maxChars) return clean;
	if (maxChars <= 1) return clean.slice(0, maxChars);
	return `${clean.slice(0, maxChars - 1)}…`;
}

function stripRepeatedChildPrefix(parent: string, child: string): string {
	if (child === parent) return child;
	for (const separator of ["_", "-"]) {
		const prefix = `${parent}${separator}`;
		if (child.startsWith(prefix)) return child.slice(prefix.length) || child;
	}
	return child;
}

export function shortTaskLabel(taskPath: string): string {
	const parts = taskPath.split("/").filter(Boolean);
	const withoutRoot = parts[0] === "root" ? parts.slice(1) : parts;
	if (withoutRoot.length === 0) return taskPath || "/root";
	if (withoutRoot.length === 1) return withoutRoot[0] ?? taskPath;
	const parent = withoutRoot[withoutRoot.length - 2] ?? "";
	const child = withoutRoot[withoutRoot.length - 1] ?? "";
	const compactChild = stripRepeatedChildPrefix(parent, child);
	return `${parent} › ${compactChild}`;
}

function agentDurationMs(agent: AgentSummary, nowMs: number): number | undefined {
	if (agent.startedAt) return (agent.finishedAt ?? nowMs) - agent.startedAt;
	return agent.durationMs;
}

function agentSortRank(status: AgentStatus): number {
	switch (status) {
		case "running": return 0;
		case "queued": return 1;
		case "failed": return 2;
		case "interrupted": return 3;
		case "lost": return 4;
		case "succeeded": return 5;
		case "closed": return 6;
		default: return 9;
	}
}

function renderAgentRow(agent: AgentSummary, theme: ThemeLike, nowMs: number, width: number): string {
	const icon = theme.fg(statusColor(agent.status), statusIcon(agent.status));
	const label = theme.fg("accent", shortTaskLabel(agent.taskPath));
	const duration = agentDurationMs(agent, nowMs);
	const meta: string[] = [];
	if (agent.status === "running") {
		meta.push(duration !== undefined ? formatDuration(duration) : "starting");
	} else if (agent.status === "queued") {
		meta.push(`queued ${formatDuration(agent.ageMs)}`.trim());
	} else if (duration !== undefined) {
		meta.push(formatDuration(duration));
	}
	const outputChars = compactNumber(agent.metrics?.outputChars);
	if (outputChars) meta.push(`${outputChars} out`);
	const updatedAgo = nowMs - agent.updatedAt;
	if (agent.status === "running" && updatedAgo > 5_000) meta.push(`upd ${formatDuration(updatedAgo)} ago`);
	if (width >= 110 && agent.model) {
		const model = agent.model.split("/").slice(-1)[0] ?? agent.model;
		meta.push(`${model}${agent.thinkingLevel ? `/${agent.thinkingLevel}` : ""}`);
	}
	const status = theme.fg("muted", `[${agent.status}]`);
	const suffix = meta.length > 0 ? ` ${theme.fg("dim", meta.join(" · "))}` : "";
	return fit(`${icon} ${label} ${status}${suffix}`, width);
}

function renderJobRow(job: BatchJobSummary, theme: ThemeLike, width: number): string {
	const icon = theme.fg(job.status === "running" ? "warning" : "muted", job.status === "running" ? "⏳" : "…");
	const progress = `${job.counts.succeeded}/${job.counts.total} done`;
	const rest = [progress, job.counts.running ? `${job.counts.running} running` : "", job.counts.failed ? `${job.counts.failed} failed` : ""].filter(Boolean).join(" · ");
	return fit(`${icon} ${theme.fg("accent", job.name)} ${theme.fg("muted", `[${job.status}]`)} ${theme.fg("dim", rest)}`, width);
}

function terminalSummaryLine(agents: AgentSummary[], theme: ThemeLike, nowMs: number, width: number): string | undefined {
	const succeeded = countAgents(agents, "succeeded");
	const failed = countAgents(agents, "failed");
	const interrupted = countAgents(agents, "interrupted");
	const lost = countAgents(agents, "lost");
	const parts = [
		succeeded ? theme.fg("success", plural(succeeded, "done", "done")) : "",
		failed ? theme.fg("error", plural(failed, "failed", "failed")) : "",
		interrupted ? theme.fg("warning", plural(interrupted, "interrupted", "interrupted")) : "",
		lost ? theme.fg("warning", plural(lost, "lost", "lost")) : "",
	].filter(Boolean);
	if (parts.length === 0) return undefined;
	const latest = [...agents]
		.filter((agent) => !ACTIVE_AGENT_STATUSES.has(agent.status))
		.sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt))[0];
	const latestText = latest ? theme.fg("dim", `last: ${shortTaskLabel(latest.taskPath)}${agentDurationMs(latest, nowMs) !== undefined ? ` ${formatDuration(agentDurationMs(latest, nowMs))}` : ""}`) : "";
	return fit(`${parts.join(theme.fg("dim", " · "))}${latestText ? theme.fg("dim", " · ") + latestText : ""}`, width);
}

function problemHintLine(agents: AgentSummary[], theme: ThemeLike, width: number): string | undefined {
	const latestProblem = [...agents]
		.filter((agent) => PROBLEM_AGENT_STATUSES.has(agent.status))
		.sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt))[0];
	if (!latestProblem) return undefined;
	const text = latestProblem.error || latestProblem.summary || latestProblem.outputTail || "No error detail.";
	return fit(theme.fg("error", `last problem: ${shortTaskLabel(latestProblem.taskPath)} — ${compactOneLine(text, 120)}`), width);
}

export function subagentStatusSummary(agents: AgentSummary[], jobs: BatchJobSummary[]): SubagentStatusSummary | undefined {
	const running = countAgents(agents, "running");
	const queued = countAgents(agents, "queued");
	const failed = countAgents(agents, "failed");
	const interrupted = countAgents(agents, "interrupted");
	const lost = countAgents(agents, "lost");
	const runningJobs = activeJobs(jobs).length;
	if (running || queued || runningJobs) {
		const agentPart = running && queued ? `${running} run +${queued}q` : running ? `${running} run` : queued ? `${queued} queued` : "";
		const parts = [
			agentPart,
			runningJobs ? `${runningJobs} job${runningJobs === 1 ? "" : "s"}` : "",
		].filter(Boolean);
		return { color: "warning", text: `🤖 ${parts.join(" · ")}` };
	}
	if (failed || interrupted || lost) return { color: failed ? "error" : "warning", text: `🤖 ${failed + interrupted + lost} issue${failed + interrupted + lost === 1 ? "" : "s"}` };
	if (agents.length > 0 || jobs.length > 0) return { color: "accent", text: "🤖 idle" };
	return undefined;
}

export function renderSubagentWidgetLines(
	agents: AgentSummary[],
	jobs: BatchJobSummary[],
	theme: ThemeLike,
	width: number,
	options: RenderSubagentWidgetOptions = {},
): string[] {
	const maxActiveRows = options.maxActiveRows ?? 5;
	const nowMs = options.nowMs ?? Date.now();
	if (agents.length === 0 && jobs.length === 0) return [];

	const running = countAgents(agents, "running");
	const queued = countAgents(agents, "queued");
	const succeeded = countAgents(agents, "succeeded");
	const failed = countAgents(agents, "failed");
	const interrupted = countAgents(agents, "interrupted");
	const lost = countAgents(agents, "lost");
	const active = agents
		.filter((agent) => ACTIVE_AGENT_STATUSES.has(agent.status))
		.sort((a, b) => agentSortRank(a.status) - agentSortRank(b.status) || b.updatedAt - a.updatedAt);
	const liveJobs = activeJobs(jobs).sort((a, b) => b.updatedAt - a.updatedAt);

	const title = theme.fg("accent", theme.bold ? theme.bold("Subagents") : "Subagents");
	const countParts = [
		running ? theme.fg("warning", plural(running, "running", "running")) : "",
		queued ? theme.fg("muted", plural(queued, "queued", "queued")) : "",
		succeeded ? theme.fg("success", plural(succeeded, "done", "done")) : "",
		failed ? theme.fg("error", plural(failed, "failed", "failed")) : "",
		interrupted ? theme.fg("warning", plural(interrupted, "interrupted", "interrupted")) : "",
		lost ? theme.fg("warning", plural(lost, "lost", "lost")) : "",
		liveJobs.length ? theme.fg("warning", plural(liveJobs.length, "active job")) : "",
	].filter(Boolean);
	const hint = theme.fg("dim", "· /subagents");
	const lines = [fit(`${title}${countParts.length ? ` ${countParts.join(theme.fg("dim", " · "))}` : ""} ${hint}`, width)];

	if (active.length === 0 && liveJobs.length === 0) {
		const terminal = terminalSummaryLine(agents, theme, nowMs, width);
		if (terminal) lines.push(terminal);
		const problem = problemHintLine(agents, theme, width);
		if (problem) lines.push(problem);
		return lines;
	}

	const activeRows = active.slice(0, maxActiveRows);
	for (const agent of activeRows) lines.push(renderAgentRow(agent, theme, nowMs, width));
	const hiddenActive = active.length - activeRows.length;
	if (hiddenActive > 0) lines.push(fit(theme.fg("dim", `… ${hiddenActive} more active subagent${hiddenActive === 1 ? "" : "s"}`), width));

	const remainingRows = Math.max(0, maxActiveRows - activeRows.length);
	for (const job of liveJobs.slice(0, remainingRows)) lines.push(renderJobRow(job, theme, width));
	if (liveJobs.length > remainingRows) lines.push(fit(theme.fg("dim", `… ${liveJobs.length - remainingRows} more active job${liveJobs.length - remainingRows === 1 ? "" : "s"}`), width));

	const terminal = terminalSummaryLine(agents, theme, nowMs, width);
	if (terminal) lines.push(terminal);
	const problem = problemHintLine(agents, theme, width);
	if (problem) lines.push(problem);
	return lines;
}
