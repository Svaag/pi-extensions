import type {
	ComplexityTier,
	RouteGranularity,
	RoutingProfile,
	RoutingStage,
	TaskIntent,
} from "../core/types.ts";

export interface RouterComplexityThresholds {
	trivialMax: number;
	simpleMax: number;
	moderateMax: number;
	complexMax: number;
}

export type RouterTierFloor = Record<ComplexityTier, number>;

export interface RouterModelProfileOverride {
	quality?: number;
	speed?: number;
	reliabilityPrior?: number;
	preferredIntents?: TaskIntent[];
	preferredTiers?: ComplexityTier[];
	notes?: string[];
}

export interface RouterProfileConfig {
	maxCostRatio?: number;
	maxP95LatencyRatio?: number;
	maxCostUsd?: number;
	maxP95LatencyMs?: number;
	weights: {
		quality: number;
		reliability: number;
		cost: number;
		latency: number;
	};
}

export interface RouterConfig {
	version: 1;
	enabled: boolean;
	profile: RoutingProfile;
	granularity: RouteGranularity;
	candidateSource: "pi_enabled_authenticated";
	fallbackWhenNoCandidates: "current_model" | "none";
	showExplanations: boolean;
	includeModels: string[];
	excludeModels: string[];
	complexity: {
		thresholds: RouterComplexityThresholds;
		qualityFloor: RouterTierFloor;
		reliabilityFloor: RouterTierFloor;
	};
	profiles: Record<RoutingProfile, RouterProfileConfig>;
	modelProfiles: Record<string, RouterModelProfileOverride>;
	classifier: {
		enabled: boolean;
		model?: string;
		maxEstimatedCostUsd: number;
		maxPromptChars: number;
		timeoutMs: number;
	};
	learning: {
		enabled: boolean;
		halfLifeDays: number;
		rawRetentionDays: number;
		projectOverlayMinSamples: number;
		projectOverlayFullWeightSamples: number;
		qualityPriorStrength: number;
		reliabilityPriorMean: number;
		reliabilityPriorStrength: number;
		autoExplorationRate: number;
	};
	rollout: {
		automatic: boolean;
		initialStage: RoutingStage;
		shadowMinCompleted: number;
		shadowMinQualityLabels: number;
		minimumObservationCompleteness: number;
		exploreTreatmentRate: number;
		exploreMinTreatment: number;
		exploreMinControl: number;
		exploreMinDays: number;
		exploreMinQualityLabelsPerArm: number;
		nonInferiorityProbability: number;
		maxReliabilityRegression: number;
		maxQualityRegression: number;
		requiredCostOrLatencyImprovement: number;
		softCostLatencyRegression: number;
	};
	critical: {
		minimumReliabilityObservations: number;
		minimumHumanValidatorLabels: number;
		minimumReliabilityMean: number;
		minimumQualityMean: number;
	};
	judge: {
		enabled: boolean;
		model?: string;
		sampleRate: number;
		maxCostPerEvaluationUsd: number;
		maxDailyCostUsd: number;
		timeoutMs: number;
		excludeTiers: ComplexityTier[];
		maxPromptChars: number;
		maxOutputChars: number;
		minimumCalibrationPairs: number;
		maxCalibrationMae: number;
		maxCalibrationBias: number;
	};
	virtualProvider: {
		enabled: boolean;
		maxFallbacksBeforeOutput: number;
		switchMinimumUtilityGain: number;
		contextWindow: number;
		maxTokens: number;
	};
	storage: {
		enabled: boolean;
		path?: string;
		busyTimeoutMs: number;
	};
	telemetry: {
		enabled: boolean;
	};
}

export interface LoadRouterConfigOptions {
	projectTrusted?: boolean;
	agentDir?: string;
	configDirName?: string;
	runtime?: Partial<RouterConfig>;
}
