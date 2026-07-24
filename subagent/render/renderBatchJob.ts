import { Text } from "@earendil-works/pi-tui";
import type { BatchJobSummary } from "../core/BatchTypes.ts";
import { jobText } from "../tools/batchCommon.ts";

export function renderBatchJob(job: BatchJobSummary, theme: any, expanded = false) {
	const color = job.status === "succeeded" ? "success" : job.status === "failed" ? "error" : job.status === "cancelled" ? "warning" : "accent";
	const text = jobText(job, expanded);
	return new Text(theme.fg(color, text.split("\n")[0]) + (text.includes("\n") ? `\n${text.split("\n").slice(1).join("\n")}` : ""), 0, 0);
}
