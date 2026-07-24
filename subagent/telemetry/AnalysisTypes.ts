export type TelemetryAnalysisWindow = "1h" | "6h" | "24h" | "3d" | "7d";
export type TelemetryAnalysisFocus = "reliability" | "cost" | "ux" | "routing" | "all";

export interface TelemetryAnalysisRequest {
	window?: TelemetryAnalysisWindow;
	focus?: TelemetryAnalysisFocus;
	comparePreviousPeriod?: boolean;
	maxTraceExamples?: number;
}

export interface TelemetryMetricResult {
	id: string;
	focus: Exclude<TelemetryAnalysisFocus, "all">;
	value?: number;
	previousValue?: number;
	delta?: number;
	unit: string;
	available: boolean;
	sampleCount: number;
	previousSampleCount?: number;
	error?: "unavailable" | "invalid_response" | "zero_denominator";
}

export interface TelemetryTraceExample {
	traceId: string;
	durationMs: number;
	outcome?: string;
	errorCategory?: string;
	operations: string[];
	url: string;
}

export interface TelemetrySloViolation {
	id: string;
	severity: "warning" | "critical";
	message: string;
	sampleCount: number;
}

export interface TelemetryAnalysisSnapshot {
	generatedAt: number;
	window: TelemetryAnalysisWindow;
	focus: TelemetryAnalysisFocus;
	comparePreviousPeriod: boolean;
	metrics: TelemetryMetricResult[];
	traceExamples: TelemetryTraceExample[];
	violations: TelemetrySloViolation[];
	warnings: string[];
	prometheusAvailable: boolean;
	jaegerAvailable: boolean;
}

export interface TelemetryBackendAvailability {
	prometheus: boolean;
	jaeger: boolean;
}
