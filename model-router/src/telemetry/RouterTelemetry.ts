import type {
	FailureDomain,
	QualitySource,
	RouteArm,
	RouteDecision,
	RouteGranularity,
	RouteHost,
	RouteObservation,
	RouteOutcome,
	RoutingProfile,
	RoutingStage,
	TaskIntent,
	ThinkingLevel,
	ComplexityTier,
} from "../core/types.ts";

export interface RouterTelemetryHealth {
	enabled: boolean;
	requestedEnabled: boolean;
	degraded: boolean;
	droppedRecords: number;
	lastSuccessfulExportAt?: number;
	lastErrorCategory?: "configuration" | "exporter" | "internal";
	configurationIssues: readonly string[];
}

export interface RouterTelemetryDimensions {
	host: RouteHost;
	granularity: RouteGranularity;
	profile: RoutingProfile;
	stage: RoutingStage;
	arm: RouteArm;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	intent: TaskIntent;
	complexityTier: ComplexityTier;
}

export interface RouterDecisionTelemetryInput {
	decision: RouteDecision;
	/** Raw identifiers are HMACed before they are attached to a span. */
	sessionId?: string;
	taskId?: string;
	projectId?: string;
}

export interface RouterObservationTelemetryInput extends RouterTelemetryDimensions {
	routeId: string;
	observation: RouteObservation;
	sessionId?: string;
	taskId?: string;
	projectId?: string;
}

export interface RoutedObservationTelemetryInput {
	decision: RouteDecision;
	observation: RouteObservation;
	sessionId?: string;
	taskId?: string;
	projectId?: string;
}

export type RouterDecisionTelemetryEvent = RouterDecisionTelemetryInput | RouteDecision;
export type RouterObservationTelemetryEvent = RouterObservationTelemetryInput | RoutedObservationTelemetryInput;

export interface RouterFallbackTelemetryInput extends RouterTelemetryDimensions {
	routeId?: string;
	fallback: string;
	outcome: RouteOutcome;
	at?: number;
}

export interface RouterCircuitBreakerTelemetryInput extends Partial<RouterTelemetryDimensions> {
	provider?: string;
	model?: string;
	outcome: "opened" | "closed" | "half_open" | "rejected";
	failureDomain?: FailureDomain;
	at?: number;
}

export interface RouterRolloutTransitionTelemetryInput extends Partial<RouterTelemetryDimensions> {
	from: RoutingStage;
	to: RoutingStage;
	/** Optional legacy hint; exported transition is always the bounded from/to pair. */
	transition?: string;
	completedCount: number;
	qualityLabelCount: number;
	outcomeCoverageCount: number;
	costCoverageCount: number;
	latencyCoverageCount: number;
	at?: number;
}

export interface RouterJudgeEvaluationTelemetryInput extends Partial<RouterTelemetryDimensions> {
	routeId?: string;
	outcome: "labelled" | "diagnostic" | "skipped" | "failed";
	qualitySource?: QualitySource;
	score?: number;
	costUsd?: number;
	at?: number;
}

/**
 * Non-blocking metadata-only telemetry boundary. Implementations must not export
 * prompts, output, paths, arbitrary metadata, raw errors, or un-hashed IDs.
 */
export interface RouterTelemetry {
	recordDecision(input: RouterDecisionTelemetryEvent): void;
	recordObservation(input: RouterObservationTelemetryEvent): void;
	recordFallback(input: RouterFallbackTelemetryInput): void;
	recordCircuitBreaker(input: RouterCircuitBreakerTelemetryInput): void;
	recordRolloutTransition(input: RouterRolloutTransitionTelemetryInput): void;
	recordJudgeEvaluation(input: RouterJudgeEvaluationTelemetryInput): void;
	/** Concise aliases for host adapters. */
	decision(input: RouterDecisionTelemetryEvent): void;
	observation(input: RouterObservationTelemetryEvent): void;
	fallback(input: RouterFallbackTelemetryInput): void;
	circuitBreaker(input: RouterCircuitBreakerTelemetryInput): void;
	rolloutTransition(input: RouterRolloutTransitionTelemetryInput): void;
	judgeEvaluation(input: RouterJudgeEvaluationTelemetryInput): void;
	getHealth(): RouterTelemetryHealth;
	forceFlush(): Promise<void>;
	shutdown(timeoutMs?: number): Promise<void>;
}
