import type {
	RouterRolloutReadiness,
	RouterTelemetryAnalysisConfig,
	RouterTelemetryAnalysisFocus,
	RouterTelemetryAnalysisRequest,
	RouterTelemetryAnalysisSnapshot,
	RouterTelemetryAnalysisWindow,
	RouterTelemetryBackendAvailability,
	RouterTelemetryMetricResult,
	RouterTelemetrySloFinding,
	RouterTelemetryTraceExample,
} from "./AnalysisTypes.ts";
import { ROUTER_SPAN_ATTRIBUTE_KEYS } from "./Privacy.ts";

const WINDOWS: Record<RouterTelemetryAnalysisWindow, number> = {
	"1h": 3_600, "6h": 21_600, "24h": 86_400, "3d": 259_200, "7d": 604_800,
};
const WINDOW_SET = new Set(Object.keys(WINDOWS));
const FOCUS_SET = new Set(["reliability", "quality", "cost", "latency", "rollout", "all"]);
const DEFAULT_SERVICE = "pi-model-router";
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_SLO_SAMPLES = 10;
const TRACE_PREFIX = "pi.model_router.";
const SAFE_TAGS: ReadonlySet<string> = new Set(ROUTER_SPAN_ATTRIBUTE_KEYS);

type SpecificFocus = Exclude<RouterTelemetryAnalysisFocus, "all">;
interface QueryDefinition {
	id: string;
	focus: SpecificFocus;
	unit: string;
	valuePromql: string;
	/** A fixed count query. A zero result makes a ratio/average/quantile unavailable. */
	samplePromql?: string;
	kind: "count" | "sampled" | "ratio";
}

const OBSERVATIONS = "sum(increase(pi_model_router_observations_total[$WINDOW]))";
const DECISIONS = "sum(increase(pi_model_router_decisions_total[$WINDOW]))";
const QUALITY_COUNT = "sum(increase(pi_model_router_quality_count[$WINDOW]))";
const LATENCY_COUNT = "sum(increase(pi_model_router_latency_milliseconds_count[$WINDOW]))";
const COST_COUNT = "sum(increase(pi_model_router_cost_USD_count[$WINDOW]))";

/** Private fixed catalog: callers can select IDs only indirectly through focus. */
const QUERIES: readonly QueryDefinition[] = Object.freeze([
	{ id: "completed_total", focus: "reliability", unit: "observations", kind: "count", valuePromql: OBSERVATIONS },
	{ id: "success_rate", focus: "reliability", unit: "ratio", kind: "ratio", valuePromql: "sum(increase(pi_model_router_observations_total{outcome=\"succeeded\"}[$WINDOW]))", samplePromql: OBSERVATIONS },
	{ id: "attributable_failure_rate", focus: "reliability", unit: "ratio", kind: "ratio", valuePromql: "sum(increase(pi_model_router_observations_total{failure_domain=~\"model|provider\",outcome!=\"succeeded\"}[$WINDOW]))", samplePromql: OBSERVATIONS },
	{ id: "quality_average", focus: "quality", unit: "score", kind: "ratio", valuePromql: "sum(increase(pi_model_router_quality_sum[$WINDOW]))", samplePromql: QUALITY_COUNT },
	{ id: "quality_coverage", focus: "quality", unit: "ratio", kind: "ratio", valuePromql: QUALITY_COUNT, samplePromql: OBSERVATIONS },
	{ id: "judge_label_rate", focus: "quality", unit: "ratio", kind: "ratio", valuePromql: "sum(increase(pi_model_router_judge_evaluations_total{outcome=\"labelled\"}[$WINDOW]))", samplePromql: "sum(increase(pi_model_router_judge_evaluations_total[$WINDOW]))" },
	{ id: "cost_total", focus: "cost", unit: "USD", kind: "sampled", valuePromql: "sum(increase(pi_model_router_cost_USD_sum[$WINDOW]))", samplePromql: COST_COUNT },
	{ id: "cost_per_success", focus: "cost", unit: "USD/observation", kind: "ratio", valuePromql: "sum(increase(pi_model_router_cost_USD_sum[$WINDOW]))", samplePromql: "sum(increase(pi_model_router_observations_total{outcome=\"succeeded\"}[$WINDOW]))" },
	{ id: "cost_coverage", focus: "cost", unit: "ratio", kind: "ratio", valuePromql: COST_COUNT, samplePromql: OBSERVATIONS },
	{ id: "latency_p95", focus: "latency", unit: "milliseconds", kind: "sampled", valuePromql: "histogram_quantile(0.95, sum by (le) (rate(pi_model_router_latency_milliseconds_bucket[$WINDOW])))", samplePromql: LATENCY_COUNT },
	{ id: "first_token_p95", focus: "latency", unit: "milliseconds", kind: "sampled", valuePromql: "histogram_quantile(0.95, sum by (le) (rate(pi_model_router_first_token_milliseconds_bucket[$WINDOW])))", samplePromql: "sum(increase(pi_model_router_first_token_milliseconds_count[$WINDOW]))" },
	{ id: "latency_coverage", focus: "latency", unit: "ratio", kind: "ratio", valuePromql: LATENCY_COUNT, samplePromql: OBSERVATIONS },
	{ id: "decisions_total", focus: "rollout", unit: "decisions", kind: "count", valuePromql: DECISIONS },
	{ id: "treatment_rate", focus: "rollout", unit: "ratio", kind: "ratio", valuePromql: "sum(increase(pi_model_router_decisions_total{arm=\"treatment\"}[$WINDOW]))", samplePromql: DECISIONS },
	{ id: "fallback_rate", focus: "rollout", unit: "ratio", kind: "ratio", valuePromql: "sum(increase(pi_model_router_fallbacks_total[$WINDOW]))", samplePromql: DECISIONS },
	{ id: "outcome_coverage", focus: "rollout", unit: "ratio", kind: "ratio", valuePromql: "sum(increase(pi_model_router_observations_total{outcome!=\"unknown\"}[$WINDOW]))", samplePromql: OBSERVATIONS },
	{ id: "rollout_transitions_total", focus: "rollout", unit: "transitions", kind: "count", valuePromql: "sum(increase(pi_model_router_rollout_transitions_total[$WINDOW]))" },
]);

