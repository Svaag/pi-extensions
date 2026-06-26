import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { BatchJobSummary } from "../core/BatchTypes.ts";

export type BatchManagerGetter = (ctx: any) => any;

export const BatchCommonParams = {
	name: Type.Optional(Type.String({ description: "Optional human-readable job name." })),
	promptTemplate: Type.String({ description: "Prompt template. Use {{column}} or {column} placeholders from each input row." }),
	idColumn: Type.Optional(Type.String({ description: "Column/field to use as stable item id. Defaults to row number." })),
	maxConcurrency: Type.Optional(Type.Number({ description: "Maximum workers to run for this job. Defaults to 4, capped at 16." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for workers." })),
	model: Type.Optional(Type.String({ description: "Optional model override for worker subagents." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Per-worker timeout in milliseconds." })),
	writeMode: Type.Optional(StringEnum(["read_only", "disjoint_scope", "git_worktree"] as const, { description: "Worker write policy. Defaults to read_only." })),
	allowedPaths: Type.Optional(Type.Array(Type.String(), { description: "Allowed paths for disjoint_scope workers." })),
	contextMode: Type.Optional(StringEnum(["fresh", "summary", "last_n_turns", "full_sanitized"] as const, { description: "Worker context mode. Defaults to fresh." })),
	resultPath: Type.Optional(Type.String({ description: "Default export path for this job's results." })),
};

export function formatJobSummary(job: BatchJobSummary): string {
	const c = job.counts;
	return `${job.name} (${job.jobId}): ${job.status} — ${c.succeeded}/${c.total} succeeded, ${c.running} running, ${c.queued} queued, ${c.failed} failed, ${c.cancelled} cancelled${c.lost ? `, ${c.lost} lost` : ""}`;
}

export function jobText(job: BatchJobSummary, includeItems = true): string {
	const lines = [formatJobSummary(job)];
	if (includeItems && job.items) {
		for (const item of job.items.slice(0, 20)) {
			lines.push(`- ${item.itemId}: ${item.status}${item.summary ? ` — ${item.summary}` : item.error ? ` — ${item.error}` : ""}`);
		}
		if (job.items.length > 20) lines.push(`... ${job.items.length - 20} more items`);
	}
	return lines.join("\n");
}
