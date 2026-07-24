import type { RouteDecision } from "../core/types.ts";
import { NOOP_ROUTER_TELEMETRY } from "./NoopRouterTelemetry.ts";
import {
	createRouterTelemetryPrivacy,
	filterRouterMetricAttributes,
	filterRouterSpanAttributes,
	normalizeRouterTelemetryLabel,
	type RouterTelemetryPrivacy,
} from "./Privacy.ts";
import type {
	RouterCircuitBreakerTelemetryInput,
	RouterDecisionTelemetryEvent,
	RouterFallbackTelemetryInput,
	RouterJudgeEvaluationTelemetryInput,
	RouterObservationTelemetryEvent,
	RouterRolloutTransitionTelemetryInput,
	RouterTelemetry,
	RouterTelemetryDimensions,
	RouterTelemetryHealth,
} from "./RouterTelemetry.ts";

const VERSION = "1.0.0";
const DEFAULT_TIMEOUT_MS = 5_000;
const FALLBACK_VALUES = new Set(["attempted", "succeeded", "failed", "exhausted", "no_candidates", "constraint", "circuit_breaker", "provider", "context_overflow", "pre_output", "current_model", "unknown"]);

function boundedFallback(value: string): string {
	const normalized = normalizeRouterTelemetryLabel(value);
	return FALLBACK_VALUES.has(normalized) ? normalized : "unknown";
}

export interface OpenTelemetryRouterConfig {
	enabled: boolean;
	requestedEnabled?: boolean;
	serviceName?: string;
	traceSampleRatio?: number;
	metricExportIntervalMs?: number;
	tracesEndpoint?: string | URL;
	metricsEndpoint?: string | URL;
	headers?: Readonly<Record<string, string>>;
	configurationIssues?: readonly string[];
}

/** Minimal structural runtime keeps all OTel packages outside the public API. */
export interface RouterOpenTelemetryRuntime {
	meter: any;
	tracer: any;
	tracerProvider?: { forceFlush?: () => Promise<unknown>; shutdown?: () => Promise<unknown> };
	meterProvider?: { forceFlush?: () => Promise<unknown>; shutdown?: (options?: any) => Promise<unknown> };
	spanStatusCode?: { OK: number; ERROR: number; UNSET: number };
}

export interface CreateOpenTelemetryRouterOptions {
	privacy?: RouterTelemetryPrivacy;
	runtime?: RouterOpenTelemetryRuntime;
	exporters?: { trace?: any; metrics?: any };
}

export interface RouterTelemetryExportHealth {
	degraded: boolean;
	droppedRecords: number;
	lastSuccessfulExportAt?: number;
	lastErrorCategory?: "configuration" | "exporter" | "internal";
}

function modelParts(model: string | undefined, provider?: string): Record<string, unknown> {
	if (!model) return provider ? { provider } : {};
	const slash = model.indexOf("/");
	return { provider: provider ?? (slash > 0 ? model.slice(0, slash) : "other"), model };
}

function decisionDimensions(decision: RouteDecision): RouterTelemetryDimensions {
	return {
		host: decision.host,
		granularity: decision.granularity,
		profile: decision.profile,
		stage: decision.stage,
		arm: decision.arm,
		...modelParts(decision.executedModel ?? decision.selectedModel),
		thinkingLevel: decision.executedThinkingLevel ?? decision.selectedThinkingLevel,
		intent: decision.intent,
		complexityTier: decision.complexityTier,
	} as RouterTelemetryDimensions;
}

function dimensionAttributes(input: Partial<RouterTelemetryDimensions>): Record<string, unknown> {
	return {
		host: input.host,
		granularity: input.granularity,
		profile: input.profile,
		stage: input.stage,
		arm: input.arm,
		...modelParts(input.model, input.provider),
		thinking_level: input.thinkingLevel,
		intent: input.intent,
		complexity_tier: input.complexityTier,
	};
}

