import type { SubagentTelemetryConfig } from "./Config.ts";
import type {
	TelemetryAnalysisFocus,
	TelemetryAnalysisRequest,
	TelemetryAnalysisSnapshot,
	TelemetryAnalysisWindow,
	TelemetryBackendAvailability,
	TelemetryMetricResult,
	TelemetrySloViolation,
	TelemetryTraceExample,
} from "./AnalysisTypes.ts";
import { SPAN_LOG_ATTRIBUTE_KEYS } from "./Privacy.ts";

const WINDOW_SECONDS: Record<TelemetryAnalysisWindow, number> = {
	"1h": 3_600,
	"6h": 21_600,
	"24h": 86_400,
	"3d": 259_200,
	"7d": 604_800,
};
const DEFAULT_TIMEOUT_MS = 10_000;
const TRACE_OPERATION_PREFIX = "pi.subagent.";
const SAFE_TRACE_TAGS = new Set<string>(SPAN_LOG_ATTRIBUTE_KEYS);

interface QueryDefinition {
	id: string;
	focus: Exclude<TelemetryAnalysisFocus, "all">;
	unit: string;
	kind: "count" | "ratio" | "average" | "sampled";
	valuePromql: string;
	samplePromql?: string;
}

const QUERIES: QueryDefinition[] = [
	{ id: "completed_total", focus: "reliability", unit: "turns", kind: "count", valuePromql: "sum(increase(pi_subagent_agent_completed_total[$WINDOW]))" },
	{ id: "success_rate", focus: "reliability", unit: "ratio", kind: "ratio", valuePromql: "sum(increase(pi_subagent_agent_completed_total{outcome=\"succeeded\"}[$WINDOW]))", samplePromql: "sum(increase(pi_subagent_agent_completed_total[$WINDOW]))" },
	{ id: "timeout_lost_rate", focus: "reliability", unit: "ratio", kind: "ratio", valuePromql: "sum(increase(pi_subagent_agent_completed_total{outcome=~\"timeout|lost\"}[$WINDOW]))", samplePromql: "sum(increase(pi_subagent_agent_completed_total[$WINDOW]))" },
	{ id: "rpc_failure_rate", focus: "reliability", unit: "ratio", kind: "ratio", valuePromql: "sum(increase(pi_subagent_rpc_requests_total{outcome=\"failed\"}[$WINDOW]))", samplePromql: "sum(increase(pi_subagent_rpc_requests_total[$WINDOW]))" },
	{ id: "recovery_success_rate", focus: "reliability", unit: "ratio", kind: "ratio", valuePromql: "sum(increase(pi_subagent_context_recovery_total{outcome=\"succeeded\"}[$WINDOW]))", samplePromql: "sum(increase(pi_subagent_context_recovery_total[$WINDOW]))" },
	{ id: "cost_total", focus: "cost", unit: "USD", kind: "sampled", valuePromql: "sum(increase(pi_subagent_cost_USD_total[$WINDOW]))", samplePromql: "sum(increase(pi_subagent_agent_completed_total[$WINDOW]))" },
	{ id: "tokens_total", focus: "cost", unit: "tokens", kind: "sampled", valuePromql: "sum(increase(pi_subagent_tokens_total[$WINDOW]))", samplePromql: "sum(increase(pi_subagent_agent_completed_total[$WINDOW]))" },
	{ id: "cost_per_success", focus: "cost", unit: "USD/turn", kind: "average", valuePromql: "sum(increase(pi_subagent_cost_USD_total[$WINDOW]))", samplePromql: "sum(increase(pi_subagent_agent_completed_total{outcome=\"succeeded\"}[$WINDOW]))" },
	{ id: "agent_duration_p95", focus: "ux", unit: "seconds", kind: "sampled", valuePromql: "histogram_quantile(0.95, sum by (le) (rate(pi_subagent_agent_duration_seconds_bucket[$WINDOW])))", samplePromql: "sum(increase(pi_subagent_agent_duration_seconds_count[$WINDOW]))" },
	{ id: "queue_duration_p95", focus: "ux", unit: "seconds", kind: "sampled", valuePromql: "histogram_quantile(0.95, sum by (le) (rate(pi_subagent_agent_queue_duration_seconds_bucket[$WINDOW])))", samplePromql: "sum(increase(pi_subagent_agent_queue_duration_seconds_count[$WINDOW]))" },
	{ id: "first_progress_p95", focus: "ux", unit: "seconds", kind: "sampled", valuePromql: "histogram_quantile(0.95, sum by (le) (rate(pi_subagent_agent_first_progress_duration_seconds_bucket[$WINDOW])))", samplePromql: "sum(increase(pi_subagent_agent_first_progress_duration_seconds_count[$WINDOW]))" },
	{ id: "steering_delivery_rate", focus: "ux", unit: "ratio", kind: "ratio", valuePromql: "sum(increase(pi_subagent_messages_total{delivery_mode=\"rpc_steer\",outcome=\"succeeded\"}[$WINDOW]))", samplePromql: "sum(increase(pi_subagent_messages_total{delivery_mode=\"rpc_steer\"}[$WINDOW]))" },
	{ id: "router_completed_total", focus: "routing", unit: "routes", kind: "count", valuePromql: "sum(increase(pi_model_router_observations_total[$WINDOW]))" },
	{ id: "router_success_rate", focus: "routing", unit: "ratio", kind: "ratio", valuePromql: "sum(increase(pi_model_router_observations_total{outcome=\"succeeded\"}[$WINDOW]))", samplePromql: "sum(increase(pi_model_router_observations_total[$WINDOW]))" },
	{ id: "router_quality_mean", focus: "routing", unit: "score", kind: "average", valuePromql: "sum(increase(pi_model_router_quality_sum[$WINDOW]))", samplePromql: "sum(increase(pi_model_router_quality_count[$WINDOW]))" },
	{ id: "router_quality_coverage", focus: "routing", unit: "ratio", kind: "ratio", valuePromql: "sum(increase(pi_model_router_quality_count[$WINDOW]))", samplePromql: "sum(increase(pi_model_router_observations_total[$WINDOW]))" },
	{ id: "router_latency_p95", focus: "routing", unit: "milliseconds", kind: "sampled", valuePromql: "histogram_quantile(0.95, sum by (le) (rate(pi_model_router_latency_milliseconds_bucket[$WINDOW])))", samplePromql: "sum(increase(pi_model_router_latency_milliseconds_count[$WINDOW]))" },
	{ id: "router_rollout_transitions", focus: "routing", unit: "transitions", kind: "count", valuePromql: "sum(increase(pi_model_router_rollout_transitions_total[$WINDOW]))" },
];

