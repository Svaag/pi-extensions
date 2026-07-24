import type {
	RouterCircuitBreakerTelemetryInput,
	RouterDecisionTelemetryEvent,
	RouterFallbackTelemetryInput,
	RouterJudgeEvaluationTelemetryInput,
	RouterObservationTelemetryEvent,
	RouterRolloutTransitionTelemetryInput,
	RouterTelemetry,
	RouterTelemetryHealth,
} from "./RouterTelemetry.ts";

const DISABLED_HEALTH: RouterTelemetryHealth = Object.freeze({
	enabled: false,
	requestedEnabled: false,
	degraded: false,
	droppedRecords: 0,
	configurationIssues: Object.freeze([]),
});

/** Allocation-free default implementation. */
export class NoopRouterTelemetry implements RouterTelemetry {
	recordDecision(_input: RouterDecisionTelemetryEvent): void {}
	recordObservation(_input: RouterObservationTelemetryEvent): void {}
	recordFallback(_input: RouterFallbackTelemetryInput): void {}
	recordCircuitBreaker(_input: RouterCircuitBreakerTelemetryInput): void {}
	recordRolloutTransition(_input: RouterRolloutTransitionTelemetryInput): void {}
	recordJudgeEvaluation(_input: RouterJudgeEvaluationTelemetryInput): void {}
	decision(_input: RouterDecisionTelemetryEvent): void {}
	observation(_input: RouterObservationTelemetryEvent): void {}
	fallback(_input: RouterFallbackTelemetryInput): void {}
	circuitBreaker(_input: RouterCircuitBreakerTelemetryInput): void {}
	rolloutTransition(_input: RouterRolloutTransitionTelemetryInput): void {}
	judgeEvaluation(_input: RouterJudgeEvaluationTelemetryInput): void {}
	getHealth(): RouterTelemetryHealth { return DISABLED_HEALTH; }
	forceFlush(): Promise<void> { return Promise.resolve(); }
	shutdown(_timeoutMs?: number): Promise<void> { return Promise.resolve(); }
}

export const NOOP_ROUTER_TELEMETRY: RouterTelemetry = Object.freeze(new NoopRouterTelemetry());
