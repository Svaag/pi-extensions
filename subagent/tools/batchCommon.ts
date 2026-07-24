import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { BatchJobSummary } from "../core/BatchTypes.ts";
import { interpolatePrompt } from "../core/BatchJobManager.ts";
import type { BatchInputRow } from "../core/BatchTypes.ts";
import type { RoutingMode, RoutingObjective, ThinkingLevel, WriteMode } from "../core/AgentTypes.ts";
import { resolveRouting } from "./router.ts";

export type BatchManagerGetter = (ctx: any) => any;

export const BatchCommonParams = {
	name: Type.Optional(Type.String({ description: "Optional human-readable job name." })),
	promptTemplate: Type.String({ description: "Prompt template. Use {{column}} or {column} placeholders from each input row." }),
	idColumn: Type.Optional(Type.String({ description: "Column/field to use as stable item id. Defaults to row number." })),
	maxConcurrency: Type.Optional(Type.Number({ description: "Maximum workers to run for this job. Defaults to 4, capped at 16." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for workers." })),
	model: Type.Optional(Type.String({ description: "Optional model override for worker subagents. Defaults to the current main Pi model." })),
	thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Optional thinking level override for worker subagents." })),
	routingMode: Type.Optional(StringEnum(["auto", "off", "explain"] as const, { description: "Smart router mode. Defaults to off/inherit current main Pi model; set auto to route." })),
	routingProfile: Type.Optional(StringEnum(["balanced", "cost_first", "quality_first", "latency_first"] as const, { description: "Router objective for cost/reward/quality/latency tradeoff." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Per-worker timeout in milliseconds. Values below 300000ms are ignored and use the default 30-minute runtime." })),
	writeMode: Type.Optional(StringEnum(["read_only", "disjoint_scope", "git_worktree"] as const, { description: "Worker write policy. Defaults to read_only." })),
	allowedPaths: Type.Optional(Type.Array(Type.String(), { description: "Allowed paths for disjoint_scope workers." })),
	contextMode: Type.Optional(StringEnum(["fresh", "summary", "last_n_turns", "full_sanitized"] as const, { description: "Worker context mode. Defaults to fresh." })),
	resultPath: Type.Optional(Type.String({ description: "Default export path for this job's results." })),
};

export async function resolveBatchRouting(ctx: any, params: any, sourceType: "csv" | "jsonl", rows: BatchInputRow[]) {
	const samplePrompts = rows.slice(0, 3).map((row) => interpolatePrompt(params.promptTemplate, row.data));
	return resolveRouting(ctx, {
		taskName: params.name ?? `${sourceType}-batch`,
		prompt: samplePrompts.join("\n\n--- sample worker prompt ---\n\n") || params.promptTemplate,
		contextMode: params.contextMode,
		writeMode: (params.writeMode ?? "read_only") as WriteMode,
		batch: { sourceType, rowCount: rows.length, samplePrompts },
		explicitModel: params.model,
		explicitThinkingLevel: params.thinkingLevel as ThinkingLevel | undefined,
		routingMode: params.routingMode as RoutingMode | undefined,
		routingProfile: params.routingProfile as RoutingObjective | undefined,
	});
}

export function formatJobSummary(job: BatchJobSummary): string {
	const c = job.counts;
	return `${job.name} (${job.jobId}): ${job.status} — ${c.succeeded}/${c.total} succeeded, ${c.running} running, ${c.queued} queued, ${c.failed} failed, ${c.cancelled} cancelled${c.lost ? `, ${c.lost} lost` : ""}`;
}

export function jobText(job: BatchJobSummary, includeItems = true): string {
	const lines = [formatJobSummary(job)];
	const routing = job.routingDecision;
	const routeMeta = [
		job.model ? `model:${job.model}` : "",
		job.thinkingLevel ? `thinking:${job.thinkingLevel}` : "",
		routing ? `routed:${routing.intent}/${routing.complexityTier ?? "unknown"}/${routing.objective}${routing.applied ? "" : ` (${routing.reason})`}` : "",
	].filter(Boolean).join(" · ");
	if (routeMeta) lines.push(routeMeta);
	if (includeItems && routing) {
		lines.push(`routing: ${routing.reason}; selected=${routing.selectedModel ?? "(none)"}; thinking=${routing.selectedThinkingLevel ?? "(none)"}`);
		lines.push(`tier=${routing.complexityTier ?? "unknown"} score=${(routing.complexityScore ?? routing.complexity ?? 0).toFixed(2)} confidence=${(routing.confidence ?? 0).toFixed(2)}`);
		if (routing.classificationReason) lines.push(`reason: ${routing.classificationReason}`);
		if (routing.signals?.length) lines.push(`signals: ${routing.signals.join(", ")}`);
		for (const candidate of routing.candidates.slice(0, 3)) {
			lines.push(`  - ${candidate.model} score=${candidate.score.toFixed(3)} cost=$${candidate.estimatedCostUsd.toFixed(5)} quality=${candidate.quality.toFixed(2)}`);
		}
	}
	if (includeItems && job.items) {
		for (const item of job.items.slice(0, 20)) {
			lines.push(`- ${item.itemId}: ${item.status}${item.summary ? ` — ${item.summary}` : item.error ? ` — ${item.error}` : ""}`);
		}
		if (job.items.length > 20) lines.push(`... ${job.items.length - 20} more items`);
	}
	return lines.join("\n");
}
