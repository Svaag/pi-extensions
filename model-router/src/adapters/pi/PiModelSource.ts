import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RoutingCandidate, ThinkingLevel } from "../../core/types.ts";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface PiModelLike {
	id: string;
	provider?: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	[key: string]: unknown;
}

export interface PiModelRegistryLike {
	getAvailable(): Promise<PiModelLike[]>;
	getApiKeyAndHeaders(model: PiModelLike): Promise<{ ok: boolean; apiKey?: string; error?: string; headers?: Record<string, string>; env?: Record<string, string> }>;
	find(provider: string, modelId: string): PiModelLike | undefined;
}

export interface PiModelSourceOptions {
	agentDir?: string;
	configDirName?: string;
}

export interface PiModelSourceRequest {
	cwd: string;
	projectTrusted: boolean;
	modelRegistry: PiModelRegistryLike;
}

export interface PiModelSnapshot {
	candidates: RoutingCandidate[];
	modelsByRef: ReadonlyMap<string, PiModelLike>;
	patterns: readonly string[];
	warnings: readonly string[];
}

interface ScopedPattern {
	pattern: string;
	thinkingLevel?: ThinkingLevel;
}

function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function readSettings(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function enabledModels(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function nearestProjectSettings(cwd: string, configDirName: string): string | undefined {
	let current = cwd;
	while (true) {
		const candidate = join(current, configDirName, "settings.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function parsePattern(raw: string): ScopedPattern {
	const colon = raw.lastIndexOf(":");
	if (colon > 0) {
		const suffix = raw.slice(colon + 1) as ThinkingLevel;
		if (THINKING_LEVELS.includes(suffix)) return { pattern: raw.slice(0, colon), thinkingLevel: suffix };
	}
	return { pattern: raw };
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function matcher(pattern: string): RegExp {
	let source = "";
	for (const character of pattern) {
		if (character === "*") source += ".*";
		else if (character === "?") source += ".";
		else source += escapeRegex(character);
	}
	return new RegExp(`^${source}$`, "i");
}

export function piModelRef(model: PiModelLike): string {
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function matches(model: PiModelLike, pattern: string): boolean {
	const fields = [piModelRef(model), model.id, model.name ?? ""];
	if (/[?*]/.test(pattern)) {
		const expression = matcher(pattern);
		return fields.some((field) => expression.test(field));
	}
	const expected = pattern.toLowerCase();
	return fields.some((field) => field.toLowerCase() === expected || field.toLowerCase().includes(expected));
}

function supportedThinkingLevels(model: PiModelLike): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	const map = model.thinkingLevelMap;
	return THINKING_LEVELS.filter((level) => {
		if (map && Object.prototype.hasOwnProperty.call(map, level)) return map[level] !== null;
		return level !== "xhigh" && level !== "max";
	});
}

function toCandidate(model: PiModelLike, scopedThinkingLevel: ThinkingLevel | undefined): RoutingCandidate {
	return {
		id: model.id,
		provider: model.provider,
		name: model.name,
		api: model.api,
		reasoning: Boolean(model.reasoning),
		input: Array.isArray(model.input) ? [...model.input] : ["text"],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: model.cost ? { ...model.cost } : undefined,
		thinkingLevels: supportedThinkingLevels(model),
		scopedThinkingLevel,
		authenticated: true,
		available: true,
	};
}

export class PiModelSource {
	private readonly agentDir: string;
	private readonly configDirName: string;

	constructor(options: PiModelSourceOptions = {}) {
		this.agentDir = options.agentDir ?? defaultAgentDir();
		this.configDirName = options.configDirName ?? ".pi";
	}

	async snapshot(request: PiModelSourceRequest): Promise<PiModelSnapshot> {
		const warnings: string[] = [];
		const global = readSettings(join(this.agentDir, "settings.json"));
		let rawPatterns = enabledModels(global?.enabledModels) ?? [];
		if (request.projectTrusted) {
			const projectPath = nearestProjectSettings(request.cwd, this.configDirName);
			const project = projectPath ? readSettings(projectPath) : undefined;
			const projectPatterns = enabledModels(project?.enabledModels);
			if (projectPatterns !== undefined) rawPatterns = projectPatterns;
		}
		if (rawPatterns.length === 0) warnings.push("enabled_models_not_configured");

		/*
		 * Pi's extension API exposes authenticated models, but not the effective
		 * enabledModels list nor whether a model change came from the user. We use
		 * only trusted settings and intersect those patterns with getAvailable().
		 * CLI --models overlays that are not reflected in settings cannot be seen;
		 * the bounded safe failure is an empty pool (the current model is retained).
		 */
		const patterns = rawPatterns.map(parsePattern);
		let available: PiModelLike[] = [];
		try {
			available = await request.modelRegistry.getAvailable();
		} catch {
			warnings.push("model_discovery_failed");
		}

		const candidates: RoutingCandidate[] = [];
		const modelsByRef = new Map<string, PiModelLike>();
		const seen = new Set<string>();
		for (const scoped of patterns) {
			for (const model of available) {
				const ref = piModelRef(model);
				if (seen.has(ref) || ref.toLowerCase().startsWith("model-router/")) continue;
				if (!matches(model, scoped.pattern)) continue;
				if (scoped.thinkingLevel && !supportedThinkingLevels(model).includes(scoped.thinkingLevel)) continue;
				let authenticated = false;
				try {
					const auth = await request.modelRegistry.getApiKeyAndHeaders(model);
					authenticated = auth.ok;
				} catch {
					authenticated = false;
				}
				if (!authenticated) continue;
				seen.add(ref);
				modelsByRef.set(ref, model);
				candidates.push(toCandidate(model, scoped.thinkingLevel));
			}
		}
		if (rawPatterns.length > 0 && candidates.length === 0) warnings.push("no_enabled_authenticated_models");
		return { candidates, modelsByRef, patterns: rawPatterns, warnings };
	}
}