function queryUrl(base: URL, path: string): URL {
	return new URL(path.replace(/^\//, ""), `${base.toString().replace(/\/+$/, "")}/`);
}

async function fetchJson(url: URL, headers: Readonly<Record<string, string>>, timeoutMs: number): Promise<any> {
	const response = await fetch(url, { method: "GET", headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`Telemetry backend returned HTTP ${response.status}`);
	return response.json();
}

function prometheusNumber(payload: any): number | undefined {
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

function normalizeRequest(request: RouterTelemetryAnalysisRequest): Required<RouterTelemetryAnalysisRequest> {
	const window = WINDOW_SET.has(String(request.window)) ? request.window! : "24h";
	const focus = FOCUS_SET.has(String(request.focus)) ? request.focus! : "all";
	const maxTraceExamples = Math.max(0, Math.min(25, Math.floor(Number(request.maxTraceExamples ?? 10) || 0)));
	return { window, focus, comparePreviousPeriod: request.comparePreviousPeriod ?? true, maxTraceExamples };
}

function tag(span: any, key: string): string | undefined {
	if (!SAFE_TAGS.has(key) || !Array.isArray(span?.tags)) return undefined;
	const candidate = span.tags.find((item: any) => item?.key === key);
	const value = candidate?.value;
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value).slice(0, 80) : undefined;
}

function summarizeTrace(trace: any, jaegerUrl: URL): RouterTelemetryTraceExample | undefined {
	const traceId = typeof trace?.traceID === "string" && /^[a-fA-F0-9]{16,32}$/.test(trace.traceID) ? trace.traceID : undefined;
	if (!traceId || !Array.isArray(trace.spans)) return undefined;
	const spans = trace.spans.filter((span: any) => typeof span?.operationName === "string" && span.operationName.startsWith(TRACE_PREFIX));
	if (!spans.length) return undefined;
	const starts = spans.map((span: any) => Number(span.startTime)).filter(Number.isFinite);
	const ends = spans.map((span: any) => Number(span.startTime) + Number(span.duration)).filter(Number.isFinite);
	return {
		traceId,
		durationMs: starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) / 1_000 : 0,
		outcome: spans.map((span: any) => tag(span, "outcome")).find(Boolean),
		failureDomain: spans.map((span: any) => tag(span, "failure_domain")).find(Boolean),
		model: spans.map((span: any) => tag(span, "model")).find(Boolean),
		stage: spans.map((span: any) => tag(span, "stage")).find(Boolean),
		operations: [...new Set<string>(spans.map((span: any) => String(span.operationName).slice(0, 80)))].slice(0, 12),
		url: queryUrl(jaegerUrl, `/trace/${traceId}`).toString(),
	};
}

function sloFindings(metrics: RouterTelemetryMetricResult[]): RouterTelemetrySloFinding[] {
	const findings: RouterTelemetrySloFinding[] = [];
	const metric = (id: string) => metrics.find((item) => item.id === id && item.available && item.sampleCount >= MIN_SLO_SAMPLES);
	const success = metric("success_rate");
	if (success?.value !== undefined && success.value < 0.95) findings.push({ id: success.id, severity: success.value < 0.8 ? "critical" : "warning", message: "End-to-end success is below 95%.", sampleCount: success.sampleCount });
	const attributable = metric("attributable_failure_rate");
	if (attributable?.value !== undefined && attributable.value > 0.05) findings.push({ id: attributable.id, severity: attributable.value > 0.1 ? "critical" : "warning", message: "Model/provider-attributable failures exceed 5%.", sampleCount: attributable.sampleCount });
	const cost = metric("cost_per_success");
	if (cost?.value !== undefined && cost.previousValue !== undefined && cost.previousValue > 0 && cost.value > cost.previousValue * 1.2) findings.push({ id: cost.id, severity: "warning", message: "Cost per successful observation regressed by more than 20%.", sampleCount: cost.sampleCount });
	return findings;
}

function readiness(metrics: RouterTelemetryMetricResult[]): RouterRolloutReadiness {
	const get = (id: string) => metrics.find((item) => item.id === id && item.available);
	const completed = get("completed_total")?.value ?? 0;
	const coverageCount = (id: string): number => {
		const item = get(id);
		return item?.value === undefined ? 0 : Math.round(item.value * item.sampleCount);
	};
	const result: RouterRolloutReadiness = {
		ready: false,
		completedCount: Math.round(completed),
		qualityLabelCount: coverageCount("quality_coverage"),
		outcomeCoverageCount: coverageCount("outcome_coverage"),
		costCoverageCount: coverageCount("cost_coverage"),
		latencyCoverageCount: coverageCount("latency_coverage"),
		reasons: [],
	};
	if (result.completedCount < 100) result.reasons.push("completed_samples");
	if (result.qualityLabelCount < 10) result.reasons.push("quality_labels");
	if (result.completedCount === 0 || result.outcomeCoverageCount < result.completedCount) result.reasons.push("outcome_completeness");
	if (result.completedCount === 0 || result.costCoverageCount / result.completedCount < 0.9) result.reasons.push("cost_completeness");
	if (result.completedCount === 0 || result.latencyCoverageCount / result.completedCount < 0.9) result.reasons.push("latency_completeness");
	result.ready = result.reasons.length === 0;
	return result;
}

export class RouterTelemetryAnalysisClient {
	readonly #config: Required<Pick<RouterTelemetryAnalysisConfig, "serviceName" | "queryHeaders" | "queryTimeoutMs">> & RouterTelemetryAnalysisConfig;

	constructor(config: RouterTelemetryAnalysisConfig) {
		this.#config = { ...config, serviceName: config.serviceName ?? DEFAULT_SERVICE, queryHeaders: config.queryHeaders ?? Object.freeze({}), queryTimeoutMs: config.queryTimeoutMs ?? DEFAULT_TIMEOUT_MS };
	}

	async analyze(rawRequest: RouterTelemetryAnalysisRequest = {}): Promise<RouterTelemetryAnalysisSnapshot> {
		const request = normalizeRequest(rawRequest);
		const now = Date.now();
		const seconds = WINDOWS[request.window];
		const rolloutPrerequisites = new Set(["completed_total", "quality_coverage", "cost_coverage", "latency_coverage"]);
		const definitions = QUERIES.filter((item) => request.focus === "all" || item.focus === request.focus || (request.focus === "rollout" && rolloutPrerequisites.has(item.id)));
		let prometheusAvailable = false;
		const query = async (promql: string, at: number): Promise<number | undefined> => {
			const url = queryUrl(this.#config.prometheusUrl, "/api/v1/query");
			url.searchParams.set("query", promql.replaceAll("$WINDOW", request.window));
			url.searchParams.set("time", String(at));
			const payload = await fetchJson(url, this.#config.queryHeaders, this.#config.queryTimeoutMs);
			prometheusAvailable = true;
			return prometheusNumber(payload);
		};
		const metrics = await Promise.all(definitions.map(async (definition): Promise<RouterTelemetryMetricResult> => {
			const evaluate = async (at: number): Promise<{ value?: number; samples: number; error?: RouterTelemetryMetricResult["error"] }> => {
				const numerator = await query(definition.valuePromql, at);
				if (definition.kind === "count") return numerator === undefined ? { samples: 0, error: "unavailable" } : { value: numerator, samples: numerator };
				const denominator = await query(definition.samplePromql!, at);
				if (denominator === undefined || numerator === undefined) return { samples: denominator ?? 0, error: "unavailable" };
				if (denominator <= 0) return { samples: 0, error: "zero_denominator" };
				return { value: definition.kind === "ratio" ? numerator / denominator : numerator, samples: denominator };
			};
			try {
				const current = await evaluate(now / 1_000);
				let previous: Awaited<ReturnType<typeof evaluate>> | undefined;
				if (request.comparePreviousPeriod && request.window !== "7d") previous = await evaluate(now / 1_000 - seconds);
				return { id: definition.id, focus: definition.focus, unit: definition.unit, available: current.value !== undefined, value: current.value, previousValue: previous?.value, delta: current.value !== undefined && previous?.value !== undefined ? current.value - previous.value : undefined, sampleCount: current.samples, previousSampleCount: previous?.samples, error: current.error };
			} catch {
				return { id: definition.id, focus: definition.focus, unit: definition.unit, available: false, sampleCount: 0, error: "unavailable" };
			}
		}));

		let jaegerAvailable = false;
		let traceExamples: RouterTelemetryTraceExample[] = [];
		if (request.maxTraceExamples > 0) {
			try {
				const url = queryUrl(this.#config.jaegerUrl, "/api/traces");
				url.searchParams.set("service", this.#config.serviceName);
				url.searchParams.set("start", String(Math.floor((now - seconds * 1_000) * 1_000)));
				url.searchParams.set("end", String(Math.floor(now * 1_000)));
				url.searchParams.set("limit", String(request.maxTraceExamples));
				const payload = await fetchJson(url, this.#config.queryHeaders, this.#config.queryTimeoutMs);
				jaegerAvailable = true;
				traceExamples = (Array.isArray(payload?.data) ? payload.data : []).map((item: any) => summarizeTrace(item, this.#config.jaegerUrl)).filter((item: RouterTelemetryTraceExample | undefined): item is RouterTelemetryTraceExample => Boolean(item)).sort((a: RouterTelemetryTraceExample, b: RouterTelemetryTraceExample) => (b.outcome === "succeeded" ? 0 : 1) - (a.outcome === "succeeded" ? 0 : 1) || b.durationMs - a.durationMs).slice(0, request.maxTraceExamples);
			} catch { /* bounded unavailable result */ }
		}
		const rolloutReadiness = readiness(metrics);
		const warnings: string[] = [];
		if (!prometheusAvailable) warnings.push("Prometheus was unavailable; metric analysis is incomplete.");
		if (!jaegerAvailable && request.maxTraceExamples > 0) warnings.push("Jaeger was unavailable; trace examples are omitted.");
		if (request.comparePreviousPeriod && request.window === "7d") warnings.push("Previous-period comparison is unavailable for the seven-day retention window.");
		const completedMetric = metrics.find((item) => item.id === "completed_total" && item.available);
		if (completedMetric && completedMetric.sampleCount < MIN_SLO_SAMPLES) warnings.push(`Insufficient data for SLO findings (${completedMetric.sampleCount}/${MIN_SLO_SAMPLES} completed observations); remain in shadow.`);
		if ((request.focus === "all" || request.focus === "rollout") && !rolloutReadiness.ready) warnings.push(`Rollout telemetry gates are incomplete: ${rolloutReadiness.reasons.join(", ") || "coverage unavailable"}.`);
		return { generatedAt: now, window: request.window, focus: request.focus, comparePreviousPeriod: request.comparePreviousPeriod && request.window !== "7d", metrics, traceExamples, violations: sloFindings(metrics), rolloutReadiness, warnings, prometheusAvailable, jaegerAvailable };
	}

	async probe(timeoutMs = 2_000): Promise<RouterTelemetryBackendAvailability> {
		const [prometheus, jaeger] = await Promise.all([
			fetchJson(queryUrl(this.#config.prometheusUrl, "/api/v1/status/buildinfo"), this.#config.queryHeaders, timeoutMs).then(() => true, () => false),
			fetchJson(queryUrl(this.#config.jaegerUrl, "/api/services"), this.#config.queryHeaders, timeoutMs).then(() => true, () => false),
		]);
		return { prometheus, jaeger };
	}
}

function formatValue(value: number | undefined, unit: string): string {
	if (value === undefined) return "unavailable";
	if (unit === "ratio" || unit === "score") return `${(value * 100).toFixed(2)}%`;
	if (unit.startsWith("USD")) return `$${value.toFixed(6)}`;
	if (unit === "milliseconds") return `${value.toFixed(1)}ms`;
	return `${Number.isInteger(value) ? value : value.toFixed(3)} ${unit}`;
}

export function formatRouterTelemetryAnalysis(snapshot: RouterTelemetryAnalysisSnapshot, maxChars = 16_000): string {
	const lines = ["# Pi Model Router Telemetry Analysis", `Window: ${snapshot.window}; focus: ${snapshot.focus}; generated: ${new Date(snapshot.generatedAt).toISOString()}`, `Backends: Prometheus=${snapshot.prometheusAvailable ? "available" : "unavailable"}, Jaeger=${snapshot.jaegerAvailable ? "available" : "unavailable"}`, "", "## Metrics"];
	for (const item of snapshot.metrics) lines.push(`- ${item.id}: ${formatValue(item.value, item.unit)}; samples=${item.sampleCount}${item.previousValue === undefined ? "" : `; previous=${formatValue(item.previousValue, item.unit)}; previous_samples=${item.previousSampleCount ?? 0}; delta=${formatValue(item.delta, item.unit)}`}`);
	lines.push("", "## SLO findings");
	if (!snapshot.violations.length) lines.push(snapshot.rolloutReadiness.completedCount < MIN_SLO_SAMPLES ? `- Insufficient data (${snapshot.rolloutReadiness.completedCount}/${MIN_SLO_SAMPLES} completed observations).` : "- No SLO violations detected in eligible data.");
	else for (const item of snapshot.violations) lines.push(`- ${item.severity.toUpperCase()} ${item.id} (n=${item.sampleCount}): ${item.message}`);
	lines.push("", "## Rollout telemetry readiness", `- ready=${snapshot.rolloutReadiness.ready}; completed=${snapshot.rolloutReadiness.completedCount}; quality_labels=${snapshot.rolloutReadiness.qualityLabelCount}; outcome_coverage=${snapshot.rolloutReadiness.outcomeCoverageCount}; cost_coverage=${snapshot.rolloutReadiness.costCoverageCount}; latency_coverage=${snapshot.rolloutReadiness.latencyCoverageCount}`, `- reasons=${snapshot.rolloutReadiness.reasons.join(", ") || "none"}`, "", "## Trace examples");
	if (!snapshot.traceExamples.length) lines.push("- None available.");
	else for (const trace of snapshot.traceExamples) lines.push(`- ${trace.traceId}: ${trace.durationMs.toFixed(1)}ms; outcome=${trace.outcome ?? "unknown"}; failure_domain=${trace.failureDomain ?? "unknown"}; model=${trace.model ?? "unknown"}; operations=${trace.operations.join(", ")}; ${trace.url}`);
	if (snapshot.warnings.length) { lines.push("", "## Data-quality warnings"); for (const warning of snapshot.warnings) lines.push(`- ${warning}`); }
	const text = lines.join("\n");
	return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 48))}\n[analysis output truncated to ${maxChars} characters]`;
}

export const ROUTER_TELEMETRY_QUERY_IDS = Object.freeze(QUERIES.map((item) => item.id));
export const ROUTER_TELEMETRY_MIN_SLO_SAMPLES = MIN_SLO_SAMPLES;
export { RouterTelemetryAnalysisClient as ModelRouterTelemetryAnalysisClient };
export const MODEL_ROUTER_TELEMETRY_QUERY_IDS = ROUTER_TELEMETRY_QUERY_IDS;
