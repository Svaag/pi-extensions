import { ROOT_CONTEXT, SpanStatusCode, trace, type Context, type Span, type Tracer } from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, NodeTracerProvider, ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { SubagentTelemetryConfig } from "./Config.ts";
import { safeEndpointOrigin } from "./Config.ts";
import {
	createTelemetryPrivacy,
	filterMetricAttributes,
	filterSpanLogAttributes,
	normalizeTelemetryLabel,
	type TelemetryAttributes,
	type TelemetryPrivacy,
} from "./Privacy.ts";
import type {
	AgentCompletionTelemetryInput,
	AgentStateTelemetryInput,
	AgentTelemetryDescriptor,
	BatchCompletionTelemetryInput,
	BatchItemTelemetryInput,
	BatchTelemetryDescriptor,
	MessageTelemetryInput,
	RecoveryTelemetryInput,
	RoutingTelemetryInput,
	RpcCompletionTelemetryInput,
	RpcTelemetryInput,
	SessionEndTelemetryInput,
	SessionTelemetryInput,
	SubagentTelemetry,
	TelemetryHealth,
	TelemetryOutcome,
	ToolCompletionTelemetryInput,
	ToolTelemetryInput,
	TurnCompletionTelemetryInput,
	TurnTelemetryInput,
} from "./Telemetry.ts";
import { NOOP_SUBAGENT_TELEMETRY } from "./NoopTelemetry.ts";

const TELEMETRY_VERSION = "1.0.0";
const MAX_QUEUE_SIZE = 2_048;
const MAX_EXPORT_BATCH_SIZE = 512;
const BATCH_DELAY_MS = 2_000;
const EXPORT_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

interface Exporters {
	trace: any;
	metrics: any;
	logs: any;
}

export interface CreateOpenTelemetryOptions {
	privacy?: TelemetryPrivacy;
	exporters?: Partial<Exporters>;
}

interface AgentRuntime {
	span: Span;
	descriptor: AgentTelemetryDescriptor;
	spanAttributes: TelemetryAttributes;
	metricAttributes: TelemetryAttributes;
	startedAt?: number;
	spawnedAt?: number;
}

interface TimedSpan {
	span: Span;
	startedAt: number;
	context: Context;
	agentId?: string;
}

interface MutableHealth {
	lastSuccessfulExportAt?: number;
	lastErrorCategory?: string;
	droppedRecords: number;
	exportErrors: number;
	degraded: boolean;
	failedSignals: Set<string>;
}

function parentContext(span: Span | undefined): Context {
	return span ? trace.setSpan(ROOT_CONTEXT, span) : ROOT_CONTEXT;
}

function modelAttributes(model: string | undefined): Record<string, unknown> {
	if (!model) return {};
	const slash = model.indexOf("/");
	return {
		provider: slash > 0 ? model.slice(0, slash) : "other",
		model,
	};
}

function outcomeStatus(outcome: TelemetryOutcome): { code: SpanStatusCode; message?: string } {
	return outcome === "succeeded" || outcome === "closed"
		? { code: SpanStatusCode.OK }
		: outcome === "unknown"
			? { code: SpanStatusCode.UNSET }
			: { code: SpanStatusCode.ERROR, message: outcome };
}

function severityForOutcome(outcome: TelemetryOutcome): SeverityNumber {
	if (outcome === "failed" || outcome === "lost" || outcome === "timeout") return SeverityNumber.ERROR;
	if (outcome === "interrupted" || outcome === "cancelled") return SeverityNumber.WARN;
	return SeverityNumber.INFO;
}

function logThreshold(level: SubagentTelemetryConfig["logLevel"]): SeverityNumber {
	if (level === "debug") return SeverityNumber.DEBUG;
	if (level === "warn") return SeverityNumber.WARN;
	if (level === "error") return SeverityNumber.ERROR;
	return SeverityNumber.INFO;
}

function errorAttributes(privacy: TelemetryPrivacy, error: unknown): Record<string, unknown> {
	if (error === undefined) return {};
	const safe = privacy.sanitizeError(error);
	return { error_category: safe.category, "error.type": safe.type, "error.message_hash": safe.messageHash };
}

