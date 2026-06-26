import type { AgentRecord } from "./AgentTypes.ts";
import { truncateMiddle } from "./utils.ts";

export interface BuildPromptOptions {
	record: AgentRecord;
	agentDefinition?: string;
	inheritedContext?: string;
	maxTaskPromptChars: number;
}

export function buildChildSystemPrompt(options: BuildPromptOptions): string {
	const { record, agentDefinition, inheritedContext } = options;
	const policyLines = [
		"You are a Pi subagent spawned by a parent/root Pi agent.",
		"Work only on the delegated task. Be concise and report concrete findings, changed files, and validation steps.",
		`Canonical task path: ${record.taskPath}`,
		`Write mode: ${record.writeMode}`,
	];
	if (record.writeMode === "read_only") {
		policyLines.push("You are read-only. Do not modify files. Use read-only inspection commands only.");
	} else if (record.writeMode === "disjoint_scope") {
		policyLines.push(`Only modify files under these allowed paths: ${record.allowedPaths.join(", ") || "(none)"}.`);
	}

	const sections = [
		"# Subagent Runtime Policy",
		policyLines.join("\n"),
	];
	if (agentDefinition?.trim()) sections.push("# Agent Definition", agentDefinition.trim());
	if (inheritedContext?.trim()) sections.push("# Inherited Context", inheritedContext.trim());
	return sections.join("\n\n");
}

export function buildChildUserPrompt(record: AgentRecord): string {
	const prompt = truncateMiddle(record.prompt, 40_000);
	return `Task name: ${record.taskName}\nTask path: ${record.taskPath}\n\n${prompt}\n\nWhen finished, provide a final concise report with:\n- Summary\n- Important evidence or files inspected\n- Changed files, if any\n- Validation performed\n- Open risks or follow-up recommendations`;
}
