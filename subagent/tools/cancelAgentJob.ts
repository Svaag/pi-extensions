import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type BatchManagerGetter, jobText } from "./batchCommon.ts";
import { textResult } from "./common.ts";

const CancelAgentJobParams = Type.Object({
	jobId: Type.String({ description: "Batch job id." }),
	reason: Type.Optional(Type.String({ description: "Cancellation reason." })),
});

export function registerCancelAgentJobTool(pi: ExtensionAPI, getBatchManager: BatchManagerGetter): void {
	pi.registerTool({
		name: "cancel_agent_job",
		label: "Cancel Agent Job",
		description: "Cancel a batch fan-out job and interrupt running workers.",
		promptSnippet: "Cancel a batch subagent job",
		parameters: CancelAgentJobParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const job = await getBatchManager(ctx).cancelJob(params.jobId, params.reason ?? "cancelled by parent");
			return textResult(jobText(job, true), job);
		},
		renderCall(args: any, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("cancel_agent_job "))}${theme.fg("accent", args.jobId ?? "...")}`, 0, 0);
		},
	});
}
