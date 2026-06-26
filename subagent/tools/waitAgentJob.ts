import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type BatchManagerGetter, jobText } from "./batchCommon.ts";
import { textResult } from "./common.ts";

const WaitAgentJobParams = Type.Object({
	jobId: Type.String({ description: "Batch job id." }),
	timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout in milliseconds." })),
});

export function registerWaitAgentJobTool(pi: ExtensionAPI, getBatchManager: BatchManagerGetter): void {
	pi.registerTool({
		name: "wait_agent_job",
		label: "Wait Agent Job",
		description: "Wait for a batch fan-out job to complete or timeout.",
		promptSnippet: "Wait for a batch subagent job",
		parameters: WaitAgentJobParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const job = await getBatchManager(ctx).waitJob(params.jobId, params.timeoutMs ?? 60_000);
			return textResult(jobText(job, true), job);
		},
		renderCall(args: any, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("wait_agent_job "))}${theme.fg("accent", args.jobId ?? "...")}`, 0, 0);
		},
	});
}
