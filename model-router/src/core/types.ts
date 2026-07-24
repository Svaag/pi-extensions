export const TASK_INTENTS = [
	"lookup",
	"scout",
	"summarize",
	"batch_simple",
	"plan",
	"review",
	"debug",
	"implement",
	"complex",
] as const;
export type TaskIntent = (typeof TASK_INTENTS)[number];

export const COMPLEXITY_TIERS = ["trivial", "simple", "moderate", "complex", "critical"] as const;
export type ComplexityTier = (typeof COMPLEXITY_TIERS)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const ROUTING_PROFILES = ["balanced", "quality_first", "cost_first", "latency_first"] as const;
export type RoutingProfile = (typeof ROUTING_PROFILES)[number];

export type RoutingStage = "off" | "shadow" | "explore" | "auto";
export type RouteHost = "pi_run" | "pi_provider_request" | "subagent" | "subagent_batch" | "sdk";
export type RouteGranularity = "run" | "request";
export type RouteArm = "control" | "treatment" | "forced";
export type RouteForceMode = "off" | "explain" | "auto";
export type QualitySource = "user" | "validator" | "judge" | "correction";
export type FailureDomain = "model" | "provider" | "host" | "rpc" | "tool" | "policy" | "user" | "router" | "unknown";
export type RouteOutcome = "succeeded" | "failed" | "timeout" | "cancelled" | "aborted";
export type ContextMode = "fresh" | "summary" | "last_n_turns" | "full_sanitized" | string;
export type WriteMode = "read_only" | "disjoint_scope" | "git_worktree" | string;

export interface ModelCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface RoutingCandidate {
	id: string;
	provider?: string;
	name?: string;
	api?: string;
	baseUrlFingerprint?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: ModelCost;
	thinkingLevels?: ThinkingLevel[];
	scopedThinkingLevel?: ThinkingLevel;
	authenticated?: boolean;
	available?: boolean;
	capabilities?: Record<string, boolean | string | number>;
	metadata?: Record<string, unknown>;
}

export interface ModelProfile {
	ref: string;
	fingerprint: string;
	provider?: string;
	id: string;
	name?: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	cost?: Required<ModelCost>;
	quality: number;
	speed: number;
	reliabilityPrior: number;
	preferredIntents: TaskIntent[];
	preferredTiers: ComplexityTier[];
	notes: string[];
	profilePattern?: string;
}

export interface DeterministicTaskInput {
	taskName?: string;
	prompt?: string;
	agentName?: string;
	agentDefinition?: string;
	contextSummary?: string;
	contextMode?: ContextMode;
	writeMode?: WriteMode;
	tools?: string[];
	modality?: "text" | "image";
	batch?: {
		source?: "csv" | "jsonl" | string;
		itemCount?: number;
		samplePrompts?: string[];
	};
}

export interface IntentClassification {
	intent: TaskIntent;
	risk: number;
	complexity: number;
	confidence: number;
	reason: string;
	signals: string[];
	sensitive: boolean;
}

export interface ComplexityAssessment {
	complexityScore: number;
	complexityTier: ComplexityTier;
	contextBoost: number;
}

export interface RoutingTokenEstimate {
	inputTokens: number;
	outputTokens: number;
}

export interface RouteRequest extends DeterministicTaskInput {
	requestId?: string;
	host: RouteHost;
	granularity?: RouteGranularity;
	projectKey?: string;
	estimatedContextTokens?: number;
	estimatedOutputTokens?: number;
	candidates: RoutingCandidate[];
	currentModel?: string;
	currentThinkingLevel?: ThinkingLevel;
	explicitModel?: string;
	explicitThinkingLevel?: ThinkingLevel;
	profile?: RoutingProfile;
	forceMode?: RouteForceMode;
	cacheAffinityModel?: string;
	metadata?: Record<string, string | number | boolean | undefined>;
}

