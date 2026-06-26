import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type BatchManagerGetter } from "./batchCommon.ts";
import { textResult } from "./common.ts";

const ExportAgentJobResultsParams = Type.Object({
	jobId: Type.String({ description: "Batch job id." }),
	outputPath: Type.Optional(Type.String({ description: "Output path. Defaults to <job-name>-results.<format>." })),
	format: Type.Optional(StringEnum(["jsonl", "csv"] as const, { description: "Export format. Defaults to jsonl." })),
});

export function registerExportAgentJobResultsTool(pi: ExtensionAPI, getBatchManager: BatchManagerGetter): void {
	pi.registerTool({
		name: "export_agent_job_results",
		label: "Export Agent Job Results",
		description: "Export a batch fan-out job's results to JSONL or CSV.",
		promptSnippet: "Export batch subagent job results",
		parameters: ExportAgentJobResultsParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const result = await getBatchManager(ctx).exportResults(params.jobId, params.outputPath, params.format ?? "jsonl");
			return textResult(`Exported ${result.rows} rows to ${result.path}`, result);
		},
		renderCall(args: any, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("export_agent_job_results "))}${theme.fg("accent", args.jobId ?? "...")}`, 0, 0);
		},
	});
}
