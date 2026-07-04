import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ComplexityTier, RoutingObjective, TaskIntent } from "./AgentTypes.ts";

const CONFIG_DIR_NAME = ".pi";

function getDefaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), CONFIG_DIR_NAME, "agent");
}

export type RouterCandidateSource = "scoped";
export type RouterFallbackWhenNoScopedModels = "current_model" | "none";
export type RouterZeroCostPolicy = "trust" | "penalize";
export type RouterClassifierEnabled = "auto" | boolean;

export interface RouterComplexityThresholds {
	trivialMax: number;
	simpleMax: number;
	moderateMax: number;
	complexMax: number;
}

export type RouterTierQualityFloor = Record<ComplexityTier, number>;

export interface RouterComplexityConfig {
	thresholds: RouterComplexityThresholds;
	tierQualityFloor: RouterTierQualityFloor;
}

export const DEFAULT_COMPLEXITY_THRESHOLDS: RouterComplexityThresholds = {
	trivialMax: 0.2,
	simpleMax: 0.38,
	moderateMax: 0.58,
	complexMax: 0.78,
};

export const DEFAULT_TIER_QUALITY_FLOOR: RouterTierQualityFloor = {
	trivial: 0.2,
	simple: 0.4,
	moderate: 0.6,
	complex: 0.78,
	critical: 0.9,
};

export interface RouterClassifierConfig {
	enabled: RouterClassifierEnabled;
	requireLocalOrZeroCost: boolean;
	maxEstimatedCostUsd: number;
	maxPromptChars: number;
	timeoutMs: number;
	model?: string;
}

export interface RouterModelProfileOverride {
	quality?: number;
	speed?: number;
	preferredIntents?: TaskIntent[];
	preferredTiers?: ComplexityTier[];
	notes?: string[];
}

export interface RouterConfig {
	enabled: boolean;
	objective: RoutingObjective;
	candidateSource: RouterCandidateSource;
	fallbackWhenNoScopedModels: RouterFallbackWhenNoScopedModels;
	showExplanations: boolean;
	zeroCostPolicy: RouterZeroCostPolicy;
	complexity: RouterComplexityConfig;
	classifier: RouterClassifierConfig;
	modelProfiles: Record<string, RouterModelProfileOverride>;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
	enabled: true,
	objective: "balanced",
	candidateSource: "scoped",
	fallbackWhenNoScopedModels: "current_model",
	showExplanations: true,
	zeroCostPolicy: "trust",
	complexity: {
		thresholds: { ...DEFAULT_COMPLEXITY_THRESHOLDS },
		tierQualityFloor: { ...DEFAULT_TIER_QUALITY_FLOOR },
	},
	classifier: {
		enabled: "auto",
		requireLocalOrZeroCost: true,
		maxEstimatedCostUsd: 0.001,
		maxPromptChars: 4000,
		timeoutMs: 10_000,
	},
	modelProfiles: {},
};

