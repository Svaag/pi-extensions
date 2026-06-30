import { resolve, sep } from "node:path";
import type { AgentRecord, AgentStatus } from "./AgentTypes.ts";

let idCounter = 0;

export function nowMs(): number {
	return Date.now();
}

export function createId(prefix: string): string {
	idCounter += 1;
	const random = Math.random().toString(36).slice(2, 10);
	return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}_${random}`;
}

export function slugifyTaskName(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 48);
	return slug || "task";
}

export function normalizeTaskPath(path: string): string {
	const parts = path
		.split("/")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => slugifyTaskName(part));
	if (parts[0] === "root") return `/${parts.join("/")}`;
	return `/root/${parts.join("/")}`;
}

export function childTaskPath(parentTaskPath: string | undefined, taskName: string): string {
	const parent = parentTaskPath ? normalizeTaskPath(parentTaskPath) : "/root";
	return normalizeTaskPath(`${parent}/${slugifyTaskName(taskName)}`);
}

export function taskDepth(taskPath: string): number {
	return normalizeTaskPath(taskPath).split("/").filter(Boolean).length - 1;
}

export function isTerminalStatus(status: AgentStatus): boolean {
	return status === "succeeded" || status === "failed" || status === "interrupted" || status === "closed" || status === "lost";
}

export function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 32) return text.slice(0, maxChars);
	const marker = `\n\n[... ${text.length - maxChars} characters omitted ...]\n\n`;
	const available = Math.max(0, maxChars - marker.length);
	const head = Math.ceil(available * 0.55);
	const tail = available - head;
	return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`.slice(0, maxChars);
}

export function appendOutputTail(current: string, addition: string, maxChars: number): string {
	if (!addition) return current;
	const next = current + addition;
	if (next.length <= maxChars) return next;
	return next.slice(-maxChars);
}

export function summarizeText(text: string, maxChars = 400): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (!clean) return "";
	return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

export function resolveCwd(baseCwd: string, requestedCwd: string | undefined, allowedRoots: string[]): string {
	const cwd = resolve(baseCwd, requestedCwd ?? ".");
	const roots = allowedRoots.length > 0 ? allowedRoots.map((root) => resolve(baseCwd, root)) : [resolve(baseCwd)];
	if (!roots.some((root) => isPathInside(cwd, root))) {
		throw new Error(`cwd ${cwd} is outside allowed roots: ${roots.join(", ")}`);
	}
	return cwd;
}

export function resolvePathList(baseCwd: string, paths: string[] | undefined): string[] {
	return (paths ?? []).map((item) => resolve(baseCwd, item));
}

export function isPathInside(candidate: string, root: string): boolean {
	const normalizedCandidate = resolve(candidate);
	const normalizedRoot = resolve(root);
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

export function statusDurationMs(record: AgentRecord, now = nowMs()): number | undefined {
	if (!record.startedAt) return undefined;
	return (record.finishedAt ?? now) - record.startedAt;
}

export function recordAgeMs(record: AgentRecord, now = nowMs()): number {
	return now - record.createdAt;
}

export function shallowCloneRecord(record: AgentRecord): AgentRecord {
	return {
		...record,
		allowedPaths: [...record.allowedPaths],
		tools: record.tools ? [...record.tools] : undefined,
		result: record.result
			? {
					...record.result,
					artifacts: record.result.artifacts ? [...record.result.artifacts] : undefined,
					changedFiles: record.result.changedFiles ? [...record.result.changedFiles] : undefined,
					metrics: record.result.metrics ? { ...record.result.metrics } : undefined,
				}
			: undefined,
		routingDecision: record.routingDecision
			? {
					...record.routingDecision,
					candidates: record.routingDecision.candidates.map((candidate) => ({
						...candidate,
						notes: [...candidate.notes],
					})),
				}
			: undefined,
	};
}
