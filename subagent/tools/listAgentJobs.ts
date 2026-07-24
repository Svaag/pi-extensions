import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type BatchManagerGetter, formatJobSummary } from "./batchCommon.ts";
import { textResult } from "./common.ts";

const ListAgentJobsParams = Type.Object({
	includeCompleted: Type.Optional(Type.Boolean({ description: "Include completed/failed/cancelled jobs." })),
	jobId: Type.Optional(Type.String({ description: "Filter to one job id." })),
});

export function registerListAgentJobsTool(pi: ExtensionAPI, getBatchManager: BatchManagerGetter): void {
	pi.registerTool({
		name: "list_agent_jobs",
		label: "List Agent Jobs",
		description: "List batch fan-out subagent jobs and progress counts.",
		promptSnippet: "List batch subagent jobs",
		parameters: ListAgentJobsParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const jobs = getBatchManager(ctx).listJobs({ includeCompleted: params.includeCompleted, jobId: params.jobId });
			return textResult(jobs.length ? jobs.map(formatJobSummary).join("\n") : "No batch jobs.", { jobs });
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("list_agent_jobs")), 0, 0);
		},
	});
}
