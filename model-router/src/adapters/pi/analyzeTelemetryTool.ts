import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatRouterTelemetryAnalysis, RouterTelemetryAnalysisClient } from "../../telemetry/AnalysisClient.ts";
import type { RouterTelemetryAnalysisFocus, RouterTelemetryAnalysisWindow } from "../../telemetry/AnalysisTypes.ts";

const Params = Type.Object({
	window: Type.Optional(StringEnum(["1h", "6h", "24h", "3d", "7d"] as const, { description: "Analysis window; defaults to 24h and is capped at seven days." })),
	focus: Type.Optional(StringEnum(["reliability", "quality", "cost", "latency", "rollout", "all"] as const, { description: "Metadata-only router telemetry area." })),
	comparePreviousPeriod: Type.Optional(Type.Boolean({ description: "Compare with the immediately preceding period when retention permits." })),
	maxTraceExamples: Type.Optional(Type.Number({ minimum: 0, maximum: 25, description: "Maximum bounded Jaeger trace summaries." })),
});

function endpoint(name: string, fallback: string): URL {
	try {
		const value = new URL(process.env[name] ?? fallback);
		if (value.protocol !== "http:" && value.protocol !== "https:") throw new Error("unsupported protocol");
		value.username = "";
		value.password = "";
		return value;
	} catch {
		return new URL(fallback);
	}
}

export function registerAnalyzeModelRouterTelemetryTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "analyze_model_router_telemetry",
		label: "Analyze Model Router Telemetry",
		description: "Read a bounded, metadata-only quality/reliability/cost/latency/rollout snapshot from configured Prometheus and Jaeger endpoints. Uses a fixed query catalog and accepts no URLs or PromQL.",
		promptSnippet: "Analyze metadata-only Pi model-router telemetry",
		promptGuidelines: [
			"Use analyze_model_router_telemetry before changing routing policy, rollout gates, or candidate constraints.",
			"Treat unavailable or low-volume telemetry as insufficient evidence; do not infer success from missing metrics.",
			"Never request prompts, outputs, tool payloads, paths, raw logs, URLs, or PromQL through this tool.",
		],
		parameters: Params,
		async execute(_toolCallId, params: any, _signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Querying bounded model-router telemetry..." }], details: { status: "querying" } });
			const client = new RouterTelemetryAnalysisClient({
				prometheusUrl: endpoint("PI_MODEL_ROUTER_PROMETHEUS_URL", "http://127.0.0.1:9090"),
				jaegerUrl: endpoint("PI_MODEL_ROUTER_JAEGER_URL", "http://127.0.0.1:16686"),
			});
			const snapshot = await client.analyze({
				window: params.window as RouterTelemetryAnalysisWindow | undefined,
				focus: params.focus as RouterTelemetryAnalysisFocus | undefined,
				comparePreviousPeriod: params.comparePreviousPeriod,
				maxTraceExamples: params.maxTraceExamples,
			});
			return { content: [{ type: "text", text: formatRouterTelemetryAnalysis(snapshot) }], details: snapshot };
		},
	});
}
