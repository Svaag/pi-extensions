import { createHmac, randomBytes } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const TELEMETRY_HASH_HEX_CHARS = 16;
export const TELEMETRY_KEY_BYTES = 32;
export const TELEMETRY_LABEL_MAX_CHARS = 80;

export type TelemetryHashScope = "machine" | "process";
export type TelemetryErrorCategory =
	| "context_window"
	| "timeout"
	| "rpc_protocol"
	| "rpc_closed"
	| "process_exit"
	| "policy_block"
	| "provider"
	| "cancelled"
	| "configuration"
	| "exporter"
	| "unknown";

export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttributeValue>>;

export interface TelemetryErrorInfo {
	category: TelemetryErrorCategory;
	type: string;
	messageHash: string;
}

export interface TelemetryPrivacy {
	readonly hashScope: TelemetryHashScope;
	readonly keyPath?: string;
	hashIdentifier(kind: string, value: string): string;
	sanitizeError(error: unknown): TelemetryErrorInfo;
}

export interface CreateTelemetryPrivacyOptions {
	env?: NodeJS.ProcessEnv;
	agentDir?: string;
	keyPath?: string;
}

export interface TelemetryKeyResult {
	key: Buffer;
	scope: TelemetryHashScope;
	keyPath?: string;
}

export const METRIC_ATTRIBUTE_KEYS = Object.freeze([
	"outcome",
	"error_category",
	"provider",
	"model",
	"thinking_level",
	"routing_mode",
	"routing_profile",
	"intent",
	"complexity_tier",
	"write_mode",
	"context_mode",
	"rpc_command",
	"tool_name",
	"delivery_mode",
	"batch_source",
	"recovery_type",
	"token.type",
	"message.kind",
] as const);

export const SPAN_LOG_ATTRIBUTE_KEYS = Object.freeze([
	...METRIC_ATTRIBUTE_KEYS,
	"agent.id",
	"parent_agent.id",
	"job.id",
	"batch.item.id",
	"session.id",
	"project.id",
	"task.id",
	"turn.id",
	"turn.kind",
	"rpc.request.id",
	"tool.call.id",
	"agent.status",
	"process.state",
	"process.pid",
	"agent.controllable",
	"prompt.chars",
	"output.chars",
	"queue.duration_ms",
	"startup.duration_ms",
	"first_progress.duration_ms",
	"turn.duration_ms",
	"process.duration_ms",
	"idle.duration_ms",
	"duration_ms",
	"turns",
	"tool.calls",
	"provider.requests",
	"compactions",
	"tokens.input",
	"tokens.output",
	"tokens.cache_read",
	"tokens.cache_write",
	"tokens.total",
	"cost.usd",
	"routing.complexity_score",
	"routing.estimated_input_tokens",
	"routing.estimated_output_tokens",
	"message.delivered",
	"message.queued",
	"batch.item.phase",
	"batch.max_concurrency",
	"batch.item_count",
	"batch.succeeded",
	"batch.failed",
	"batch.cancelled",
	"batch.lost",
	"result.chars",
	"result.truncated",
	"error.type",
	"error.message_hash",
	"telemetry.hash_scope",
	"telemetry.dropped",
] as const);

const METRIC_ATTRIBUTE_KEY_SET: ReadonlySet<string> = new Set(METRIC_ATTRIBUTE_KEYS);
const SPAN_LOG_ATTRIBUTE_KEY_SET: ReadonlySet<string> = new Set(SPAN_LOG_ATTRIBUTE_KEYS);

function telemetryAgentDir(env: NodeJS.ProcessEnv): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	return resolve(configured || join(homedir(), ".pi", "agent"));
}

export function defaultTelemetryKeyPath(options: Pick<CreateTelemetryPrivacyOptions, "env" | "agentDir"> = {}): string {
	const env = options.env ?? process.env;
	return join(resolve(options.agentDir ?? telemetryAgentDir(env)), "subagent-telemetry-key");
}

function validKey(data: Buffer): boolean {
	return data.length === TELEMETRY_KEY_BYTES;
}

