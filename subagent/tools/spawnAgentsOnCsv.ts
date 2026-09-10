import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readRowsFromCsv } from "../core/BatchJobManager.ts";
import { BatchCommonParams, type BatchManagerGetter, jobText, resolveBatchModel } from "./batchCommon.ts";
import { textResult } from "./common.ts";

const SpawnAgentsOnCsvParams = Type.Object({
	csvPath: Type.Optional(Type.String({ description: "CSV file path." })),
	csvText: Type.Optional(Type.String({ description: "Inline CSV text." })),
	...BatchCommonParams,
	contextMode: Type.Optional(StringEnum(["fresh", "summary"] as const, { description: "Worker context mode for batch MVP. Defaults to fresh." })),
});

export function registerSpawnAgentsOnCsvTool(pi: ExtensionAPI, getBatchManager: BatchManagerGetter): void {
	pi.registerTool({
		name: "spawn_agents_on_csv",
		label: "Spawn Agents on CSV",
		description: "Fan out one subagent worker per CSV row with max concurrency and persistent job progress.",
		promptSnippet: "Spawn many subagent workers from CSV rows",
		promptGuidelines: ["Use spawn_agents_on_csv for structured batch fan-out when each CSV row can be processed independently; prefer it over emitting multiple spawn_agent calls in one assistant response."],
		parameters: SpawnAgentsOnCsvParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			if (!params.csvPath && !params.csvText) throw new Error("spawn_agents_on_csv requires csvPath or csvText.");
			if (params.csvPath && params.csvText) throw new Error("Provide only one of csvPath or csvText.");
			const { rows, sourcePath } = await readRowsFromCsv({ path: params.csvPath, text: params.csvText }, ctx.cwd, params.idColumn);
			const resolved = resolveBatchModel(ctx, params);
			const job = getBatchManager(ctx).createJob({
				name: params.name,
				sourceType: "csv",
				sourcePath,
				rows,
				promptTemplate: params.promptTemplate,
				idColumn: params.idColumn,
				maxConcurrency: params.maxConcurrency,
				cwd: params.cwd,
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				timeoutMs: params.timeoutMs,
				writeMode: params.writeMode,
				allowedPaths: params.allowedPaths,
				contextMode: params.contextMode,
				resultPath: params.resultPath,
			});
			return textResult(jobText(job, false), job);
		},
		renderCall(args: any, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("spawn_agents_on_csv "))}${theme.fg("accent", args.csvPath ?? "inline csv")}`, 0, 0);
		},
	});
}