function selectedQueries(focus: TelemetryAnalysisFocus): QueryDefinition[] {
	return QUERIES.filter((query) => focus === "all" || query.focus === focus);
}

function numberFromPrometheus(payload: any): number | undefined {
	if (payload?.status !== "success") return undefined;
	const result = payload?.data?.result;
	if (payload?.data?.resultType === "scalar" && Array.isArray(result)) {
		const value = Number(result[1]);
		return Number.isFinite(value) ? value : undefined;
	}
	if (!Array.isArray(result) || result.length === 0) return undefined;
	let total = 0;
	let found = false;
	for (const item of result) {
		const value = Number(item?.value?.[1]);
		if (!Number.isFinite(value)) continue;
		total += value;
		found = true;
	}
	return found ? total : undefined;
}

async function fetchJson(url: URL, headers: Readonly<Record<string, string>>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
	const response = await fetch(url, { method: "GET", headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`Telemetry query returned HTTP ${response.status}`);
	return response.json();
}

function queryUrl(base: URL, path: string): URL {
	return new URL(path.replace(/^\//, ""), `${base.toString().replace(/\/+$/, "")}/`);
}

async function prometheusQuery(config: SubagentTelemetryConfig, query: string, timeSeconds: number): Promise<number | undefined> {
	const url = queryUrl(config.prometheusUrl, "/api/v1/query");
	url.searchParams.set("query", query);
	url.searchParams.set("time", String(timeSeconds));
	return numberFromPrometheus(await fetchJson(url, config.queryHeaders));
}

function traceTagValue(span: any, key: string): string | undefined {
	const tag = Array.isArray(span?.tags) ? span.tags.find((candidate: any) => candidate?.key === key && SAFE_TRACE_TAGS.has(candidate.key)) : undefined;
	if (!tag) return undefined;
	const value = tag.value;
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value).slice(0, 80) : undefined;
}

function summarizeTrace(trace: any, jaegerUrl: URL): TelemetryTraceExample | undefined {
	const traceId = typeof trace?.traceID === "string" && /^[a-fA-F0-9]{16,32}$/.test(trace.traceID) ? trace.traceID : undefined;
	if (!traceId || !Array.isArray(trace.spans) || trace.spans.length === 0) return undefined;
	const spans = trace.spans.filter((span: any) => typeof span?.operationName === "string" && span.operationName.startsWith(TRACE_OPERATION_PREFIX));
	if (spans.length === 0) return undefined;
	const starts = spans.map((span: any) => Number(span.startTime)).filter(Number.isFinite);
	const ends = spans.map((span: any) => Number(span.startTime) + Number(span.duration)).filter(Number.isFinite);
	const durationMs = starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) / 1_000 : 0;
	const outcome = spans.map((span: any) => traceTagValue(span, "outcome")).find((value: string | undefined) => value && value !== "unknown");
	const errorCategory = spans.map((span: any) => traceTagValue(span, "error_category")).find(Boolean);
	const operations = spans.map((span: any): string => String(span.operationName).slice(0, 80));
	return {
		traceId,
		durationMs,
		outcome,
		errorCategory,
		operations: [...new Set<string>(operations)].slice(0, 12),
		url: queryUrl(jaegerUrl, `/trace/${traceId}`).toString(),
	};
}

async function jaegerTraces(config: SubagentTelemetryConfig, startMs: number, endMs: number, limit: number): Promise<TelemetryTraceExample[]> {
	const url = queryUrl(config.jaegerUrl, "/api/traces");
	url.searchParams.set("service", config.serviceName);
	url.searchParams.set("start", String(Math.floor(startMs * 1_000)));
	url.searchParams.set("end", String(Math.floor(endMs * 1_000)));
	url.searchParams.set("limit", String(limit));
	const payload = await fetchJson(url, config.queryHeaders);
	const traces = Array.isArray(payload?.data) ? payload.data : [];
	return traces
		.map((trace: any) => summarizeTrace(trace, config.jaegerUrl))
		.filter((trace: TelemetryTraceExample | undefined): trace is TelemetryTraceExample => Boolean(trace))
		.sort((left: TelemetryTraceExample, right: TelemetryTraceExample) => {
			const leftProblem = left.outcome && left.outcome !== "succeeded" ? 1 : 0;
			const rightProblem = right.outcome && right.outcome !== "succeeded" ? 1 : 0;
			return rightProblem - leftProblem || right.durationMs - left.durationMs;
		})
		.slice(0, limit);
}

function computeViolations(metrics: TelemetryMetricResult[]): TelemetrySloViolation[] {
	const violations: TelemetrySloViolation[] = [];
	const eligible = (id: string) => metrics.find((metric) => metric.id === id && metric.available && metric.sampleCount >= 10);
	const below = (id: string, threshold: number, message: string) => {
		const metric = eligible(id);
		if (metric?.value !== undefined && metric.value < threshold) violations.push({ id, severity: metric.value < threshold * 0.8 ? "critical" : "warning", message, sampleCount: metric.sampleCount });
	};
	const above = (id: string, threshold: number, message: string) => {
		const metric = eligible(id);
		if (metric?.value !== undefined && metric.value > threshold) violations.push({ id, severity: metric.value > threshold * 2 ? "critical" : "warning", message, sampleCount: metric.sampleCount });
	};
	below("success_rate", 0.95, "Successful turns are below the 95% target.");
	above("timeout_lost_rate", 0.01, "Timed-out and lost turns exceed the 1% target.");
	above("rpc_failure_rate", 0.005, "RPC failures exceed the 0.5% target.");
	below("recovery_success_rate", 0.9, "Context recovery success is below the 90% target.");
	above("queue_duration_p95", 5, "Interactive p95 queue time exceeds five seconds.");
	above("first_progress_p95", 10, "p95 time to first progress exceeds ten seconds.");
	below("steering_delivery_rate", 0.99, "Live steering delivery is below the 99% target.");
	below("router_success_rate", 0.95, "Routed-call success is below the 95% target.");
	below("router_quality_mean", 0.6, "Labelled routed-call quality is below the 60% target.");
	const completed = metrics.find((metric) => metric.id === "completed_total")?.value ?? 0;
	const cost = metrics.find((metric) => metric.id === "cost_per_success");
	if (completed >= 10 && cost?.value !== undefined && cost.previousValue !== undefined && cost.previousValue > 0 && cost.value > cost.previousValue * 1.2) {
		violations.push({ id: "cost_per_success", severity: "warning", message: "Cost per successful turn regressed by more than 20%.", sampleCount: cost.sampleCount });
	}
	return violations;
}

export class TelemetryAnalysisClient {
	private readonly config: SubagentTelemetryConfig;

	constructor(config: SubagentTelemetryConfig) {
		this.config = config;
	}

	async analyze(request: TelemetryAnalysisRequest = {}): Promise<TelemetryAnalysisSnapshot> {
		const window = request.window ?? "24h";
		const focus = request.focus ?? "all";
		const comparePreviousPeriod = request.comparePreviousPeriod ?? true;
		const maxTraceExamples = Math.max(0, Math.min(Math.floor(request.maxTraceExamples ?? 10), 25));
		const nowMs = Date.now();
		const windowSeconds = WINDOW_SECONDS[window];
		const queries = selectedQueries(focus);
		let prometheusAvailable = false;
		const metrics = await Promise.all(queries.map(async (definition): Promise<TelemetryMetricResult> => {
			const evaluate = async (at: number): Promise<{ value?: number; sampleCount: number; error?: TelemetryMetricResult["error"] }> => {
				const numerator = await prometheusQuery(this.config, definition.valuePromql.replaceAll("$WINDOW", window), at);
				if (numerator === undefined) return { sampleCount: 0, error: "unavailable" };
				if (definition.kind === "count") return { value: numerator, sampleCount: numerator };
				const denominator = await prometheusQuery(this.config, definition.samplePromql!.replaceAll("$WINDOW", window), at);
				if (denominator === undefined) return { sampleCount: 0, error: "unavailable" };
				if (denominator <= 0) return { sampleCount: 0, error: "zero_denominator" };
				return { value: definition.kind === "ratio" || definition.kind === "average" ? numerator / denominator : numerator, sampleCount: denominator };
			};
			try {
				const current = await evaluate(nowMs / 1_000);
				prometheusAvailable = true;
				let previous: Awaited<ReturnType<typeof evaluate>> | undefined;
				if (comparePreviousPeriod && window !== "7d") previous = await evaluate(nowMs / 1_000 - windowSeconds);
				return { id: definition.id, focus: definition.focus, value: current.value, previousValue: previous?.value, delta: current.value !== undefined && previous?.value !== undefined ? current.value - previous.value : undefined, unit: definition.unit, available: current.value !== undefined, sampleCount: current.sampleCount, previousSampleCount: previous?.sampleCount, error: current.error };
			} catch {
				return { id: definition.id, focus: definition.focus, unit: definition.unit, available: false, sampleCount: 0, error: "unavailable" };
			}
		}));

		let traceExamples: TelemetryTraceExample[] = [];
		let jaegerAvailable = false;
		if (maxTraceExamples > 0) {
			try {
				traceExamples = await jaegerTraces(this.config, nowMs - windowSeconds * 1_000, nowMs, maxTraceExamples);
				jaegerAvailable = true;
			} catch {
				traceExamples = [];
			}
		}
		const warnings: string[] = [];
		if (!prometheusAvailable) warnings.push("Prometheus was unavailable; metric analysis is incomplete.");
		if (!jaegerAvailable && maxTraceExamples > 0) warnings.push("Jaeger was unavailable; trace examples are omitted.");
		if (comparePreviousPeriod && window === "7d") warnings.push("Previous-period comparison is unavailable for the seven-day retention window.");
		const completed = metrics.find((metric) => metric.id === "completed_total");
		const routed = metrics.find((metric) => metric.id === "router_completed_total");
		if (completed && completed.sampleCount < 10) warnings.push(`Insufficient Subagent samples for SLO findings (${completed.sampleCount}/10); do not infer failure or success.`);
		if (routed && routed.sampleCount < 10) warnings.push(`Insufficient router samples for SLO findings (${routed.sampleCount}/10); remain in shadow.`);
		return { generatedAt: nowMs, window, focus, comparePreviousPeriod: comparePreviousPeriod && window !== "7d", metrics, traceExamples, violations: computeViolations(metrics), warnings, prometheusAvailable, jaegerAvailable };
	}

	async probe(timeoutMs = 2_000): Promise<TelemetryBackendAvailability> {
		const [prometheus, jaeger] = await Promise.all([
			fetchJson(queryUrl(this.config.prometheusUrl, "/api/v1/status/buildinfo"), this.config.queryHeaders, timeoutMs).then(() => true, () => false),
			fetchJson(queryUrl(this.config.jaegerUrl, "/api/services"), this.config.queryHeaders, timeoutMs).then(() => true, () => false),
		]);
		return { prometheus, jaeger };
	}
}

function formatNumber(value: number | undefined, unit: string): string {
	if (value === undefined) return "unavailable";
	if (unit === "ratio") return `${(value * 100).toFixed(2)}%`;
	if (unit === "USD" || unit === "USD/turn") return `$${value.toFixed(6)}`;
	if (unit === "seconds") return `${value.toFixed(3)}s`;
	return `${Number.isInteger(value) ? value : value.toFixed(3)} ${unit}`;
}

export function formatTelemetryAnalysis(snapshot: TelemetryAnalysisSnapshot, maxChars = 16_000): string {
	const lines = [
		`# Pi Subagent Telemetry Analysis`,
		`Window: ${snapshot.window}; focus: ${snapshot.focus}; generated: ${new Date(snapshot.generatedAt).toISOString()}`,
		`Backends: Prometheus=${snapshot.prometheusAvailable ? "available" : "unavailable"}, Jaeger=${snapshot.jaegerAvailable ? "available" : "unavailable"}`,
		"",
		"## Metrics",
	];
	for (const metric of snapshot.metrics) {
		const previous = metric.previousValue === undefined ? "" : `; previous=${formatNumber(metric.previousValue, metric.unit)}; delta=${formatNumber(metric.delta, metric.unit)}`;
		lines.push(`- ${metric.id}: ${formatNumber(metric.value, metric.unit)}; samples=${metric.sampleCount}${previous}`);
	}
	lines.push("", "## SLO findings");
	const eligibleSamples = Math.max(0, ...snapshot.metrics.map((metric) => metric.sampleCount));
	if (snapshot.violations.length === 0) lines.push(eligibleSamples < 10 ? `- Insufficient data (${eligibleSamples}/10 eligible samples).` : "- No SLO violations detected in eligible data.");
	else for (const violation of snapshot.violations) lines.push(`- ${violation.severity.toUpperCase()} ${violation.id} (n=${violation.sampleCount}): ${violation.message}`);
	lines.push("", "## Trace examples");
	if (snapshot.traceExamples.length === 0) lines.push("- None available.");
	else for (const trace of snapshot.traceExamples) lines.push(`- ${trace.traceId}: ${trace.durationMs.toFixed(1)}ms; outcome=${trace.outcome ?? "unknown"}; error=${trace.errorCategory ?? "none"}; operations=${trace.operations.join(", ")}; ${trace.url}`);
	if (snapshot.warnings.length) {
		lines.push("", "## Data-quality warnings");
		for (const warning of snapshot.warnings) lines.push(`- ${warning}`);
	}
	const text = lines.join("\n");
	return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 48))}\n[analysis output truncated to ${maxChars} characters]`;
}

export const TELEMETRY_QUERY_IDS = Object.freeze(QUERIES.map((query) => query.id));