function trackedExporter<T extends object>(delegate: T, health: MutableHealth, signal: string): T {
	const recordCount = (items: unknown): number => Array.isArray(items) ? items.length : 1;
	return new Proxy(delegate, {
		get(target, property) {
			const value = (target as any)[property];
			if (property === "export" && typeof value === "function") {
				return (items: unknown, callback: (result: any) => void) => {
					try {
						value.call(target, items, (result: any) => {
							if (result?.code === 0) {
								health.lastSuccessfulExportAt = Date.now();
								health.failedSignals.delete(signal);
								health.degraded = health.failedSignals.size > 0;
								if (!health.degraded) health.lastErrorCategory = undefined;
							} else {
								health.failedSignals.add(signal);
								health.lastErrorCategory = "exporter";
								health.degraded = true;
								health.exportErrors += 1;
								health.droppedRecords += recordCount(items);
							}
							callback(result);
						});
					} catch (error) {
						health.failedSignals.add(signal);
						health.lastErrorCategory = "exporter";
						health.degraded = true;
						health.exportErrors += 1;
						health.droppedRecords += recordCount(items);
						callback({ code: 1, error: error instanceof Error ? error : new Error(String(error)) });
					}
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export class OpenTelemetrySubagentTelemetry implements SubagentTelemetry {
	private readonly config: SubagentTelemetryConfig;
	private readonly privacy: TelemetryPrivacy;
	private readonly tracerProvider: NodeTracerProvider;
	private readonly meterProvider: MeterProvider;
	private readonly loggerProvider: LoggerProvider;
	private readonly tracer: Tracer;
	private readonly logger: Logger;
	private readonly meter: ReturnType<MeterProvider["getMeter"]>;
	private readonly health: MutableHealth = { droppedRecords: 0, exportErrors: 0, degraded: false, failedSignals: new Set() };
	private readonly logMinimumSeverity: SeverityNumber;
	private sessionSpan?: Span;
	private sessionAttributes: TelemetryAttributes = Object.freeze({});
	private readonly agents = new Map<string, AgentRuntime>();
	private readonly agentStatuses = new Map<string, string>();
	private readonly turns = new Map<string, TimedSpan>();
	private readonly rpcs = new Map<string, TimedSpan>();
	private readonly tools = new Map<string, TimedSpan>();
	private readonly recoveries = new Map<string, TimedSpan>();
	private readonly batches = new Map<string, TimedSpan & { metricAttributes: TelemetryAttributes }>();

	private readonly agentStartedCounter: any;
	private readonly agentCompletedCounter: any;
	private readonly agentDuration: any;
	private readonly queueDuration: any;
	private readonly startupDuration: any;
	private readonly firstProgressDuration: any;
	private readonly rpcRequests: any;
	private readonly rpcDuration: any;
	private readonly toolExecutions: any;
	private readonly toolDuration: any;
	private readonly outputSize: any;
	private readonly tokens: any;
	private readonly cost: any;
	private readonly contextRecovery: any;
	private readonly messages: any;
	private readonly batchJobs: any;
	private readonly batchItems: any;
	private readonly batchDuration: any;

	constructor(config: SubagentTelemetryConfig, privacy: TelemetryPrivacy, exporters: Partial<Exporters> = {}) {
		this.config = config;
		this.privacy = privacy;
		this.logMinimumSeverity = logThreshold(config.logLevel);
		const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName, [ATTR_SERVICE_VERSION]: TELEMETRY_VERSION });

		const traceExporter = trackedExporter(exporters.trace ?? new OTLPTraceExporter({ url: config.traces.endpoint.toString(), headers: { ...config.traces.headers }, timeoutMillis: EXPORT_TIMEOUT_MS }), this.health, "traces");
		const metricExporter = trackedExporter(exporters.metrics ?? new OTLPMetricExporter({ url: config.metrics.endpoint.toString(), headers: { ...config.metrics.headers }, timeoutMillis: EXPORT_TIMEOUT_MS }), this.health, "metrics");
		const logExporter = trackedExporter(exporters.logs ?? new OTLPLogExporter({ url: config.logs.endpoint.toString(), headers: { ...config.logs.headers }, timeoutMillis: EXPORT_TIMEOUT_MS }), this.health, "logs");

		this.meterProvider = new MeterProvider({
			resource,
			readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: config.metricExportIntervalMs, exportTimeoutMillis: Math.min(EXPORT_TIMEOUT_MS, config.metricExportIntervalMs), cardinalityLimits: { default: 256 }, maxExportBatchSize: MAX_EXPORT_BATCH_SIZE })],
		});
		this.tracerProvider = new NodeTracerProvider({
			resource,
			sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.traceSampleRatio) }),
			spanLimits: { attributeCountLimit: 48, attributeValueLengthLimit: 160, eventCountLimit: 32 },
			spanProcessors: [new BatchSpanProcessor(traceExporter, { maxQueueSize: MAX_QUEUE_SIZE, maxExportBatchSize: MAX_EXPORT_BATCH_SIZE, scheduledDelayMillis: BATCH_DELAY_MS, exportTimeoutMillis: EXPORT_TIMEOUT_MS })],
		});
		this.loggerProvider = new LoggerProvider({
			resource,
			logRecordLimits: { attributeCountLimit: 48, attributeValueLengthLimit: 160 },
			processors: [new BatchLogRecordProcessor({ exporter: logExporter, maxQueueSize: MAX_QUEUE_SIZE, maxExportBatchSize: MAX_EXPORT_BATCH_SIZE, scheduledDelayMillis: BATCH_DELAY_MS, exportTimeoutMillis: EXPORT_TIMEOUT_MS })],
		});
		this.tracer = this.tracerProvider.getTracer(config.serviceName, TELEMETRY_VERSION);
		this.meter = this.meterProvider.getMeter(config.serviceName, TELEMETRY_VERSION);
		this.logger = this.loggerProvider.getLogger(config.serviceName, TELEMETRY_VERSION);

		this.agentStartedCounter = this.meter.createCounter("pi.subagent.agent.started", { unit: "{agent}" });
		this.agentCompletedCounter = this.meter.createCounter("pi.subagent.agent.completed", { unit: "{agent}" });
		this.agentDuration = this.meter.createHistogram("pi.subagent.agent.duration", { unit: "s" });
		this.queueDuration = this.meter.createHistogram("pi.subagent.agent.queue.duration", { unit: "s" });
		this.startupDuration = this.meter.createHistogram("pi.subagent.agent.startup.duration", { unit: "s" });
		this.firstProgressDuration = this.meter.createHistogram("pi.subagent.agent.first_progress.duration", { unit: "s" });
		this.rpcRequests = this.meter.createCounter("pi.subagent.rpc.requests", { unit: "{request}" });
		this.rpcDuration = this.meter.createHistogram("pi.subagent.rpc.duration", { unit: "s" });
		this.toolExecutions = this.meter.createCounter("pi.subagent.tool.executions", { unit: "{execution}" });
		this.toolDuration = this.meter.createHistogram("pi.subagent.tool.duration", { unit: "s" });
		this.outputSize = this.meter.createHistogram("pi.subagent.output.size", { unit: "By" });
		this.tokens = this.meter.createCounter("pi.subagent.tokens", { unit: "{token}" });
		this.cost = this.meter.createCounter("pi.subagent.cost", { unit: "USD" });
		this.contextRecovery = this.meter.createCounter("pi.subagent.context_recovery", { unit: "{recovery}" });
		this.messages = this.meter.createCounter("pi.subagent.messages", { unit: "{message}" });
		this.batchJobs = this.meter.createCounter("pi.subagent.batch.jobs", { unit: "{job}" });
		this.batchItems = this.meter.createCounter("pi.subagent.batch.items", { unit: "{item}" });
		this.batchDuration = this.meter.createHistogram("pi.subagent.batch.duration", { unit: "s" });
		this.meter.createObservableCounter("pi.subagent.telemetry.export.errors", { unit: "{error}" }).addCallback((observation: any) => observation.observe(this.health.exportErrors, filterMetricAttributes({ error_category: "exporter", outcome: "failed" })));
		this.meter.createObservableCounter("pi.subagent.telemetry.dropped", { unit: "{event}" }).addCallback((observation: any) => observation.observe(this.health.droppedRecords, filterMetricAttributes({ error_category: "exporter", outcome: "failed" })));

		this.meter.createObservableGauge("pi.subagent.agent.active", { unit: "{agent}" }).addCallback((observation: any) => {
			const counts = new Map<string, number>();
			for (const status of this.agentStatuses.values()) counts.set(status, (counts.get(status) ?? 0) + 1);
			for (const [status, count] of counts) observation.observe(count, filterMetricAttributes({ outcome: status }));
		});
		this.meter.createObservableGauge("pi.subagent.process.active", { unit: "{process}" }).addCallback((observation: any) => observation.observe([...this.agents.values()].filter((agent) => agent.spawnedAt !== undefined).length));
		this.meter.createObservableGauge("pi.subagent.queue.depth", { unit: "{agent}" }).addCallback((observation: any) => observation.observe([...this.agentStatuses.values()].filter((status) => status === "queued").length));
	}

	startSession(input: SessionTelemetryInput): void {
		this.safe(() => {
			if (this.sessionSpan) this.endSession({ reason: "unknown" });
			this.sessionAttributes = filterSpanLogAttributes({
				"session.id": input.sessionId ? this.privacy.hashIdentifier("session", input.sessionId) : "other",
				"project.id": this.privacy.hashIdentifier("project", input.projectPath),
				"telemetry.hash_scope": this.privacy.hashScope,
			});
			this.sessionSpan = this.tracer.startSpan("pi.subagent.session", { attributes: this.sessionAttributes, startTime: input.startedAt ?? Date.now() }, ROOT_CONTEXT);
			this.emitLog("pi.subagent.session.started", SeverityNumber.INFO, this.sessionAttributes, this.sessionSpan);
		});
	}

	endSession(input: SessionEndTelemetryInput = {}): void {
		this.safe(() => {
			const endedAt = input.endedAt ?? Date.now();
			for (const span of this.rpcs.values()) this.endTimedSpan(span, "unknown", endedAt);
			for (const span of this.tools.values()) this.endTimedSpan(span, "unknown", endedAt);
			for (const span of this.recoveries.values()) this.endTimedSpan(span, "unknown", endedAt);
			for (const span of this.turns.values()) this.endTimedSpan(span, "unknown", endedAt);
			for (const batch of this.batches.values()) this.endTimedSpan(batch, "unknown", endedAt);
			for (const agent of this.agents.values()) agent.span.end(endedAt);
			this.rpcs.clear(); this.tools.clear(); this.recoveries.clear(); this.turns.clear(); this.batches.clear(); this.agents.clear(); this.agentStatuses.clear();
			if (this.sessionSpan) {
				this.sessionSpan.setAttribute("outcome", normalizeTelemetryLabel(input.reason ?? "shutdown"));
				this.sessionSpan.end(endedAt);
				this.sessionSpan = undefined;
			}
		});
	}

	agentQueued(input: AgentTelemetryDescriptor): void {
		this.safe(() => {
			const spanAttributes = filterSpanLogAttributes({
				...this.sessionAttributes,
				"agent.id": input.agentId,
				"parent_agent.id": input.parentAgentId ?? undefined,
				"job.id": input.jobId,
				"task.id": this.privacy.hashIdentifier("task", input.taskPath),
				...modelAttributes(input.model),
				thinking_level: input.thinkingLevel,
				routing_mode: input.routingMode,
				routing_profile: input.routingProfile,
				intent: input.intent,
				complexity_tier: input.complexityTier,
				"routing.complexity_score": input.complexityScore,
				write_mode: input.writeMode,
				context_mode: input.contextMode,
				"prompt.chars": input.promptChars,
				"agent.status": "queued",
			});
			const metricAttributes = filterMetricAttributes({ ...modelAttributes(input.model), thinking_level: input.thinkingLevel, routing_mode: input.routingMode, routing_profile: input.routingProfile, intent: input.intent, complexity_tier: input.complexityTier, write_mode: input.writeMode, context_mode: input.contextMode });
			const parent = input.jobId ? this.batches.get(input.jobId)?.span : input.parentAgentId ? this.agents.get(input.parentAgentId)?.span : this.sessionSpan;
			const span = this.tracer.startSpan("pi.subagent.process", { attributes: spanAttributes, startTime: input.createdAt }, parentContext(parent));
			this.agents.set(input.agentId, { span, descriptor: input, spanAttributes, metricAttributes });
			this.agentStatuses.set(input.agentId, "queued");
			this.emitLog("pi.subagent.agent.queued", SeverityNumber.INFO, spanAttributes, span);
		});
	}

	agentStarted(input: AgentStateTelemetryInput): void {
		this.safe(() => {
			const agent = this.agents.get(input.agentId);
			if (!agent) return;
			agent.startedAt = input.at ?? Date.now();
			agent.span.setAttributes(filterSpanLogAttributes({ "agent.status": input.status, "process.state": input.processState, "agent.controllable": input.controllable }));
			this.agentStatuses.set(input.agentId, input.status);
			this.agentStartedCounter.add(1, agent.metricAttributes);
			const queueMs = Math.max(0, agent.startedAt - agent.descriptor.createdAt);
			this.queueDuration.record(queueMs / 1_000, agent.metricAttributes);
			this.emitLog("pi.subagent.agent.started", SeverityNumber.INFO, { ...agent.spanAttributes, "queue.duration_ms": queueMs }, agent.span);
		});
	}

	agentFirstProgress(agentId: string, at = Date.now()): void {
		this.safe(() => {
			const turn = [...this.turns.values()].find((candidate) => candidate.agentId === agentId);
			if (!turn) return;
			const durationMs = Math.max(0, at - turn.startedAt);
			const attrs = this.agents.get(agentId)?.metricAttributes ?? Object.freeze({});
			this.firstProgressDuration.record(durationMs / 1_000, attrs);
			turn.span.addEvent("first_progress", { "first_progress.duration_ms": durationMs }, at);
		});
	}

	agentCompleted(input: AgentCompletionTelemetryInput): void {
		this.safe(() => {
			const agent = this.agents.get(input.agentId);
			if (!agent) return;
			this.agentStatuses.set(input.agentId, input.status);
			const attrs = filterMetricAttributes({ ...agent.metricAttributes, outcome: input.outcome, error_category: input.error === undefined ? undefined : this.privacy.sanitizeError(input.error).category });
			this.agentCompletedCounter.add(1, attrs);
			agent.span.setAttributes(filterSpanLogAttributes({ "agent.status": input.status, "process.state": input.processState, "agent.controllable": input.controllable, outcome: input.outcome, "output.chars": input.outputChars, ...errorAttributes(this.privacy, input.error) }));
			this.emitLog("pi.subagent.agent.completed", severityForOutcome(input.outcome), { ...agent.spanAttributes, outcome: input.outcome, ...errorAttributes(this.privacy, input.error) }, agent.span);
		});
	}

	processSpawned(input: { agentId: string; at?: number; pid?: number }): void {
		this.safe(() => {
			const agent = this.agents.get(input.agentId);
			if (!agent) return;
			agent.spawnedAt = input.at ?? Date.now();
			agent.span.setAttributes(filterSpanLogAttributes({ "process.pid": input.pid, "process.state": "live_running" }));
			if (agent.startedAt !== undefined) this.startupDuration.record(Math.max(0, agent.spawnedAt - agent.startedAt) / 1_000, agent.metricAttributes);
		});
	}

	processExited(input: AgentStateTelemetryInput & { exitCode?: number; signal?: string }): void {
		this.safe(() => {
			const agent = this.agents.get(input.agentId);
			if (!agent) return;
			const outcome: TelemetryOutcome = input.error ? "failed" : input.status === "succeeded" ? "succeeded" : input.status === "failed" ? "failed" : input.status === "lost" ? "lost" : input.status === "interrupted" ? "interrupted" : "closed";
			agent.span.setAttributes(filterSpanLogAttributes({ outcome, "agent.status": input.status, "process.state": input.processState, "agent.controllable": false, ...errorAttributes(this.privacy, input.error) }));
			agent.span.setStatus(outcomeStatus(outcome));
			agent.span.end(input.at ?? Date.now());
			this.agents.delete(input.agentId);
			this.agentStatuses.delete(input.agentId);
		});
	}

	protocolError(input: { agentId: string; at?: number; error: unknown }): void {
		this.safe(() => {
			const agent = this.agents.get(input.agentId);
			const attrs = filterSpanLogAttributes({ "agent.id": input.agentId, ...errorAttributes(this.privacy, input.error) });
			agent?.span.addEvent("rpc.protocol_error", attrs, input.at ?? Date.now());
			this.emitLog("pi.subagent.rpc.protocol_error", SeverityNumber.ERROR, attrs, agent?.span);
		});
	}

	providerError(input: { agentId: string; turnId?: string; at?: number; error: unknown }): void {
		this.safe(() => {
			const turn = input.turnId ? this.turns.get(input.turnId) : undefined;
			const attrs = filterSpanLogAttributes({ "agent.id": input.agentId, "turn.id": input.turnId, ...errorAttributes(this.privacy, input.error) });
			(turn?.span ?? this.agents.get(input.agentId)?.span)?.addEvent("provider.error", attrs, input.at ?? Date.now());
			this.emitLog("pi.subagent.provider.error", SeverityNumber.ERROR, attrs, turn?.span ?? this.agents.get(input.agentId)?.span);
		});
	}

	turnStarted(input: TurnTelemetryInput): void {
		this.safe(() => {
			const agent = this.agents.get(input.agentId);
			const startedAt = input.at ?? Date.now();
			const attrs = filterSpanLogAttributes({ "agent.id": input.agentId, "turn.id": input.turnId, "turn.kind": input.kind, outcome: "unknown" });
			const span = this.tracer.startSpan("pi.subagent.turn", { attributes: attrs, startTime: startedAt }, parentContext(agent?.span ?? this.sessionSpan));
			this.turns.set(input.turnId, { span, startedAt, context: parentContext(span), agentId: input.agentId });
		});
	}

	turnCompleted(input: TurnCompletionTelemetryInput): void {
		this.safe(() => {
			const turn = this.turns.get(input.turnId);
			const agent = this.agents.get(input.agentId);
			if (!turn) return;
			const metricAttrs = filterMetricAttributes({ ...agent?.metricAttributes, outcome: input.outcome, error_category: input.error === undefined ? undefined : this.privacy.sanitizeError(input.error).category });
			this.recordUsage(input, metricAttrs);
			if (input.durationMs !== undefined) this.agentDuration.record(input.durationMs / 1_000, metricAttrs);
			if (input.outputChars !== undefined) this.outputSize.record(input.outputChars, metricAttrs);
			turn.span.setAttributes(filterSpanLogAttributes({ outcome: input.outcome, "duration_ms": input.durationMs, "output.chars": input.outputChars, "tool.calls": input.toolCalls, "provider.requests": input.providerRequests, "compactions": input.compactions, "tokens.input": input.inputTokens, "tokens.output": input.outputTokens, "tokens.cache_read": input.cacheReadTokens, "tokens.cache_write": input.cacheWriteTokens, "tokens.total": input.totalTokens, "cost.usd": input.costUsd, ...errorAttributes(this.privacy, input.error) }));
			this.endTimedSpan(turn, input.outcome, input.at ?? Date.now());
			this.turns.delete(input.turnId);
		});
	}

	routingResolved(input: RoutingTelemetryInput): void {
		this.safe(() => {
			const agent = this.agents.get(input.agentId);
			const attrs = filterSpanLogAttributes({ "agent.id": input.agentId, "route.id": input.routeId, routing_mode: input.mode, routing_profile: input.profile, intent: input.intent, complexity_tier: input.complexityTier, "routing.complexity_score": input.complexityScore, ...modelAttributes(input.selectedModel), thinking_level: input.selectedThinkingLevel, "routing.estimated_input_tokens": input.estimatedInputTokens, "routing.estimated_output_tokens": input.estimatedOutputTokens, outcome: input.applied ? "succeeded" : "unknown" });
			agent?.span.addEvent("routing.resolved", attrs, input.at ?? Date.now());
			this.emitLog("pi.subagent.routing.resolved", SeverityNumber.INFO, attrs, agent?.span);
		});
	}

	rpcStarted(input: RpcTelemetryInput): void {
		this.safe(() => {
			const startedAt = input.at ?? Date.now();
			const attrs = filterSpanLogAttributes({ "agent.id": input.agentId, "turn.id": input.turnId, "rpc.request.id": input.requestId, rpc_command: input.command });
			const parent = input.turnId ? this.turns.get(input.turnId)?.span : this.agents.get(input.agentId)?.span;
			const span = this.tracer.startSpan("pi.subagent.rpc", { attributes: attrs, startTime: startedAt }, parentContext(parent ?? this.sessionSpan));
			this.rpcs.set(`${input.agentId}:${input.requestId}`, { span, startedAt, context: parentContext(span), agentId: input.agentId });
		});
	}

	rpcCompleted(input: RpcCompletionTelemetryInput): void {
		this.safe(() => {
			const key = `${input.agentId}:${input.requestId}`;
			const timed = this.rpcs.get(key);
			const attrs = filterMetricAttributes({ rpc_command: input.command, outcome: input.outcome, error_category: input.error === undefined ? undefined : this.privacy.sanitizeError(input.error).category });
			this.rpcRequests.add(1, attrs);
			if (input.durationMs !== undefined) this.rpcDuration.record(input.durationMs / 1_000, attrs);
			if (timed) {
				timed.span.setAttributes(filterSpanLogAttributes({ outcome: input.outcome, "duration_ms": input.durationMs, ...errorAttributes(this.privacy, input.error) }));
				this.endTimedSpan(timed, input.outcome, input.at ?? Date.now());
				this.rpcs.delete(key);
			}
		});
	}

	toolStarted(input: ToolTelemetryInput): void {
		this.safe(() => {
			const startedAt = input.at ?? Date.now();
			const attrs = filterSpanLogAttributes({ "agent.id": input.agentId, "turn.id": input.turnId, "tool.call.id": input.toolCallId, tool_name: input.toolName });
			const parent = input.turnId ? this.turns.get(input.turnId)?.span : this.agents.get(input.agentId)?.span;
			const span = this.tracer.startSpan("pi.subagent.tool", { attributes: attrs, startTime: startedAt }, parentContext(parent ?? this.sessionSpan));
			this.tools.set(`${input.agentId}:${input.toolCallId}`, { span, startedAt, context: parentContext(span), agentId: input.agentId });
		});
	}

	toolCompleted(input: ToolCompletionTelemetryInput): void {
		this.safe(() => {
			const key = `${input.agentId}:${input.toolCallId}`;
			const timed = this.tools.get(key);
			const attrs = filterMetricAttributes({ tool_name: input.toolName, outcome: input.outcome, error_category: input.error === undefined ? undefined : this.privacy.sanitizeError(input.error).category });
			this.toolExecutions.add(1, attrs);
			if (input.durationMs !== undefined) this.toolDuration.record(input.durationMs / 1_000, attrs);
			if (timed) {
				timed.span.setAttributes(filterSpanLogAttributes({ outcome: input.outcome, "duration_ms": input.durationMs, "result.chars": input.resultChars, "result.truncated": input.resultTruncated, ...errorAttributes(this.privacy, input.error) }));
				this.endTimedSpan(timed, input.outcome, input.at ?? Date.now());
				this.tools.delete(key);
			}
		});
	}

	recovery(input: RecoveryTelemetryInput): void {
		this.safe(() => {
			const key = `${input.agentId}:${input.type}`;
			if (input.phase === "started") {
				if (this.recoveries.has(key)) return;
				const startedAt = input.at ?? Date.now();
				const parent = input.turnId ? this.turns.get(input.turnId)?.span : this.agents.get(input.agentId)?.span;
				const span = this.tracer.startSpan("pi.subagent.context_recovery", { attributes: filterSpanLogAttributes({ "agent.id": input.agentId, "turn.id": input.turnId, recovery_type: input.type }), startTime: startedAt }, parentContext(parent ?? this.sessionSpan));
				this.recoveries.set(key, { span, startedAt, context: parentContext(span), agentId: input.agentId });
				return;
			}
			const timed = this.recoveries.get(key);
			const outcome = input.outcome ?? "unknown";
			const attrs = filterMetricAttributes({ recovery_type: input.type, outcome, error_category: input.error === undefined ? undefined : this.privacy.sanitizeError(input.error).category });
			this.contextRecovery.add(1, attrs);
			if (timed) {
				timed.span.setAttributes(filterSpanLogAttributes({ outcome, "duration_ms": input.durationMs, ...errorAttributes(this.privacy, input.error) }));
				this.endTimedSpan(timed, outcome, input.at ?? Date.now());
				this.recoveries.delete(key);
			}
			this.emitLog("pi.subagent.recovery.completed", severityForOutcome(outcome), { "agent.id": input.agentId, recovery_type: input.type, outcome, ...errorAttributes(this.privacy, input.error) }, this.agents.get(input.agentId)?.span);
		});
	}

	messageDelivered(input: MessageTelemetryInput): void {
		this.safe(() => {
			const attrs = filterMetricAttributes({ message_kind: input.kind, "message.kind": input.kind, delivery_mode: input.deliveryMode, outcome: input.delivered ? "succeeded" : "failed" });
			this.messages.add(1, attrs);
			this.emitLog("pi.subagent.message", input.delivered ? SeverityNumber.INFO : SeverityNumber.WARN, { "agent.id": input.agentId, "message.kind": input.kind, delivery_mode: input.deliveryMode, "message.delivered": input.delivered, "message.queued": input.queued }, this.agents.get(input.agentId)?.span, input.at);
		});
	}

	batchStarted(input: BatchTelemetryDescriptor): void {
		this.safe(() => {
			const attrs = filterSpanLogAttributes({ ...this.sessionAttributes, "job.id": input.jobId, "task.id": this.privacy.hashIdentifier("batch", input.nameHashSource), batch_source: input.source, "batch.max_concurrency": input.maxConcurrency, "batch.item_count": input.itemCount });
			const metricAttributes = filterMetricAttributes({ batch_source: input.source });
			const span = this.tracer.startSpan("pi.subagent.batch", { attributes: attrs, startTime: input.createdAt }, parentContext(this.sessionSpan));
			this.batches.set(input.jobId, { span, startedAt: input.createdAt, context: parentContext(span), metricAttributes });
			this.batchJobs.add(1, filterMetricAttributes({ ...metricAttributes, outcome: "started" }));
			this.emitLog("pi.subagent.batch.started", SeverityNumber.INFO, attrs, span);
		});
	}

	batchItem(input: BatchItemTelemetryInput): void {
		this.safe(() => {
			const batch = this.batches.get(input.jobId);
			const attrs = filterMetricAttributes({ ...batch?.metricAttributes, outcome: input.outcome ?? input.phase });
			if (input.phase === "completed") this.batchItems.add(1, attrs);
			batch?.span.addEvent(`batch.item.${input.phase}`, filterSpanLogAttributes({ "batch.item.id": this.privacy.hashIdentifier("batch-item", input.itemId), "agent.id": input.agentId, "batch.item.phase": input.phase, outcome: input.outcome, "queue.duration_ms": input.queueDurationMs, "duration_ms": input.durationMs, ...errorAttributes(this.privacy, input.error) }), input.at ?? Date.now());
		});
	}

	batchCompleted(input: BatchCompletionTelemetryInput): void {
		this.safe(() => {
			const batch = this.batches.get(input.jobId);
			const attrs = filterMetricAttributes({ ...batch?.metricAttributes, outcome: input.outcome, error_category: input.error === undefined ? undefined : this.privacy.sanitizeError(input.error).category });
			this.batchJobs.add(1, attrs);
			if (input.durationMs !== undefined) this.batchDuration.record(input.durationMs / 1_000, attrs);
			if (batch) {
				batch.span.setAttributes(filterSpanLogAttributes({ outcome: input.outcome, "duration_ms": input.durationMs, "batch.item_count": input.total, "batch.succeeded": input.succeeded, "batch.failed": input.failed, "batch.cancelled": input.cancelled, "batch.lost": input.lost, ...errorAttributes(this.privacy, input.error) }));
				this.endTimedSpan(batch, input.outcome, input.at ?? Date.now());
				this.batches.delete(input.jobId);
			}
		});
	}

	getHealth(): TelemetryHealth {
		return {
			enabled: true,
			requestedEnabled: this.config.requestedEnabled,
			degraded: this.health.degraded,
			lastSuccessfulExportAt: this.health.lastSuccessfulExportAt,
			lastErrorCategory: this.health.lastErrorCategory,
			droppedRecords: this.health.droppedRecords,
			traceSampleRatio: this.config.traceSampleRatio,
			collectorOrigin: safeEndpointOrigin(this.config.traces.endpoint),
			configurationIssues: this.config.issues.map((item) => `${item.code}:${item.field}`),
		};
	}

	async forceFlush(): Promise<void> {
		try {
			await Promise.all([this.tracerProvider.forceFlush(), this.meterProvider.forceFlush(), this.loggerProvider.forceFlush({ timeoutMillis: DEFAULT_SHUTDOWN_TIMEOUT_MS })]);
			this.health.failedSignals.delete("internal");
			this.health.degraded = this.health.failedSignals.size > 0;
			if (!this.health.degraded) this.health.lastErrorCategory = undefined;
		} catch {
			this.recordExporterError();
		}
	}

	async shutdown(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
		let completed = false;
		const shutdown = Promise.allSettled([this.tracerProvider.shutdown(), this.meterProvider.shutdown({ timeoutMillis: timeoutMs }), this.loggerProvider.shutdown()]).then((results) => {
			completed = true;
			if (results.some((result) => result.status === "rejected")) this.recordExporterError();
		});
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				shutdown,
				new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(1, timeoutMs)); timer.unref?.(); }),
			]);
			if (!completed) this.recordExporterError();
		} catch {
			this.recordExporterError();
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private recordUsage(input: TurnCompletionTelemetryInput, attributes: TelemetryAttributes): void {
		for (const [type, value] of [
			["input", input.inputTokens],
			["output", input.outputTokens],
			["cache_read", input.cacheReadTokens],
			["cache_write", input.cacheWriteTokens],
		] as const) {
			if (value !== undefined) this.tokens.add(value, filterMetricAttributes({ ...attributes, "token.type": type }));
		}
		if (input.costUsd !== undefined) this.cost.add(input.costUsd, attributes);
	}

	private endTimedSpan(timed: TimedSpan, outcome: TelemetryOutcome, at: number): void {
		timed.span.setAttribute("outcome", outcome);
		timed.span.setStatus(outcomeStatus(outcome));
		timed.span.end(at);
	}

	private emitLog(eventName: string, severityNumber: SeverityNumber, attributes: Readonly<Record<string, unknown>>, span?: Span, timestamp = Date.now()): void {
		if (severityNumber < this.logMinimumSeverity) return;
		this.logger.emit({ eventName, body: eventName, timestamp, severityNumber, severityText: SeverityNumber[severityNumber], attributes: filterSpanLogAttributes(attributes), context: parentContext(span) });
	}

	private recordExporterError(): void {
		this.health.failedSignals.add("internal");
		this.health.degraded = true;
		this.health.lastErrorCategory = "exporter";
		this.health.exportErrors += 1;
	}

	private safe(operation: () => void): void {
		try { operation(); } catch { this.recordExporterError(); }
	}
}

export async function createOpenTelemetrySubagentTelemetry(
	config: SubagentTelemetryConfig,
	options: CreateOpenTelemetryOptions = {},
): Promise<SubagentTelemetry> {
	if (!config.enabled) return NOOP_SUBAGENT_TELEMETRY;
	try {
		const privacy = options.privacy ?? await createTelemetryPrivacy();
		return new OpenTelemetrySubagentTelemetry(config, privacy, options.exporters);
	} catch {
		return NOOP_SUBAGENT_TELEMETRY;
	}
}
