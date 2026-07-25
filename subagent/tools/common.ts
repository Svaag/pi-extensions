import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../core/AgentManager.ts";
import type { ThinkingLevel } from "../core/AgentTypes.ts";

export type ManagerGetter = (ctx: ExtensionContext) => AgentManager;

export function textResult(text: string, details: unknown = undefined) {
	return { content: [{ type: "text" as const, text }], details };
}

export function preview(text: unknown, max = 80): string {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const THINKING_LEVEL_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Downgrade a subagent's thinking level relative to the parent model.
 *
 * The theory: the most powerful model should drive orchestration and never be
 * outshined by any subagent.  When no explicit thinking level was requested,
 * we automatically step subagents 1-2 levels below the parent to preserve the
 * Pareto frontier and reduce quota drain.
 *
 * Explicit thinking levels (set via the tool parameter or agent definition)
 * are never downgraded — the caller knows what they need.
 *
 * @param parentLevel  The parent session's current thinking level.
 * @param resolvedLevel  The thinking level resolved by the router (may already
 *                        be downgraded or set explicitly).
 * @param explicitLevel  The level explicitly requested by the caller, if any.
 * @param steps  Number of steps to downgrade.  Default 2.
 * @returns The downgraded thinking level.
 */
export function downgradeSubagentThinking(
	parentLevel: ThinkingLevel | undefined,
	resolvedLevel: ThinkingLevel | undefined,
	explicitLevel: ThinkingLevel | undefined,
	steps = 2,
): ThinkingLevel | undefined {
	// Never override an explicit request.
	if (explicitLevel) return resolvedLevel;

	const effective = resolvedLevel ?? parentLevel;
	if (!effective) return resolvedLevel;

	const idx = THINKING_LEVEL_ORDER.indexOf(effective);
	if (idx < 0) return resolvedLevel;

	const downgraded = THINKING_LEVEL_ORDER[Math.max(0, idx - steps)];
	return downgraded;
}

/** Read the parent session's current thinking level from ctx. */
export function parentThinkingLevel(ctx: any): ThinkingLevel | undefined {
	const value = ctx?.thinkingLevel;
	return typeof value === "string" ? value as ThinkingLevel : undefined;
}
