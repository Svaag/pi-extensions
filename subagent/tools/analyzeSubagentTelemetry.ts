import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentTelemetryConfig } from "../telemetry/Config.ts";
import { formatTelemetryAnalysis, TelemetryAnalysisClient } from "../telemetry/AnalysisClient.ts";
import type { TelemetryAnalysisFocus, TelemetryAnalysisWindow } from "../telemetry/AnalysisTypes.ts";
import { textResult } from "./common.ts";

const AnalyzeSubagentTelemetryParams = Type.Object({
	window: Type.Optional(StringEnum(["1h", "6h", "24h", "3d", "7d"] as const, { description: "Analysis window. Defaults to 24h and is capped at the configured seven-day retention." })),
	focus: Type.Optional(StringEnum(["reliability", "cost", "ux", "routing", "all"] as const, { description: "Telemetry area to analyze, including shared model routing. Defaults to all." })),
	comparePreviousPeriod: Type.Optional(Type.Boolean({ description: "Compare to the immediately preceding period. Defaults to true; unavailable for 7d retention." })),
	maxTraceExamples: Type.Optional(Type.Number({ description: "Maximum bounded Jaeger trace summaries. Defaults to 10, capped at 25." })),
});

export function registerAnalyzeSubagentTelemetryTool(pi: ExtensionAPI, getConfig: () => SubagentTelemetryConfig): void {
	pi.registerTool({
		name: "analyze_subagent_telemetry",
		label: "Analyze Subagent Telemetry",
		description: "Read a bounded, metadata-only reliability/cost/UX snapshot from configured Prometheus and Jaeger endpoints. Uses a fixed query catalog and never accepts arbitrary URLs or PromQL.",
		promptSnippet: "Analyze metadata-only Pi subagent telemetry from fixed Prometheus and Jaeger queries",
		promptGuidelines: [
			"Use analyze_subagent_telemetry to inspect worker reliability, cost, UX, or routing before proposing Subagent or model-routing changes.",
			"Treat unavailable or low-volume telemetry as insufficient evidence; do not infer success from missing metrics.",
			"Do not request prompts, tool payloads, paths, or raw logs; this tool intentionally returns metadata only.",
		],
		parameters: AnalyzeSubagentTelemetryParams,
		async execute(_toolCallId, params: any, _signal, onUpdate) {
			onUpdate?.(textResult("Querying bounded subagent telemetry..."));
			const client = new TelemetryAnalysisClient(getConfig());
			const snapshot = await client.analyze({
				window: params.window as TelemetryAnalysisWindow | undefined,
				focus: params.focus as TelemetryAnalysisFocus | undefined,
				comparePreviousPeriod: params.comparePreviousPeriod,
				maxTraceExamples: params.maxTraceExamples,
			});
			return textResult(formatTelemetryAnalysis(snapshot), snapshot);
		},
	});
}
