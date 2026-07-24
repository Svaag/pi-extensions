import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "./AgentTypes.ts";

const CONFIG_DIR_NAME = ".pi";

function getDefaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), CONFIG_DIR_NAME, "agent");
}

export interface ModelCostLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface ModelLike {
	id: string;
	provider?: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: ModelCostLike;
	[key: string]: unknown;
}

export interface ScopedModelPattern {
	raw: string;
	pattern: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ScopedModelMatch {
	model: ModelLike;
	ref: string;
	pattern: string;
	patternRaw: string;
	scopedThinkingLevel?: ThinkingLevel;
}

export interface LoadScopedModelPatternOptions {
	projectTrusted?: boolean;
	agentDir?: string;
	configDirName?: string;
}

export interface ModelRegistryLike {
	getAvailable(): Promise<ModelLike[]>;
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		return isObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function normalizeEnabledModels(value: unknown): string[] | undefined {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	if (typeof value === "string" && value.trim()) {
		return value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}
	return undefined;
}

function findNearestSettingsFile(cwd: string, configDirName = CONFIG_DIR_NAME): string | undefined {
	let currentDir = cwd;
	while (true) {
		const candidate = join(currentDir, configDirName, "settings.json");
		if (existsSync(candidate)) return candidate;
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return undefined;
		currentDir = parentDir;
	}
}

export function parseScopedModelPattern(rawPattern: string): ScopedModelPattern | undefined {
	const raw = rawPattern.trim();
	if (!raw) return undefined;
	const lastColon = raw.lastIndexOf(":");
	if (lastColon > 0) {
		const suffix = raw.slice(lastColon + 1) as ThinkingLevel;
		if (THINKING_LEVELS.has(suffix)) {
			const pattern = raw.slice(0, lastColon).trim();
			if (pattern) return { raw, pattern, thinkingLevel: suffix };
		}
	}
	return { raw, pattern: raw };
}

export function loadScopedModelPatterns(cwd: string, options: LoadScopedModelPatternOptions = {}): ScopedModelPattern[] {
	const agentDir = options.agentDir ?? getDefaultAgentDir();
	const globalSettings = readJsonObject(join(agentDir, "settings.json"));
	let patterns = normalizeEnabledModels(globalSettings?.enabledModels) ?? [];

	if (options.projectTrusted) {
		const projectSettingsPath = findNearestSettingsFile(cwd, options.configDirName ?? CONFIG_DIR_NAME);
		const projectSettings = projectSettingsPath ? readJsonObject(projectSettingsPath) : undefined;
		const projectPatterns = normalizeEnabledModels(projectSettings?.enabledModels);
		if (projectPatterns) patterns = projectPatterns;
	}

	return patterns.map(parseScopedModelPattern).filter((pattern): pattern is ScopedModelPattern => Boolean(pattern));
}

export function modelRef(model: ModelLike): string {
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function hasGlob(pattern: string): boolean {
	return /[*?]/.test(pattern);
}

function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (const ch of pattern) {
		if (ch === "*") source += ".*";
		else if (ch === "?") source += ".";
		else source += escapeRegex(ch);
	}
	return new RegExp(`^${source}$`, "i");
}

function textFields(model: ModelLike): string[] {
	return [modelRef(model), model.id, model.name ?? ""].filter(Boolean);
}

export function matchesModelPattern(model: ModelLike, pattern: string): boolean {
	const trimmed = pattern.trim();
	if (!trimmed) return false;
	const fields = textFields(model);
	if (hasGlob(trimmed)) {
		const regex = globToRegExp(trimmed);
		return fields.some((field) => regex.test(field));
	}
	const lower = trimmed.toLowerCase();
	return fields.some((field) => {
		const candidate = field.toLowerCase();
		return candidate === lower || candidate.includes(lower);
	});
}

export function isExactPattern(pattern: string): boolean {
	return !hasGlob(pattern);
}

export function filterScopedModels(models: ModelLike[], patterns: ScopedModelPattern[]): ScopedModelMatch[] {
	const matches: ScopedModelMatch[] = [];
	const seen = new Set<string>();
	for (const pattern of patterns) {
		for (const model of models) {
			const ref = modelRef(model);
			if (seen.has(ref)) continue;
			if (!matchesModelPattern(model, pattern.pattern)) continue;
			seen.add(ref);
			matches.push({
				model,
				ref,
				pattern: pattern.pattern,
				patternRaw: pattern.raw,
				scopedThinkingLevel: pattern.thinkingLevel,
			});
		}
	}
	return matches;
}

export async function getAvailableScopedModels(
	modelRegistry: ModelRegistryLike,
	cwd: string,
	options: LoadScopedModelPatternOptions = {},
): Promise<ScopedModelMatch[]> {
	const patterns = loadScopedModelPatterns(cwd, options);
	if (patterns.length === 0) return [];
	const availableModels = await modelRegistry.getAvailable();
	return filterScopedModels(availableModels, patterns);
}