function trackedExporter<T extends object>(delegate: T, health: RouterTelemetryExportHealth): T {
	return new Proxy(delegate, {
		get(target, property) {
			const value = (target as any)[property];
			if (property === "export" && typeof value === "function") return (items: unknown, callback: (result: any) => void) => {
				try {
					value.call(target, items, (result: any) => {
						if (result?.code === 0) { health.lastSuccessfulExportAt = Date.now(); health.degraded = false; health.lastErrorCategory = undefined; }
						else { health.degraded = true; health.lastErrorCategory = "exporter"; health.droppedRecords += Array.isArray(items) ? items.length : 1; }
						callback(result);
					});
				} catch {
					health.degraded = true; health.lastErrorCategory = "exporter"; health.droppedRecords += Array.isArray(items) ? items.length : 1;
					callback({ code: 1 });
				}
			};
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export class OpenTelemetryRouterTelemetry implements RouterTelemetry {
	readonly #config: OpenTelemetryRouterConfig;
	readonly #privacy: RouterTelemetryPrivacy;
	readonly #runtime: RouterOpenTelemetryRuntime;
	readonly #health: RouterTelemetryExportHealth;
	readonly #spans = new Map<string, any>();
	readonly #decisions: any;
	readonly #observations: any;
	readonly #quality: any;
	readonly #latency: any;
	readonly #firstToken: any;
	readonly #cost: any;
	readonly #fallbacks: any;
	readonly #circuitBreakers: any;
	readonly #rolloutTransitions: any;
	readonly #judgeEvaluations: any;

	constructor(config: OpenTelemetryRouterConfig, privacy: RouterTelemetryPrivacy, runtime: RouterOpenTelemetryRuntime, health?: RouterTelemetryExportHealth) {
		this.#config = config;
		this.#privacy = privacy;
		this.#runtime = runtime;
		this.#health = health ?? { degraded: false, droppedRecords: 0 };
		this.#decisions = runtime.meter.createCounter("pi.model_router.decisions", { unit: "{decision}" });
		this.#observations = runtime.meter.createCounter("pi.model_router.observations", { unit: "{observation}" });
		this.#quality = runtime.meter.createHistogram("pi.model_router.quality", { unit: "1" });
		this.#latency = runtime.meter.createHistogram("pi.model_router.latency", { unit: "ms" });
		this.#firstToken = runtime.meter.createHistogram("pi.model_router.first_token", { unit: "ms" });
		this.#cost = runtime.meter.createHistogram("pi.model_router.cost", { unit: "USD" });
		this.#fallbacks = runtime.meter.createCounter("pi.model_router.fallbacks", { unit: "{fallback}" });
		this.#circuitBreakers = runtime.meter.createCounter("pi.model_router.circuit_breakers", { unit: "{transition}" });
		this.#rolloutTransitions = runtime.meter.createCounter("pi.model_router.rollout.transitions", { unit: "{transition}" });
		this.#judgeEvaluations = runtime.meter.createCounter("pi.model_router.judge.evaluations", { unit: "{evaluation}" });
		const dropped = runtime.meter.createObservableCounter?.("pi.model_router.telemetry.dropped", { unit: "{record}" });
		dropped?.addCallback?.((observation: any) => observation.observe(this.#health.droppedRecords, filterRouterMetricAttributes({ outcome: "failed" })));
	}

	recordDecision(input: RouterDecisionTelemetryEvent): void {
		this.safe(() => {
			const envelope = "decision" in input ? input : undefined;
			const decision = envelope?.decision ?? (input as RouteDecision);
			const dimensions = decisionDimensions(decision);
			const metric = filterRouterMetricAttributes(dimensionAttributes(dimensions));
			this.#decisions.add(1, metric);
			const attributes = filterRouterSpanAttributes({
				...dimensionAttributes(dimensions),
				"route.id": this.#privacy.hashIdentifier("route", decision.routeId),
				"project.id": envelope?.projectId ? this.#privacy.hashIdentifier("project", envelope.projectId) : decision.projectHash,
				"session.id": envelope?.sessionId ? this.#privacy.hashIdentifier("session", envelope.sessionId) : undefined,
				"task.id": envelope?.taskId ? this.#privacy.hashIdentifier("task", envelope.taskId) : undefined,
				"telemetry.hash_scope": this.#privacy.hashScope,
				"route.applied": decision.applied,
				"route.forced": decision.forced,
				"route.candidate_count": decision.candidates.length,
				"route.constraint_count": decision.constraints.length,
				"route.estimated_input_tokens": decision.estimatedInputTokens,
				"route.estimated_output_tokens": decision.estimatedOutputTokens,
				"route.estimated_cost_usd": decision.estimatedCostUsd,
				"route.estimated_p95_latency_ms": decision.estimatedP95LatencyMs,
			});
			const span = this.#runtime.tracer.startSpan("pi.model_router.route", { attributes, startTime: decision.createdAt });
			this.#spans.get(decision.routeId)?.end?.(decision.createdAt);
			this.#spans.set(decision.routeId, span);
		});
	}

	recordObservation(input: RouterObservationTelemetryEvent): void {
		this.safe(() => {
			const routed = "decision" in input ? input : undefined;
			const routeId = routed?.decision.routeId ?? ("routeId" in input ? input.routeId : input.observation.routeId);
			const dimensions: Partial<RouterTelemetryDimensions> = routed ? decisionDimensions(routed.decision) : input as RouterTelemetryDimensions;
			const observation = input.observation;
			const base = dimensionAttributes(dimensions);
			const metric = filterRouterMetricAttributes({ ...base, outcome: observation.outcome, failure_domain: observation.failureDomain ?? "unknown" });
			this.#observations.add(1, metric);
			if (observation.latencyMs !== undefined) this.#latency.record(Math.max(0, observation.latencyMs), metric);
			if (observation.firstTokenMs !== undefined) this.#firstToken.record(Math.max(0, observation.firstTokenMs), metric);
			if (observation.costUsd !== undefined) this.#cost.record(Math.max(0, observation.costUsd), metric);
			if (observation.quality) this.#quality.record(Math.max(0, Math.min(1, observation.quality.score)), filterRouterMetricAttributes({ ...metric, quality_source: observation.quality.source }));
			const attributes = filterRouterSpanAttributes({
				...base, outcome: observation.outcome, failure_domain: observation.failureDomain ?? "unknown",
				"route.id": this.#privacy.hashIdentifier("route", routeId),
				"project.id": input.projectId ? this.#privacy.hashIdentifier("project", input.projectId) : routed?.decision.projectHash,
				"session.id": input.sessionId ? this.#privacy.hashIdentifier("session", input.sessionId) : undefined,
				"task.id": input.taskId ? this.#privacy.hashIdentifier("task", input.taskId) : undefined,
				"telemetry.hash_scope": this.#privacy.hashScope,
				latency_ms: observation.latencyMs, first_token_ms: observation.firstTokenMs, "cost.usd": observation.costUsd,
				"quality.score": observation.quality?.score, quality_source: observation.quality?.source,
				"provider.requests": observation.providerRequests, "tool.calls": observation.toolCalls, context_overflow: observation.contextOverflow,
			});
			const span = this.#spans.get(routeId) ?? this.#runtime.tracer.startSpan("pi.model_router.observation", { attributes });
			span.setAttributes?.(attributes);
			const code = observation.outcome === "succeeded" ? this.#runtime.spanStatusCode?.OK : observation.outcome === "cancelled" || observation.outcome === "aborted" ? this.#runtime.spanStatusCode?.UNSET : this.#runtime.spanStatusCode?.ERROR;
			if (code !== undefined) span.setStatus?.({ code });
			span.end?.(observation.completedAt ?? Date.now());
			this.#spans.delete(routeId);
		});
	}

	recordFallback(input: RouterFallbackTelemetryInput): void {
		this.safe(() => {
			const attributes = filterRouterMetricAttributes({ ...dimensionAttributes(input), fallback: boundedFallback(input.fallback), outcome: input.outcome });
			this.#fallbacks.add(1, attributes);
			this.eventSpan("pi.model_router.fallback", { ...attributes, "route.id": input.routeId ? this.#privacy.hashIdentifier("route", input.routeId) : undefined }, input.at);
		});
	}

	recordCircuitBreaker(input: RouterCircuitBreakerTelemetryInput): void {
		this.safe(() => {
			const attributes = filterRouterMetricAttributes({ ...dimensionAttributes(input), outcome: input.outcome, failure_domain: input.failureDomain, transition: input.outcome });
			this.#circuitBreakers.add(1, attributes);
			this.eventSpan("pi.model_router.circuit_breaker", attributes, input.at);
		});
	}

	recordRolloutTransition(input: RouterRolloutTransitionTelemetryInput): void {
		this.safe(() => {
			const transition = `${input.from}_to_${input.to}`;
			const metric = filterRouterMetricAttributes({ ...dimensionAttributes(input), stage: input.to, transition, outcome: "succeeded" });
			this.#rolloutTransitions.add(1, metric);
			this.eventSpan("pi.model_router.rollout.transition", { ...metric, "rollout.completed_count": input.completedCount, "rollout.quality_label_count": input.qualityLabelCount, "rollout.outcome_coverage_count": input.outcomeCoverageCount, "rollout.cost_coverage_count": input.costCoverageCount, "rollout.latency_coverage_count": input.latencyCoverageCount }, input.at);
		});
	}

	recordJudgeEvaluation(input: RouterJudgeEvaluationTelemetryInput): void {
		this.safe(() => {
			const metric = filterRouterMetricAttributes({ ...dimensionAttributes(input), outcome: input.outcome, quality_source: input.qualitySource ?? "judge" });
			this.#judgeEvaluations.add(1, metric);
			this.eventSpan("pi.model_router.judge.evaluation", { ...metric, "route.id": input.routeId ? this.#privacy.hashIdentifier("route", input.routeId) : undefined, "quality.score": input.score, "cost.usd": input.costUsd }, input.at);
		});
	}

	decision(input: RouterDecisionTelemetryEvent): void { this.recordDecision(input); }
	observation(input: RouterObservationTelemetryEvent): void { this.recordObservation(input); }
	fallback(input: RouterFallbackTelemetryInput): void { this.recordFallback(input); }
	circuitBreaker(input: RouterCircuitBreakerTelemetryInput): void { this.recordCircuitBreaker(input); }
	rolloutTransition(input: RouterRolloutTransitionTelemetryInput): void { this.recordRolloutTransition(input); }
	judgeEvaluation(input: RouterJudgeEvaluationTelemetryInput): void { this.recordJudgeEvaluation(input); }

	getHealth(): RouterTelemetryHealth {
		return { enabled: true, requestedEnabled: this.#config.requestedEnabled ?? this.#config.enabled, degraded: this.#health.degraded, droppedRecords: this.#health.droppedRecords, lastSuccessfulExportAt: this.#health.lastSuccessfulExportAt, lastErrorCategory: this.#health.lastErrorCategory, configurationIssues: this.#config.configurationIssues ?? [] };
	}

	async forceFlush(): Promise<void> {
		try {
			await Promise.all([this.#runtime.tracerProvider?.forceFlush?.(), this.#runtime.meterProvider?.forceFlush?.()]);
		} catch { this.exportFailure(); }
	}

	async shutdown(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
		for (const span of this.#spans.values()) { try { span.end?.(); } catch { /* non-fatal */ } }
		this.#spans.clear();
		let settled = false;
		const work = Promise.allSettled([this.#runtime.tracerProvider?.shutdown?.(), this.#runtime.meterProvider?.shutdown?.({ timeoutMillis: timeoutMs })]).then((results) => { settled = true; if (results.some((item) => item.status === "rejected")) this.exportFailure(); });
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(1, timeoutMs)); timer.unref?.(); })]);
			if (!settled) this.exportFailure();
		} catch { this.exportFailure(); }
		finally { if (timer) clearTimeout(timer); }
	}

	private eventSpan(name: string, rawAttributes: Readonly<Record<string, unknown>>, at = Date.now()): void {
		const span = this.#runtime.tracer.startSpan(name, { attributes: filterRouterSpanAttributes(rawAttributes), startTime: at });
		span.end?.(at);
	}

	private exportFailure(): void { this.#health.degraded = true; this.#health.lastErrorCategory = "exporter"; this.#health.droppedRecords += 1; }
	private safe(operation: () => void): void { try { operation(); } catch { this.#health.degraded = true; this.#health.lastErrorCategory = "internal"; this.#health.droppedRecords += 1; } }
}

const dynamicImport = (specifier: string): Promise<any> => Function("specifier", "return import(specifier)")(specifier);

async function createRuntime(config: OpenTelemetryRouterConfig, exporters: CreateOpenTelemetryRouterOptions["exporters"], health: RouterTelemetryExportHealth): Promise<RouterOpenTelemetryRuntime> {
	const [api, traceExporterModule, metricExporterModule, resources, metricsSdk, traceSdk, conventions] = await Promise.all([
		dynamicImport("@opentelemetry/api"), dynamicImport("@opentelemetry/exporter-trace-otlp-http"), dynamicImport("@opentelemetry/exporter-metrics-otlp-http"), dynamicImport("@opentelemetry/resources"), dynamicImport("@opentelemetry/sdk-metrics"), dynamicImport("@opentelemetry/sdk-trace-node"), dynamicImport("@opentelemetry/semantic-conventions"),
	]);
	const serviceName = normalizeRouterTelemetryLabel(config.serviceName ?? "pi-model-router", 128);
	const resource = resources.resourceFromAttributes({ [conventions.ATTR_SERVICE_NAME ?? "service.name"]: serviceName, [conventions.ATTR_SERVICE_VERSION ?? "service.version"]: VERSION });
	const traceExporter = trackedExporter(exporters?.trace ?? new traceExporterModule.OTLPTraceExporter({ url: String(config.tracesEndpoint ?? "http://127.0.0.1:4318/v1/traces"), headers: { ...config.headers }, timeoutMillis: 10_000 }), health);
	const metricExporter = trackedExporter(exporters?.metrics ?? new metricExporterModule.OTLPMetricExporter({ url: String(config.metricsEndpoint ?? "http://127.0.0.1:4318/v1/metrics"), headers: { ...config.headers }, timeoutMillis: 10_000 }), health);
	const metricIntervalMs = Math.max(1_000, config.metricExportIntervalMs ?? 10_000);
	const meterProvider = new metricsSdk.MeterProvider({ resource, readers: [new metricsSdk.PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: metricIntervalMs, exportTimeoutMillis: Math.min(10_000, metricIntervalMs) })] });
	const ratio = Number.isFinite(config.traceSampleRatio) ? Math.max(0, Math.min(1, config.traceSampleRatio!)) : 1;
	const tracerProvider = new traceSdk.NodeTracerProvider({ resource, sampler: new traceSdk.ParentBasedSampler({ root: new traceSdk.TraceIdRatioBasedSampler(ratio) }), spanProcessors: [new traceSdk.BatchSpanProcessor(traceExporter, { maxQueueSize: 2_048, maxExportBatchSize: 512, scheduledDelayMillis: 2_000, exportTimeoutMillis: 10_000 })], spanLimits: { attributeCountLimit: 48, attributeValueLengthLimit: 160 } });
	return { meter: meterProvider.getMeter(serviceName, VERSION), tracer: tracerProvider.getTracer(serviceName, VERSION), meterProvider, tracerProvider, spanStatusCode: api.SpanStatusCode };
}

/** Dynamically loads optional OTel packages. Any setup failure returns the no-op. */
export async function createOpenTelemetryRouterTelemetry(config: OpenTelemetryRouterConfig, options: CreateOpenTelemetryRouterOptions = {}): Promise<RouterTelemetry> {
	if (!config.enabled || (config.configurationIssues?.length ?? 0) > 0) return NOOP_ROUTER_TELEMETRY;
	try {
		const privacy = options.privacy ?? await createRouterTelemetryPrivacy();
		const bootstrapHealth: RouterTelemetryExportHealth = { degraded: false, droppedRecords: 0 };
		const runtime = options.runtime ?? await createRuntime(config, options.exporters, bootstrapHealth);
		return new OpenTelemetryRouterTelemetry(config, privacy, runtime, bootstrapHealth);
	} catch {
		return NOOP_ROUTER_TELEMETRY;
	}
}
