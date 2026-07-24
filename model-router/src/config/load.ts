import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { COMPLEXITY_TIERS, ROUTING_PROFILES, TASK_INTENTS } from "../core/types.ts";
import { DEFAULT_ROUTER_CONFIG } from "./defaults.ts";
import { migrateLegacyRouterConfig } from "./migrateLegacy.ts";
import type { LoadRouterConfigOptions, RouterConfig, RouterModelProfileOverride } from "./schema.ts";

const ROUTER_FILE = "model-router.json";
const LEGACY_FILE = "subagent-router.json";

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function readJson(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return isObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function findNearestConfigFile(cwd: string, filename: string, configDirName = ".pi"): string | undefined {
	let current = cwd;
	while (true) {
		const candidate = join(current, configDirName, filename);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function number(value: unknown, fallback: number, min = 0, max = Number.POSITIVE_INFINITY): number {
	return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function integer(value: unknown, fallback: number, min = 0): number {
	return Math.floor(number(value, fallback, min));
}

function boolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [...fallback];
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function unitRecord(value: unknown, fallback: Record<string, number>): Record<string, number> {
	const raw = isObject(value) ? value : {};
	return Object.fromEntries(Object.entries(fallback).map(([key, current]) => [key, number(raw[key], current, 0, 1)]));
}

function sanitizeProfiles(value: unknown, fallback: RouterConfig["profiles"]): RouterConfig["profiles"] {
	const raw = isObject(value) ? value : {};
	const result = clone(fallback);
	for (const name of ROUTING_PROFILES) {
		const item = isObject(raw[name]) ? raw[name] : {};
		const weights = isObject(item.weights) ? item.weights : {};
		const current = result[name];
		result[name] = {
			maxCostRatio: item.maxCostRatio === undefined ? current.maxCostRatio : number(item.maxCostRatio, current.maxCostRatio ?? 1, 0),
			maxP95LatencyRatio: item.maxP95LatencyRatio === undefined ? current.maxP95LatencyRatio : number(item.maxP95LatencyRatio, current.maxP95LatencyRatio ?? 1, 0),
			maxCostUsd: item.maxCostUsd === undefined ? current.maxCostUsd : number(item.maxCostUsd, current.maxCostUsd ?? 0, 0),
			maxP95LatencyMs: item.maxP95LatencyMs === undefined ? current.maxP95LatencyMs : number(item.maxP95LatencyMs, current.maxP95LatencyMs ?? 0, 0),
			weights: {
				quality: number(weights.quality, current.weights.quality, 0, 1),
				reliability: number(weights.reliability, current.weights.reliability, 0, 1),
				cost: number(weights.cost, current.weights.cost, 0, 1),
				latency: number(weights.latency, current.weights.latency, 0, 1),
			},
		};
	}
	return result;
}

function sanitizeModelProfiles(value: unknown, fallback: Record<string, RouterModelProfileOverride>): Record<string, RouterModelProfileOverride> {
	if (!isObject(value)) return clone(fallback);
	const result = clone(fallback);
	for (const [pattern, item] of Object.entries(value)) {
		if (!isObject(item)) continue;
		const profile: RouterModelProfileOverride = {};
		if (typeof item.quality === "number") profile.quality = number(item.quality, 0.5, 0, 1);
		if (typeof item.speed === "number") profile.speed = number(item.speed, 0.5, 0, 1);
		if (typeof item.reliabilityPrior === "number") profile.reliabilityPrior = number(item.reliabilityPrior, 0.97, 0, 1);
		if (Array.isArray(item.preferredIntents)) profile.preferredIntents = item.preferredIntents.filter((entry): entry is any => TASK_INTENTS.includes(entry as any));
		if (Array.isArray(item.preferredTiers)) profile.preferredTiers = item.preferredTiers.filter((entry): entry is any => COMPLEXITY_TIERS.includes(entry as any));
		if (Array.isArray(item.notes)) profile.notes = item.notes.filter((entry): entry is string => typeof entry === "string");
		if (Object.keys(profile).length > 0) result[pattern] = { ...(result[pattern] ?? {}), ...profile };
	}
	return result;
}

export function mergeRouterConfig(base: RouterConfig, patchValue: unknown): RouterConfig {
	if (!isObject(patchValue)) return clone(base);
	const patch = patchValue;
	const complexity = isObject(patch.complexity) ? patch.complexity : {};
	const thresholds = isObject(complexity.thresholds) ? complexity.thresholds : {};
	const learning = isObject(patch.learning) ? patch.learning : {};
	const rollout = isObject(patch.rollout) ? patch.rollout : {};
	const judge = isObject(patch.judge) ? patch.judge : {};
	const critical = isObject(patch.critical) ? patch.critical : {};
	const classifier = isObject(patch.classifier) ? patch.classifier : {};
	const virtualProvider = isObject(patch.virtualProvider) ? patch.virtualProvider : {};
	const storage = isObject(patch.storage) ? patch.storage : {};
	const telemetry = isObject(patch.telemetry) ? patch.telemetry : {};
	const next = clone(base);
	next.enabled = boolean(patch.enabled, base.enabled);
	next.profile = enumValue(patch.profile ?? patch.objective, ROUTING_PROFILES, base.profile);
	next.granularity = enumValue(patch.granularity, ["run", "request"] as const, base.granularity);
	next.fallbackWhenNoCandidates = enumValue(patch.fallbackWhenNoCandidates, ["current_model", "none"] as const, base.fallbackWhenNoCandidates);
	next.showExplanations = boolean(patch.showExplanations, base.showExplanations);
	next.includeModels = stringArray(patch.includeModels, base.includeModels);
	next.excludeModels = stringArray(patch.excludeModels, base.excludeModels);
	next.complexity.thresholds = {
		trivialMax: number(thresholds.trivialMax, base.complexity.thresholds.trivialMax, 0, 1),
		simpleMax: number(thresholds.simpleMax, base.complexity.thresholds.simpleMax, 0, 1),
		moderateMax: number(thresholds.moderateMax, base.complexity.thresholds.moderateMax, 0, 1),
		complexMax: number(thresholds.complexMax, base.complexity.thresholds.complexMax, 0, 1),
	};
	const ordered = Object.values(next.complexity.thresholds);
	if (!(ordered[0]! > 0 && ordered[0]! < ordered[1]! && ordered[1]! < ordered[2]! && ordered[2]! < ordered[3]! && ordered[3]! < 1)) next.complexity.thresholds = clone(base.complexity.thresholds);
	next.complexity.qualityFloor = unitRecord(complexity.qualityFloor ?? complexity.tierQualityFloor, base.complexity.qualityFloor) as RouterConfig["complexity"]["qualityFloor"];
	next.complexity.reliabilityFloor = unitRecord(complexity.reliabilityFloor, base.complexity.reliabilityFloor) as RouterConfig["complexity"]["reliabilityFloor"];
	next.profiles = sanitizeProfiles(patch.profiles, base.profiles);
	next.modelProfiles = sanitizeModelProfiles(patch.modelProfiles, base.modelProfiles);
	next.classifier = {
		enabled: boolean(classifier.enabled, base.classifier.enabled),
		model: typeof classifier.model === "string" ? classifier.model : base.classifier.model,
		maxEstimatedCostUsd: number(classifier.maxEstimatedCostUsd, base.classifier.maxEstimatedCostUsd),
		maxPromptChars: integer(classifier.maxPromptChars, base.classifier.maxPromptChars, 256),
		timeoutMs: integer(classifier.timeoutMs, base.classifier.timeoutMs, 1_000),
	};
	next.learning = {
		enabled: boolean(learning.enabled, base.learning.enabled),
		halfLifeDays: number(learning.halfLifeDays, base.learning.halfLifeDays, 1),
		rawRetentionDays: number(learning.rawRetentionDays, base.learning.rawRetentionDays, 1),
		projectOverlayMinSamples: integer(learning.projectOverlayMinSamples, base.learning.projectOverlayMinSamples),
		projectOverlayFullWeightSamples: integer(learning.projectOverlayFullWeightSamples, base.learning.projectOverlayFullWeightSamples, 1),
		qualityPriorStrength: number(learning.qualityPriorStrength, base.learning.qualityPriorStrength, 0.01),
		reliabilityPriorMean: number(learning.reliabilityPriorMean, base.learning.reliabilityPriorMean, 0, 1),
		reliabilityPriorStrength: number(learning.reliabilityPriorStrength, base.learning.reliabilityPriorStrength, 0.01),
		autoExplorationRate: number(learning.autoExplorationRate, base.learning.autoExplorationRate, 0, 1),
	};
	next.rollout = {
		automatic: boolean(rollout.automatic, base.rollout.automatic),
		initialStage: enumValue(rollout.initialStage, ["off", "shadow", "explore", "auto"] as const, base.rollout.initialStage),
		shadowMinCompleted: integer(rollout.shadowMinCompleted, base.rollout.shadowMinCompleted),
		shadowMinQualityLabels: integer(rollout.shadowMinQualityLabels, base.rollout.shadowMinQualityLabels),
		minimumObservationCompleteness: number(rollout.minimumObservationCompleteness, base.rollout.minimumObservationCompleteness, 0, 1),
		exploreTreatmentRate: number(rollout.exploreTreatmentRate, base.rollout.exploreTreatmentRate, 0, 1),
		exploreMinTreatment: integer(rollout.exploreMinTreatment, base.rollout.exploreMinTreatment),
		exploreMinControl: integer(rollout.exploreMinControl, base.rollout.exploreMinControl),
		exploreMinDays: number(rollout.exploreMinDays, base.rollout.exploreMinDays),
		exploreMinQualityLabelsPerArm: integer(rollout.exploreMinQualityLabelsPerArm, base.rollout.exploreMinQualityLabelsPerArm),
		nonInferiorityProbability: number(rollout.nonInferiorityProbability, base.rollout.nonInferiorityProbability, 0, 1),
		maxReliabilityRegression: number(rollout.maxReliabilityRegression, base.rollout.maxReliabilityRegression, 0, 1),
		maxQualityRegression: number(rollout.maxQualityRegression, base.rollout.maxQualityRegression, 0, 1),
		requiredCostOrLatencyImprovement: number(rollout.requiredCostOrLatencyImprovement, base.rollout.requiredCostOrLatencyImprovement, 0, 1),
		softCostLatencyRegression: number(rollout.softCostLatencyRegression, base.rollout.softCostLatencyRegression, 0, 10),
	};
	next.critical = {
		minimumReliabilityObservations: integer(critical.minimumReliabilityObservations, base.critical.minimumReliabilityObservations),
		minimumHumanValidatorLabels: integer(critical.minimumHumanValidatorLabels, base.critical.minimumHumanValidatorLabels),
		minimumReliabilityMean: number(critical.minimumReliabilityMean, base.critical.minimumReliabilityMean, 0, 1),
		minimumQualityMean: number(critical.minimumQualityMean, base.critical.minimumQualityMean, 0, 1),
	};
	next.judge = {
		enabled: boolean(judge.enabled, base.judge.enabled),
		model: typeof judge.model === "string" ? judge.model : base.judge.model,
		sampleRate: number(judge.sampleRate, base.judge.sampleRate, 0, 0.05),
		maxCostPerEvaluationUsd: number(judge.maxCostPerEvaluationUsd, base.judge.maxCostPerEvaluationUsd),
		maxDailyCostUsd: number(judge.maxDailyCostUsd, base.judge.maxDailyCostUsd),
		timeoutMs: integer(judge.timeoutMs, base.judge.timeoutMs, 1_000),
		excludeTiers: Array.isArray(judge.excludeTiers) ? judge.excludeTiers.filter((entry): entry is any => COMPLEXITY_TIERS.includes(entry as any)) : [...base.judge.excludeTiers],
		maxPromptChars: integer(judge.maxPromptChars, base.judge.maxPromptChars, 256),
		maxOutputChars: integer(judge.maxOutputChars, base.judge.maxOutputChars, 256),
		minimumCalibrationPairs: integer(judge.minimumCalibrationPairs, base.judge.minimumCalibrationPairs),
		maxCalibrationMae: number(judge.maxCalibrationMae, base.judge.maxCalibrationMae, 0, 1),
		maxCalibrationBias: number(judge.maxCalibrationBias, base.judge.maxCalibrationBias, 0, 1),
	};
	next.virtualProvider = {
		enabled: boolean(virtualProvider.enabled, base.virtualProvider.enabled),
		maxFallbacksBeforeOutput: integer(virtualProvider.maxFallbacksBeforeOutput, base.virtualProvider.maxFallbacksBeforeOutput, 0),
		switchMinimumUtilityGain: number(virtualProvider.switchMinimumUtilityGain, base.virtualProvider.switchMinimumUtilityGain, 0, 1),
		contextWindow: integer(virtualProvider.contextWindow, base.virtualProvider.contextWindow, 1),
		maxTokens: integer(virtualProvider.maxTokens, base.virtualProvider.maxTokens, 1),
	};
	next.storage = {
		enabled: boolean(storage.enabled, base.storage.enabled),
		path: typeof storage.path === "string" ? storage.path : base.storage.path,
		busyTimeoutMs: integer(storage.busyTimeoutMs, base.storage.busyTimeoutMs),
	};
	next.telemetry.enabled = boolean(telemetry.enabled, base.telemetry.enabled);
	return next;
}

export interface LoadedRouterConfig {
	config: RouterConfig;
	warnings: string[];
	sources: string[];
}

export function loadRouterConfig(cwd: string, options: LoadRouterConfigOptions = {}): LoadedRouterConfig {
	const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const warnings: string[] = [];
	const sources: string[] = [];
	let config = clone(DEFAULT_ROUTER_CONFIG);
	const applyLegacy = (path: string | undefined) => {
		if (!path) return;
		const raw = readJson(path);
		if (!raw) return;
		const migration = migrateLegacyRouterConfig(raw);
		config = mergeRouterConfig(config, migration.patch);
		warnings.push(...migration.warnings);
		sources.push(path);
	};
	const apply = (path: string | undefined) => {
		if (!path) return;
		const raw = readJson(path);
		if (!raw) return;
		config = mergeRouterConfig(config, raw);
		sources.push(path);
	};
	applyLegacy(join(agentDir, LEGACY_FILE));
	apply(join(agentDir, ROUTER_FILE));
	if (options.projectTrusted) {
		applyLegacy(findNearestConfigFile(cwd, LEGACY_FILE, options.configDirName));
		apply(findNearestConfigFile(cwd, ROUTER_FILE, options.configDirName));
	}
	if (options.runtime) config = mergeRouterConfig(config, options.runtime);
	return { config, warnings: [...new Set(warnings)], sources };
}