async function readExistingKey(path: string): Promise<Buffer | undefined> {
	try {
		const data = await readFile(path);
		return validKey(data) ? data : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Load a machine-stable HMAC key, creating it with mode 0600 when necessary.
 * Any filesystem failure degrades to a process-random key rather than breaking Pi.
 */
export async function loadOrCreateTelemetryKey(options: CreateTelemetryPrivacyOptions = {}): Promise<TelemetryKeyResult> {
	const path = resolve(options.keyPath ?? defaultTelemetryKeyPath(options));
	const existing = await readExistingKey(path);
	if (existing) return { key: existing, scope: "machine", keyPath: path };

	const generated = randomBytes(TELEMETRY_KEY_BYTES);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		handle = await open(path, "wx", 0o600);
		await handle.writeFile(generated);
		await handle.sync();
		await handle.close();
		handle = undefined;
		return { key: generated, scope: "machine", keyPath: path };
	} catch (error: any) {
		if (handle) {
			try { await handle.close(); } catch { /* ignore cleanup failure */ }
			try { await unlink(path); } catch { /* another process may own the path */ }
		}
		if (error?.code === "EEXIST") {
			const raced = await readExistingKey(path);
			if (raced) return { key: raced, scope: "machine", keyPath: path };
		}
		return { key: generated, scope: "process" };
	}
}

function messageFromError(error: unknown): string {
	try {
		if (error instanceof Error) return typeof error.message === "string" ? error.message : "unknown error";
		if (typeof error === "string") return error;
		return String(error ?? "unknown error");
	} catch {
		return "unprintable error";
	}
}

export function telemetryErrorType(error: unknown): string {
	try {
		if (error instanceof Error) return normalizeTelemetryLabel(error.constructor?.name || error.name || "Error");
		return normalizeTelemetryLabel(typeof error === "string" ? "ErrorString" : typeof error);
	} catch {
		return "Error";
	}
}

export function classifyTelemetryError(error: unknown): TelemetryErrorCategory {
	const text = messageFromError(error).toLowerCase();
	if (/context window|context length|maximum context|too many tokens|input exceeds/.test(text)) return "context_window";
	if (/timed?\s*out|deadline|timeout/.test(text)) return "timeout";
	if (/malformed|invalid json|jsonl|protocol|frame|parse error/.test(text)) return "rpc_protocol";
	if (/exporter|otlp|collector|telemetry export/.test(text)) return "exporter";
	if (/rpc process closed|rpc.*not writable|broken pipe|econnreset|channel closed|connection closed/.test(text)) return "rpc_closed";
	if (/child process exited|process exited|sigterm|sigkill|spawn .*enoent/.test(text)) return "process_exit";
	if (/child policy|policy.*block|not allowed|permission denied|write mode/.test(text)) return "policy_block";
	if (/aborted|abort|cancelled|canceled|interrupted/.test(text)) return "cancelled";
	if (/configuration|config |invalid endpoint|invalid model|unknown model|missing .*config/.test(text)) return "configuration";
	if (/provider|model error|rate limit|429|402|authentication|unauthorized|api key/.test(text)) return "provider";
	return "unknown";
}

export class HmacTelemetryPrivacy implements TelemetryPrivacy {
	readonly hashScope: TelemetryHashScope;
	readonly keyPath?: string;
	readonly #key: Buffer;

	constructor(result: TelemetryKeyResult) {
		this.#key = Buffer.from(result.key);
		this.hashScope = result.scope;
		this.keyPath = result.keyPath;
	}

	hashIdentifier(kind: string, value: string): string {
		return createHmac("sha256", this.#key)
			.update(kind, "utf8")
			.update("\0", "utf8")
			.update(value, "utf8")
			.digest("hex")
			.slice(0, TELEMETRY_HASH_HEX_CHARS);
	}

	sanitizeError(error: unknown): TelemetryErrorInfo {
		return {
			category: classifyTelemetryError(error),
			type: telemetryErrorType(error),
			messageHash: this.hashIdentifier("error", messageFromError(error)),
		};
	}
}

export async function createTelemetryPrivacy(options: CreateTelemetryPrivacyOptions = {}): Promise<TelemetryPrivacy> {
	return new HmacTelemetryPrivacy(await loadOrCreateTelemetryKey(options));
}

/** Normalize bounded metadata label values; empty/unusable values become `other`. */
export function normalizeTelemetryLabel(value: unknown, maxChars = TELEMETRY_LABEL_MAX_CHARS): string {
	if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "other";
	const normalized = String(value)
		.trim()
		.replace(/[^A-Za-z0-9._:/-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, Math.max(1, maxChars));
	return normalized || "other";
}

function safeAttributeValue(value: unknown): TelemetryAttributeValue | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string") return normalizeTelemetryLabel(value);
	return undefined;
}

export function filterTelemetryAttributes(
	attributes: Readonly<Record<string, unknown>>,
	allowedKeys: ReadonlySet<string>,
): TelemetryAttributes {
	const filtered: Record<string, TelemetryAttributeValue> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (!allowedKeys.has(key)) continue;
		const safe = safeAttributeValue(value);
		if (safe !== undefined) filtered[key] = safe;
	}
	return Object.freeze(filtered);
}

export function filterMetricAttributes(attributes: Readonly<Record<string, unknown>>): TelemetryAttributes {
	return filterTelemetryAttributes(attributes, METRIC_ATTRIBUTE_KEY_SET);
}

export function filterSpanLogAttributes(attributes: Readonly<Record<string, unknown>>): TelemetryAttributes {
	return filterTelemetryAttributes(attributes, SPAN_LOG_ATTRIBUTE_KEY_SET);
}
