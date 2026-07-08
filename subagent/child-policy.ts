import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extname, resolve, sep } from "node:path";

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
const RAW_BINARY_EXTENSIONS = new Set([
	".db",
	".sqlite",
	".sqlite3",
	".bin",
	".dat",
	".parquet",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".pdf",
	".zip",
	".gz",
	".xz",
	".zst",
	".tar",
]);
const DEFAULT_TOOL_RESULT_CONTEXT_CAP = 24_000;
const MIN_TOOL_RESULT_CONTEXT_CAP = 4_000;
const MUTATING_SQL_RE = /\b(insert|update|delete|create|drop|alter|vacuum|attach|detach|reindex|replace|begin|commit|rollback|pragma\s+writable_schema)\b/i;

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

export function isRawBinaryPath(candidate: string): boolean {
	return RAW_BINARY_EXTENSIONS.has(extname(candidate).toLowerCase());
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

function containsSensitivePath(trimmed: string): boolean {
	return /(^|[\s/])(?:\.env(?:\.[A-Za-z0-9_-]+)?|\.npmrc|\.pypirc)(?:\s|$)/.test(trimmed);
}

function containsMutatingShell(trimmed: string): boolean {
	return /\b(rm|mv|cp|chmod|chown|mkdir|touch|tee|curl|wget|python|node|perl|ruby|npm|pnpm|yarn|bun|pip|uv|cargo|go|make)\b/i.test(trimmed)
		|| /\b(--fix|--write|--in-place|-i|commit|checkout|switch|reset|rebase|merge|pull|push|add|apply)\b/i.test(trimmed);
}

function isReadOnlySqliteCommand(part: string): boolean {
	if (!/^sqlite3\s+/i.test(part)) return false;
	if (!/(^|\s)-readonly(\s|$)|mode=ro\b/i.test(part)) return false;
	return !MUTATING_SQL_RE.test(part);
}

function isReadOnlyShellSegment(part: string): boolean {
	const trimmed = part.trim();
	if (!trimmed) return false;
	if (isReadOnlySqliteCommand(trimmed)) return true;
	return /^(pwd|ls|find|grep|rg|cat|head|tail|wc|sed)(\s|$)/i.test(trimmed)
		|| /^git\s+(status|log|diff|show|grep|ls-files|branch\s+(?:--list|-a|-r)?)(\s|$)/i.test(trimmed);
}

export function isReadOnlyShellCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (/[;`$<>]/.test(trimmed)) return false;
	if (/\|\|/.test(trimmed)) return false;
	if (containsSensitivePath(trimmed)) return false;
	if (containsMutatingShell(trimmed)) return false;

	return trimmed
		.split(/\s+&&\s+/)
		.every((andPart) => andPart.split(/\s+\|\s+/).every(isReadOnlyShellSegment));
}

function truncateMiddleText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 0) return "";
	const marker = `\n\n[... omitted ${text.length - maxChars} characters ...]\n\n`;
	if (maxChars <= marker.length + 20) return text.slice(0, maxChars);
	const remaining = maxChars - marker.length;
	const head = Math.ceil(remaining / 2);
	const tail = Math.floor(remaining / 2);
	return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

export function looksLikeBinaryText(text: string): boolean {
	if (text.includes("\u0000")) return true;
	const sample = text.slice(0, 8192);
	if (!sample) return false;
	let controls = 0;
	for (let i = 0; i < sample.length; i++) {
		const code = sample.charCodeAt(i);
		if ((code >= 0 && code < 9) || (code > 13 && code < 32) || code === 127) controls++;
	}
	return controls > 32 && controls / sample.length > 0.01;
}

function sanitizeControlText(text: string): string {
	return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "�");
}

export function capToolResultText(text: string, maxChars = DEFAULT_TOOL_RESULT_CONTEXT_CAP): { text: string; changed: boolean } {
	const cappedMax = Math.max(MIN_TOOL_RESULT_CONTEXT_CAP, Math.min(maxChars, DEFAULT_TOOL_RESULT_CONTEXT_CAP));
	const binary = looksLikeBinaryText(text);
	if (!binary && text.length <= cappedMax) return { text, changed: false };

	const marker = binary
		? `[Subagent child policy: likely binary/control-heavy tool output truncated from ${text.length} chars. Do not read raw binary/database files into context; use targeted textual summaries or read-only queries.]\n`
		: `[Subagent child policy: tool output truncated from ${text.length} chars to protect the child context window.]\n`;
	const safe = binary ? sanitizeControlText(text) : text;
	return {
		text: `${marker}${truncateMiddleText(safe, Math.max(0, cappedMax - marker.length))}`,
		changed: true,
	};
}

function capToolResultContent(content: any, maxChars: number): { content: any; changed: boolean } {
	if (!Array.isArray(content)) return { content, changed: false };
	let remaining = Math.max(MIN_TOOL_RESULT_CONTEXT_CAP, Math.min(maxChars, DEFAULT_TOOL_RESULT_CONTEXT_CAP));
	let changed = false;
	const mapped = content.map((part: any) => {
		if (part?.type !== "text" || typeof part.text !== "string") return part;
		if (remaining <= 0) {
			changed = true;
			return { ...part, text: "[Subagent child policy: additional text part omitted to protect the child context window.]" };
		}
		const capped = capToolResultText(part.text, remaining);
		changed ||= capped.changed;
		remaining -= capped.text.length;
		return capped.changed ? { ...part, text: capped.text } : part;
	});
	return { content: mapped, changed };
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
			if (isRawBinaryPath(candidate)) {
				return blocked(`Subagent ${policy.agentId}: raw reads of likely-binary file ${candidate} are blocked to protect the child context window. Use a read-only query/summary command or a textual artifact instead.`);
			}
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
				return blocked(`Subagent ${policy.agentId}: bash command blocked by read-only/disjoint-scope policy. Use conservative read-only commands (pwd/ls/find/rg/grep/cat/head/tail/wc/sed/git read-only/sqlite3 -readonly) or read/edit/write within the allowed scope.`);
			}
		}
	});

	pi.on("tool_result", async (event: any) => {
		const capped = capToolResultContent(event.content, policy.maxOutputChars ?? DEFAULT_TOOL_RESULT_CONTEXT_CAP);
		if (!capped.changed) return;
		return {
			content: capped.content,
			details: {
				...(event.details ?? {}),
				subagentPolicy: {
					...(event.details?.subagentPolicy ?? {}),
					toolResultTruncated: true,
					maxContextChars: Math.max(MIN_TOOL_RESULT_CONTEXT_CAP, Math.min(policy.maxOutputChars ?? DEFAULT_TOOL_RESULT_CONTEXT_CAP, DEFAULT_TOOL_RESULT_CONTEXT_CAP)),
				},
			},
		};
	});
}
