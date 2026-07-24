export type RouterTelemetryAnalysisWindow = "1h" | "6h" | "24h" | "3d" | "7d";
export type RouterTelemetryAnalysisFocus = "reliability" | "quality" | "cost" | "latency" | "rollout" | "all";

/** Deliberately excludes URLs, PromQL, service names, and arbitrary tags. */
export interface RouterTelemetryAnalysisRequest {
	window?: RouterTelemetryAnalysisWindow;
	focus?: RouterTelemetryAnalysisFocus;
	comparePreviousPeriod?: boolean;
	maxTraceExamples?: number;
}

export interface RouterTelemetryAnalysisConfig {
	prometheusUrl: URL;
	jaegerUrl: URL;
	serviceName?: string;
	queryHeaders?: Readonly<Record<string, string>>;
	queryTimeoutMs?: number;
}

export interface RouterTelemetryMetricResult {
	id: string;
	focus: Exclude<RouterTelemetryAnalysisFocus, "all">;
	unit: string;
	available: boolean;
	value?: number;
	previousValue?: number;
	delta?: number;
	/** Eligible denominator for ratios; observation count for sampled metrics. */
	sampleCount: number;
	previousSampleCount?: number;
	error?: "unavailable" | "invalid_response" | "zero_denominator";
}

export interface RouterTelemetryTraceExample {
	traceId: string;
	durationMs: number;
	outcome?: string;
	failureDomain?: string;
	model?: string;
	stage?: string;
	operations: string[];
	url: string;
}

export interface RouterTelemetrySloFinding {
	id: string;
	severity: "warning" | "critical";
	message: string;
	sampleCount: number;
}

export interface RouterRolloutReadiness {
	ready: boolean;
	completedCount: number;
	qualityLabelCount: number;
	outcomeCoverageCount: number;
	costCoverageCount: number;
	latencyCoverageCount: number;
	reasons: string[];
}

export interface RouterTelemetryAnalysisSnapshot {
	generatedAt: number;
	window: RouterTelemetryAnalysisWindow;
	focus: RouterTelemetryAnalysisFocus;
	comparePreviousPeriod: boolean;
	metrics: RouterTelemetryMetricResult[];
	traceExamples: RouterTelemetryTraceExample[];
	violations: RouterTelemetrySloFinding[];
	rolloutReadiness: RouterRolloutReadiness;
	warnings: string[];
	prometheusAvailable: boolean;
	jaegerAvailable: boolean;
}

export interface RouterTelemetryBackendAvailability {
	prometheus: boolean;
	jaeger: boolean;
}
