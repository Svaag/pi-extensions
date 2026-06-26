import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, sep } from "node:path";

export type ChildWriteMode = "read_only" | "disjoint_scope" | "git_worktree";

export interface ChildPolicyConfig {
	agentId: string;
	writeMode: ChildWriteMode;
	allowedPaths: string[];
	cwd: string;
	maxOutputChars?: number;
}

const DEFAULT_POLICY: ChildPolicyConfig = {
	agentId: "unknown",
	writeMode: "read_only",
	allowedPaths: [],
	cwd: process.cwd(),
};

const DENIED_PATH_PARTS = new Set([".git", "node_modules"]);
const DENIED_FILE_NAMES = new Set([".env", ".env.local", ".env.production", ".npmrc", ".pypirc"]);

export function loadPolicy(env: NodeJS.ProcessEnv = process.env): ChildPolicyConfig {
	const raw = env.PI_SUBAGENT_POLICY;
	if (!raw) return DEFAULT_POLICY;
	try {
		const parsed = JSON.parse(raw) as Partial<ChildPolicyConfig>;
		return {
			agentId: typeof parsed.agentId === "string" ? parsed.agentId : DEFAULT_POLICY.agentId,
			writeMode: parsed.writeMode === "disjoint_scope" || parsed.writeMode === "git_worktree" ? parsed.writeMode : "read_only",
			allowedPaths: Array.isArray(parsed.allowedPaths) ? parsed.allowedPaths.filter((item): item is string => typeof item === "string") : [],
			cwd: typeof parsed.cwd === "string" ? parsed.cwd : process.cwd(),
			maxOutputChars: typeof parsed.maxOutputChars === "number" ? parsed.maxOutputChars : undefined,
		};
	} catch {
		return DEFAULT_POLICY;
	}
}

function normalizeCandidate(cwd: string, inputPath: unknown): string | undefined {
	if (typeof inputPath !== "string" || inputPath.trim() === "") return undefined;
	return resolve(cwd, inputPath.replace(/^@/, ""));
}

function isInside(candidate: string, root: string): boolean {
	const c = resolve(candidate);
	const r = resolve(root);
	return c === r || c.startsWith(`${r}${sep}`);
}

export function isDeniedPath(candidate: string): boolean {
	const parts = resolve(candidate).split(/[\\/]+/);
	if (parts.some((part) => DENIED_PATH_PARTS.has(part))) return true;
	return DENIED_FILE_NAMES.has(parts[parts.length - 1] ?? "");
}

export function isPathAllowed(candidate: string, policy: ChildPolicyConfig): boolean {
	if (isDeniedPath(candidate)) return false;
	if (policy.writeMode === "read_only") return false;
	if (policy.writeMode === "git_worktree") return false;
	if (policy.writeMode === "disjoint_scope") {
		return policy.allowedPaths.some((allowed) => isInside(candidate, allowed));
	}
	return false;
}

export function isReadPathAllowed(candidate: string, policy: ChildPolicyConfig): boolean {
	if (isDeniedPath(candidate)) return false;
	return isInside(candidate, policy.cwd) || policy.allowedPaths.some((allowed) => isInside(candidate, allowed));
}

export function isReadOnlyShellCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (/[;&|`$<>]/.test(trimmed.replace(/\|\|/g, ""))) return false;
	if (/(^|[\s/])(?:\.env(?:\.[A-Za-z0-9_-]+)?|\.npmrc|\.pypirc)(?:\s|$)/.test(trimmed)) return false;
	if (/\b(rm|mv|cp|chmod|chown|mkdir|touch|tee|curl|wget|python|node|perl|ruby|npm|pnpm|yarn|bun|pip|uv|cargo|go|make)\b/i.test(trimmed)) return false;
	if (/\b(--fix|--write|--in-place|-i|commit|checkout|switch|reset|rebase|merge|pull|push|add|apply)\b/i.test(trimmed)) return false;

	return /^(pwd|ls|find|grep|rg|cat|head|tail|wc|sed\s+-n|git\s+(status|log|diff|show|grep|ls-files|branch\s+(?:--list|-a|-r)?))(\s|$)/i.test(trimmed);
}

function toolPath(input: any): unknown {
	return input?.path ?? input?.file_path ?? input?.filePath;
}

function blocked(reason: string) {
	return { block: true, reason };
}

export default function subagentChildPolicy(pi: ExtensionAPI): void {
	const policy = loadPolicy();

	pi.on("tool_call", async (event: any) => {
		if (event.toolName === "read") {
			const candidate = normalizeCandidate(policy.cwd, toolPath(event.input));
			if (!candidate) return blocked(`Subagent ${policy.agentId}: missing target path for read.`);
			if (!isReadPathAllowed(candidate, policy)) return blocked(`Subagent ${policy.agentId}: read is not allowed for ${candidate}.`);
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			const candidate = normalizeCandidate(policy.cwd, toolPath(event.input));
			if (!candidate) return blocked(`Subagent ${policy.agentId}: missing target path for ${event.toolName}.`);
			if (!isPathAllowed(candidate, policy)) {
				return blocked(`Subagent ${policy.agentId}: ${event.toolName} is not allowed for ${candidate} in writeMode=${policy.writeMode}.`);
			}
		}

		if (event.toolName === "bash") {
			const command = String(event.input?.command ?? "");
			if (!isReadOnlyShellCommand(command)) {
				return blocked(`Subagent ${policy.agentId}: bash command blocked by read-only/disjoint-scope policy. Use read/edit/write tools within the allowed scope instead.`);
			}
		}
	});
}
