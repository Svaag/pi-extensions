import type {
	ArmStatistics,
	QualityLabel,
	RolloutState,
	RouteDecision,
	RouteObservation,
} from "../core/types.ts";
import type { MetricHistogram, MetricHistogramKey } from "./histograms.ts";

/** A non-throwing result. Storage failures must never prevent routing fallback. */
export type StoreResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string; retryable: boolean };

export interface RouterStoreHealth {
	initialized: boolean;
	available: boolean;
	persistent: boolean;
	lastError?: string;
}

export interface CircuitBreakerState {
	key: string;
	failureCount: number;
	openedAt?: number;
	openUntil?: number;
	updatedAt: number;
	/** A machine-readable code only; free-form provider errors must not be stored. */
	reason?: string;
}

export interface RolloutArmAggregate {
	routes: number;
	completed: number;
	succeeded: number;
	qualityAlpha: number;
	qualityBeta: number;
	qualityLabels: number;
	humanValidatorLabels: number;
	observationCompleteness: number;
	costKnown: number;
	latencyKnown: number;
	totalCostUsd: number;
	costPerSuccessUsd?: number;
	latencyP95Ms?: number;
}

export interface RolloutAggregate {
	scopeKey: string;
	control: RolloutArmAggregate;
	treatment: RolloutArmAggregate;
	updatedAt?: number;
}

/** Canonical exact rollout scope used by persisted decisions and aggregates. */
export function rolloutScopeKey(scope: { host: string; granularity: string; profile: string }): string {
	return `${scope.host}:${scope.granularity}:${scope.profile}`;
}

export interface RouterStoreSummary {
	totalRoutes: number;
	totalObservations: number;
	qualityLabels: number;
	armStatistics: number;
	openCircuits: number;
	oldestRouteAt?: number;
	latestRouteAt?: number;
}

export interface PruneResult {
	before: number;
	routes: number;
	judgeReservations: number;
}

export interface JudgeBudgetRequest {
	day: string;
	amountUsd: number;
	maxDailyUsd: number;
	createdAt?: number;
}

export interface JudgeBudgetReservation {
	reservationId: string;
	day: string;
	amountUsd: number;
	createdAt: number;
}

export interface JudgeBudgetStatus {
	day: string;
	reservedUsd: number;
	spentUsd: number;
}

/**
 * Small synchronous persistence contract for ModelRoutingEngine.
 *
 * Every operation is non-throwing and returns StoreResult. Callers should route
 * normally, but disable learning/judging, when a result is not ok.
 */
export interface RouterStore {
	initialize(): StoreResult<void>;
	health(): RouterStoreHealth;

	saveDecision(decision: RouteDecision): StoreResult<void>;
	getDecision(routeId: string): StoreResult<RouteDecision | undefined>;
	getLatestDecision(): StoreResult<RouteDecision | undefined>;
	saveObservation(observation: RouteObservation): StoreResult<void>;
	recordQuality(routeId: string, quality: QualityLabel, recordedAt?: number): StoreResult<void>;

	/** Statistics are decayed to decayAt (or now) using the configured half-life. */
	getArmStatistics(armKey: string, decayAt?: number): StoreResult<ArmStatistics | undefined>;
	listArmStatistics(decayAt?: number): StoreResult<ArmStatistics[]>;
	upsertArmStatistics(statistics: ArmStatistics): StoreResult<void>;
	getMetricHistogram(key: MetricHistogramKey, decayAt?: number): StoreResult<MetricHistogram | undefined>;
	upsertMetricHistogram(histogram: MetricHistogram): StoreResult<void>;

	getRollout(scopeKey: string): StoreResult<RolloutState | undefined>;
	setRollout(state: RolloutState): StoreResult<void>;
	listRollouts(): StoreResult<RolloutState[]>;
	/** Derives rollout evidence from privacy-safe route, observation, and quality rows. */
	getRolloutAggregate(scopeKey: string): StoreResult<RolloutAggregate>;
	getCircuitBreaker(key: string): StoreResult<CircuitBreakerState | undefined>;
	setCircuitBreaker(state: CircuitBreakerState): StoreResult<void>;

	getSummary(now?: number): StoreResult<RouterStoreSummary>;
	/** Deletes raw route data older than before; defaults to configured retention (90 days). */
	prune(before?: number): StoreResult<PruneResult>;

	/** Atomically reserves budget, returning undefined when the daily limit would be exceeded. */
	reserveJudgeBudget(request: JudgeBudgetRequest): StoreResult<JudgeBudgetReservation | undefined>;
	/** Finalizes a reservation. Actual cost is clamped to the reserved amount. */
	recordJudgeBudget(reservationId: string, actualCostUsd: number, completedAt?: number): StoreResult<void>;
	getJudgeBudget(day: string): StoreResult<JudgeBudgetStatus>;

	close(): StoreResult<void>;
}

export function storeSuccess<T>(value: T): StoreResult<T> {
	return { ok: true, value };
}

export function storeFailure(error: unknown, retryable = true): StoreResult<never> {
	return {
		ok: false,
		error: error instanceof Error ? error.message : String(error),
		retryable,
	};
}