export interface LoadRouterConfigOptions {
	projectTrusted?: boolean;
	agentDir?: string;
	configDirName?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneDefaultConfig(): RouterConfig {
	return {
		...DEFAULT_ROUTER_CONFIG,
		complexity: {
			thresholds: { ...DEFAULT_ROUTER_CONFIG.complexity.thresholds },
			tierQualityFloor: { ...DEFAULT_ROUTER_CONFIG.complexity.tierQualityFloor },
		},
		classifier: { ...DEFAULT_ROUTER_CONFIG.classifier },
		modelProfiles: { ...DEFAULT_ROUTER_CONFIG.modelProfiles },
	};
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

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min = 0): number {
	return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

function asStringEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function asClassifierEnabled(value: unknown, fallback: RouterClassifierEnabled): RouterClassifierEnabled {
	if (typeof value === "boolean") return value;
	return value === "auto" ? "auto" : fallback;
}

function sanitizeProfileOverride(value: unknown): RouterModelProfileOverride | undefined {
	if (!isObject(value)) return undefined;
	const override: RouterModelProfileOverride = {};
	if (typeof value.quality === "number" && Number.isFinite(value.quality)) override.quality = clamp01(value.quality);
	if (typeof value.speed === "number" && Number.isFinite(value.speed)) override.speed = clamp01(value.speed);
	if (Array.isArray(value.preferredIntents)) {
		override.preferredIntents = value.preferredIntents.filter((item): item is TaskIntent =>
			typeof item === "string" && TASK_INTENTS.has(item as TaskIntent),
		);
	}
	if (Array.isArray(value.preferredTiers)) {
		override.preferredTiers = value.preferredTiers.filter((item): item is ComplexityTier =>
			typeof item === "string" && COMPLEXITY_TIERS.has(item as ComplexityTier),
		);
	}
	if (Array.isArray(value.notes)) override.notes = value.notes.filter((item): item is string => typeof item === "string");
	return Object.keys(override).length > 0 ? override : undefined;
}

function sanitizeModelProfiles(value: unknown, fallback: Record<string, RouterModelProfileOverride>): Record<string, RouterModelProfileOverride> {
	if (!isObject(value)) return { ...fallback };
	const next: Record<string, RouterModelProfileOverride> = { ...fallback };
	for (const [pattern, rawOverride] of Object.entries(value)) {
		const override = sanitizeProfileOverride(rawOverride);
		if (override) next[pattern] = { ...(next[pattern] ?? {}), ...override };
	}
	return next;
}

const TASK_INTENTS = new Set<TaskIntent>([
	"lookup",
	"scout",
	"summarize",
	"batch_simple",
	"plan",
	"review",
	"debug",
	"implement",
	"complex",
]);

const COMPLEXITY_TIERS = new Set<ComplexityTier>(["trivial", "simple", "moderate", "complex", "critical"]);

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function asUnitNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : fallback;
}

function sanitizeComplexityThresholds(value: unknown, fallback: RouterComplexityThresholds): RouterComplexityThresholds {
	if (!isObject(value)) return { ...fallback };
	const thresholds: RouterComplexityThresholds = {
		trivialMax: asUnitNumber(value.trivialMax, fallback.trivialMax),
		simpleMax: asUnitNumber(value.simpleMax, fallback.simpleMax),
		moderateMax: asUnitNumber(value.moderateMax, fallback.moderateMax),
		complexMax: asUnitNumber(value.complexMax, fallback.complexMax),
	};
	if (
		thresholds.trivialMax <= 0 ||
		thresholds.trivialMax >= thresholds.simpleMax ||
		thresholds.simpleMax >= thresholds.moderateMax ||
		thresholds.moderateMax >= thresholds.complexMax ||
		thresholds.complexMax >= 1
	) {
		return { ...fallback };
	}
	return thresholds;
}

function sanitizeTierQualityFloor(value: unknown, fallback: RouterTierQualityFloor): RouterTierQualityFloor {
	if (!isObject(value)) return { ...fallback };
	return {
		trivial: asUnitNumber(value.trivial, fallback.trivial),
		simple: asUnitNumber(value.simple, fallback.simple),
		moderate: asUnitNumber(value.moderate, fallback.moderate),
		complex: asUnitNumber(value.complex, fallback.complex),
		critical: asUnitNumber(value.critical, fallback.critical),
	};
}

function sanitizeComplexityConfig(value: unknown, fallback: RouterComplexityConfig): RouterComplexityConfig {
	const patch = isObject(value) ? value : {};
	return {
		thresholds: sanitizeComplexityThresholds(patch.thresholds, fallback.thresholds),
		tierQualityFloor: sanitizeTierQualityFloor(patch.tierQualityFloor, fallback.tierQualityFloor),
	};
}

export function mergeRouterConfig(base: RouterConfig, rawPatch: unknown): RouterConfig {
	if (!isObject(rawPatch)) return base;
	const classifierPatch = isObject(rawPatch.classifier) ? rawPatch.classifier : {};
	return {
		enabled: asBoolean(rawPatch.enabled, base.enabled),
		objective: asStringEnum(rawPatch.objective, ["balanced", "cost_first", "quality_first"] as const, base.objective),
		candidateSource: asStringEnum(rawPatch.candidateSource, ["scoped"] as const, base.candidateSource),
		fallbackWhenNoScopedModels: asStringEnum(rawPatch.fallbackWhenNoScopedModels, ["current_model", "none"] as const, base.fallbackWhenNoScopedModels),
		showExplanations: asBoolean(rawPatch.showExplanations, base.showExplanations),
		zeroCostPolicy: asStringEnum(rawPatch.zeroCostPolicy, ["trust", "penalize"] as const, base.zeroCostPolicy),
		complexity: sanitizeComplexityConfig(rawPatch.complexity, base.complexity),
		classifier: {
			enabled: asClassifierEnabled(classifierPatch.enabled, base.classifier.enabled),
			requireLocalOrZeroCost: asBoolean(classifierPatch.requireLocalOrZeroCost, base.classifier.requireLocalOrZeroCost),
			maxEstimatedCostUsd: asNumber(classifierPatch.maxEstimatedCostUsd, base.classifier.maxEstimatedCostUsd),
			maxPromptChars: Math.floor(asNumber(classifierPatch.maxPromptChars, base.classifier.maxPromptChars, 256)),
			timeoutMs: Math.floor(asNumber(classifierPatch.timeoutMs, base.classifier.timeoutMs, 1000)),
			model: typeof classifierPatch.model === "string" ? classifierPatch.model : base.classifier.model,
		},
		modelProfiles: sanitizeModelProfiles(rawPatch.modelProfiles ?? rawPatch.profiles, base.modelProfiles),
	};
}

export function findNearestProjectConfigFile(cwd: string, filename: string, configDirName = CONFIG_DIR_NAME): string | undefined {
	let currentDir = cwd;
	while (true) {
		const candidate = join(currentDir, configDirName, filename);
		if (existsSync(candidate)) return candidate;
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return undefined;
		currentDir = parentDir;
	}
}

export function loadRouterConfig(cwd: string, options: LoadRouterConfigOptions = {}): RouterConfig {
	const agentDir = options.agentDir ?? getDefaultAgentDir();
	let config = cloneDefaultConfig();
	config = mergeRouterConfig(config, readJsonObject(join(agentDir, "subagent-router.json")));

	if (options.projectTrusted) {
		const projectConfig = findNearestProjectConfigFile(cwd, "subagent-router.json", options.configDirName ?? CONFIG_DIR_NAME);
		if (projectConfig) config = mergeRouterConfig(config, readJsonObject(projectConfig));
	}

	return config;
}