export interface ConstraintEvaluation {
	model: string;
	thinkingLevel: ThinkingLevel;
	eligible: boolean;
	reasons: string[];
	qualityFloor: number;
	reliabilityFloor: number;
	estimatedCostUsd?: number;
	estimatedP95LatencyMs?: number;
}

export interface RouteCandidateDecision {
	model: string;
	thinkingLevel: ThinkingLevel;
	fingerprint: string;
	eligible: boolean;
	score: number;
	quality: number;
	reliability: number;
	speed: number;
	estimatedCostUsd?: number;
	estimatedP95LatencyMs?: number;
	observations: number;
	notes: string[];
}

export interface RouteDecision {
	schemaVersion: 1;
	routeId: string;
	policyVersion: string;
	createdAt: number;
	stage: RoutingStage;
	host: RouteHost;
	granularity: RouteGranularity;
	profile: RoutingProfile;
	applied: boolean;
	arm: RouteArm;
	reason: string;
	intent: TaskIntent;
	complexityTier: ComplexityTier;
	complexityScore: number;
	riskScore: number;
	confidence: number;
	selectedModel?: string;
	selectedThinkingLevel?: ThinkingLevel;
	executedModel?: string;
	executedThinkingLevel?: ThinkingLevel;
	baselineModel?: string;
	baselineThinkingLevel?: ThinkingLevel;
	estimatedInputTokens: number;
	estimatedOutputTokens: number;
	estimatedCostUsd?: number;
	estimatedP95LatencyMs?: number;
	candidates: RouteCandidateDecision[];
	constraints: ConstraintEvaluation[];
	explanation: string;
	projectHash?: string;
	cohortKey: string;
	forced: boolean;
}

export interface QualityLabel {
	score: number;
	source: QualitySource;
	weight?: number;
}

export interface RouteObservation {
	routeId: string;
	completedAt?: number;
	outcome: RouteOutcome;
	failureDomain?: FailureDomain;
	latencyMs?: number;
	firstTokenMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
	providerRequests?: number;
	toolCalls?: number;
	quality?: QualityLabel;
	contextOverflow?: boolean;
}

export interface ArmStatistics {
	armKey: string;
	modelFingerprint: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	cohortKey: string;
	projectHash?: string;
	updatedAt: number;
	reliabilityAlpha: number;
	reliabilityBeta: number;
	qualityAlpha: number;
	qualityBeta: number;
	attributableCount: number;
	qualityLabelCount: number;
	humanValidatorLabelCount: number;
	completedCount: number;
	costCount: number;
	costMean: number;
	latencyCount: number;
	latencyMean: number;
	firstTokenCount: number;
	firstTokenMean: number;
	consecutiveFailures: number;
}

export interface ArmPrediction {
	qualityMean: number;
	reliabilityMean: number;
	qualitySamples: number;
	reliabilitySamples: number;
	humanValidatorLabels: number;
	costSamples: number;
	latencySamples: number;
	estimatedCostUsd?: number;
	estimatedP95LatencyMs?: number;
	estimatedP95FirstTokenMs?: number;
}

export interface RolloutScope {
	host?: RouteHost;
	granularity?: RouteGranularity;
	profile?: RoutingProfile;
}

export interface RolloutState {
	scopeKey: string;
	stage: RoutingStage;
	enteredAt: number;
	updatedAt: number;
	softRegressionWindows: number;
	reason?: string;
}

export interface RouterHealth {
	storeAvailable: boolean;
	learningEnabled: boolean;
	telemetryAvailable: boolean;
	warnings: string[];
}

export interface RouterStatus {
	policyVersion: string;
	profile: RoutingProfile;
	stages: RolloutState[];
	health: RouterHealth;
	totalRoutes: number;
	totalObservations: number;
	qualityLabels: number;
	lastDecision?: RouteDecision;
}

export interface RouterClock {
	now(): number;
}

export interface RandomSource {
	next(): number;
}
