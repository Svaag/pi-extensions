import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readRowsFromJsonl } from "../core/BatchJobManager.ts";
import { BatchCommonParams, type BatchManagerGetter, jobText, resolveBatchRouting } from "./batchCommon.ts";
import { textResult } from "./common.ts";

const SpawnAgentsOnJsonlParams = Type.Object({
	jsonlPath: Type.Optional(Type.String({ description: "JSONL file path." })),
	jsonlText: Type.Optional(Type.String({ description: "Inline JSONL text." })),
	idField: Type.Optional(Type.String({ description: "JSON object field to use as stable item id. Defaults to id, then row number." })),
	...BatchCommonParams,
	contextMode: Type.Optional(StringEnum(["fresh", "summary"] as const, { description: "Worker context mode for batch MVP. Defaults to fresh." })),
});

export function registerSpawnAgentsOnJsonlTool(pi: ExtensionAPI, getBatchManager: BatchManagerGetter): void {
	pi.registerTool({
		name: "spawn_agents_on_jsonl",
		label: "Spawn Agents on JSONL",
		description: "Fan out one subagent worker per JSONL object with max concurrency and persistent job progress.",
		promptSnippet: "Spawn many subagent workers from JSONL objects",
		promptGuidelines: ["Use spawn_agents_on_jsonl for structured batch fan-out when each JSONL object can be processed independently."],
		parameters: SpawnAgentsOnJsonlParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			if (!params.jsonlPath && !params.jsonlText) throw new Error("spawn_agents_on_jsonl requires jsonlPath or jsonlText.");
			if (params.jsonlPath && params.jsonlText) throw new Error("Provide only one of jsonlPath or jsonlText.");
			if (params.writeMode && params.writeMode !== "read_only" && ctx.hasUI) {
				const ok = await ctx.ui.confirm("Spawn write-capable JSONL workers?", `Rows will run with writeMode=${params.writeMode}. Continue?`);
				if (!ok) throw new Error("Write-capable batch workers were not approved.");
			}
			const { rows, sourcePath } = await readRowsFromJsonl({ path: params.jsonlPath, text: params.jsonlText }, ctx.cwd, params.idField ?? params.idColumn);
			const routed = await resolveBatchRouting(ctx, params, "jsonl", rows);
			const job = getBatchManager(ctx).createJob({
				name: params.name,
				sourceType: "jsonl",
				sourcePath,
				rows,
				promptTemplate: params.promptTemplate,
				idColumn: params.idField ?? params.idColumn,
				maxConcurrency: params.maxConcurrency,
				cwd: params.cwd,
				model: routed.model,
				thinkingLevel: routed.thinkingLevel,
				timeoutMs: params.timeoutMs,
				routingMode: params.routingMode,
				routingProfile: params.routingProfile,
				routingDecision: routed.decision,
				writeMode: params.writeMode,
				allowedPaths: params.allowedPaths,
				contextMode: params.contextMode,
				resultPath: params.resultPath,
			});
			return textResult(jobText(job, false), job);
		},
		renderCall(args: any, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("spawn_agents_on_jsonl "))}${theme.fg("accent", args.jsonlPath ?? "inline jsonl")}`, 0, 0);
		},
	});
}
