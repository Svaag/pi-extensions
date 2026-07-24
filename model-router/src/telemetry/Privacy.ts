import { createHmac, randomBytes } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const ROUTER_TELEMETRY_HASH_HEX_CHARS = 16;
export const ROUTER_TELEMETRY_KEY_BYTES = 32;
export const ROUTER_TELEMETRY_LABEL_MAX_CHARS = 80;

export type RouterTelemetryHashScope = "machine" | "process";
export type RouterTelemetryAttributeValue = string | number | boolean;
export type RouterTelemetryAttributes = Readonly<Record<string, RouterTelemetryAttributeValue>>;

export interface RouterTelemetryPrivacy {
	readonly hashScope: RouterTelemetryHashScope;
	readonly keyPath?: string;
	hashIdentifier(kind: string, value: string): string;
}

export interface CreateRouterTelemetryPrivacyOptions {
	env?: NodeJS.ProcessEnv;
	agentDir?: string;
	keyPath?: string;
}

export interface RouterTelemetryKeyResult {
	key: Buffer;
	scope: RouterTelemetryHashScope;
	keyPath?: string;
}

/** The router intentionally shares the promoted Subagent machine key. */
export function defaultRouterTelemetryKeyPath(options: Pick<CreateRouterTelemetryPrivacyOptions, "env" | "agentDir"> = {}): string {
	const env = options.env ?? process.env;
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	const agentDir = resolve(options.agentDir ?? (configured || join(homedir(), ".pi", "agent")));
	return join(agentDir, "subagent-telemetry-key");
}

async function readValidKey(path: string): Promise<Buffer | undefined> {
	try {
		const key = await readFile(path);
		return key.length === ROUTER_TELEMETRY_KEY_BYTES ? key : undefined;
	} catch {
		return undefined;
	}
}

/** Filesystem failure degrades to a process key and can never break routing. */
export async function loadOrCreateRouterTelemetryKey(options: CreateRouterTelemetryPrivacyOptions = {}): Promise<RouterTelemetryKeyResult> {
	const path = resolve(options.keyPath ?? defaultRouterTelemetryKeyPath(options));
	const existing = await readValidKey(path);
	if (existing) return { key: existing, scope: "machine", keyPath: path };
	const generated = randomBytes(ROUTER_TELEMETRY_KEY_BYTES);
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
			try { await handle.close(); } catch { /* non-fatal cleanup */ }
			try { await unlink(path); } catch { /* another process may own it */ }
		}
		if (error?.code === "EEXIST") {
			const raced = await readValidKey(path);
			if (raced) return { key: raced, scope: "machine", keyPath: path };
		}
		return { key: generated, scope: "process" };
	}
}

export class HmacRouterTelemetryPrivacy implements RouterTelemetryPrivacy {
	readonly hashScope: RouterTelemetryHashScope;
	readonly keyPath?: string;
	readonly #key: Buffer;

	constructor(result: RouterTelemetryKeyResult) {
		this.#key = Buffer.from(result.key);
		this.hashScope = result.scope;
		this.keyPath = result.keyPath;
	}

	hashIdentifier(kind: string, value: string): string {
		return createHmac("sha256", this.#key)
			.update(kind, "utf8").update("\0", "utf8").update(value, "utf8")
			.digest("hex").slice(0, ROUTER_TELEMETRY_HASH_HEX_CHARS);
	}
}

export async function createRouterTelemetryPrivacy(options: CreateRouterTelemetryPrivacyOptions = {}): Promise<RouterTelemetryPrivacy> {
	return new HmacRouterTelemetryPrivacy(await loadOrCreateRouterTelemetryKey(options));
}

export const ROUTER_METRIC_ATTRIBUTE_KEYS = Object.freeze([
	"host", "granularity", "profile", "stage", "arm", "outcome", "failure_domain",
	"provider", "model", "thinking_level", "intent", "complexity_tier", "quality_source",
	"fallback", "transition",
] as const);

export const ROUTER_SPAN_ATTRIBUTE_KEYS = Object.freeze([
	...ROUTER_METRIC_ATTRIBUTE_KEYS,
	"route.id", "project.id", "session.id", "task.id", "telemetry.hash_scope",
	"route.applied", "route.forced", "route.candidate_count", "route.constraint_count",
	"route.estimated_input_tokens", "route.estimated_output_tokens", "route.estimated_cost_usd",
	"route.estimated_p95_latency_ms", "latency_ms", "first_token_ms", "cost.usd",
	"quality.score", "provider.requests", "tool.calls", "context_overflow",
	"rollout.completed_count", "rollout.quality_label_count", "rollout.outcome_coverage_count",
	"rollout.cost_coverage_count", "rollout.latency_coverage_count",
] as const);

const METRIC_KEYS: ReadonlySet<string> = new Set(ROUTER_METRIC_ATTRIBUTE_KEYS);
const SPAN_KEYS: ReadonlySet<string> = new Set(ROUTER_SPAN_ATTRIBUTE_KEYS);

export function normalizeRouterTelemetryLabel(value: unknown, maxChars = ROUTER_TELEMETRY_LABEL_MAX_CHARS): string {
	if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "other";
	const normalized = String(value).trim().replace(/[^A-Za-z0-9._:/-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, Math.max(1, maxChars));
	return normalized || "other";
}

function safeValue(value: unknown): RouterTelemetryAttributeValue | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string") return normalizeRouterTelemetryLabel(value);
	return undefined;
}

export function filterRouterTelemetryAttributes(attributes: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): RouterTelemetryAttributes {
	const result: Record<string, RouterTelemetryAttributeValue> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (!allowed.has(key)) continue;
		const safe = safeValue(value);
		if (safe !== undefined) result[key] = safe;
	}
	return Object.freeze(result);
}

export function filterRouterMetricAttributes(attributes: Readonly<Record<string, unknown>>): RouterTelemetryAttributes {
	return filterRouterTelemetryAttributes(attributes, METRIC_KEYS);
}

export function filterRouterSpanAttributes(attributes: Readonly<Record<string, unknown>>): RouterTelemetryAttributes {
	return filterRouterTelemetryAttributes(attributes, SPAN_KEYS);
}
