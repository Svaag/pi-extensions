import type { AgentMetrics } from "../core/AgentTypes.ts";

export type UsageMetrics = Pick<AgentMetrics,
	| "providerRequests"
	| "inputTokens"
	| "outputTokens"
	| "cacheReadTokens"
	| "cacheWriteTokens"
	| "totalTokens"
	| "costUsd"
>;

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function addOptional(current: number | undefined, addition: number | undefined): number | undefined {
	if (addition === undefined) return current;
	return (current ?? 0) + addition;
}

/** Aggregate provider usage from the assistant messages completed in one child turn. */
export function aggregateAssistantUsage(messages: unknown[]): UsageMetrics {
	let providerRequests = 0;
	let inputTokens: number | undefined;
	let outputTokens: number | undefined;
	let cacheReadTokens: number | undefined;
	let cacheWriteTokens: number | undefined;
	let totalTokens: number | undefined;
	let costUsd: number | undefined;

	for (const candidate of messages) {
		const message = candidate as any;
		if (message?.role !== "assistant") continue;
		const usage = message.usage;
		if (!usage || typeof usage !== "object") continue;
		providerRequests += 1;
		inputTokens = addOptional(inputTokens, finiteNonNegative(usage.input));
		outputTokens = addOptional(outputTokens, finiteNonNegative(usage.output));
		cacheReadTokens = addOptional(cacheReadTokens, finiteNonNegative(usage.cacheRead));
		cacheWriteTokens = addOptional(cacheWriteTokens, finiteNonNegative(usage.cacheWrite));
		totalTokens = addOptional(totalTokens, finiteNonNegative(usage.totalTokens));
		costUsd = addOptional(costUsd, finiteNonNegative(usage.cost?.total));
	}

	return {
		providerRequests,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens,
		costUsd,
	};
}

export function addOptionalMetric(left: number | undefined, right: number | undefined): number | undefined {
	if (left === undefined && right === undefined) return undefined;
	return (left ?? 0) + (right ?? 0);
}

/** Merge a completed turn's metrics into the cumulative persisted agent metrics. */
export function mergeCumulativeAgentMetrics(
	previous: AgentMetrics | undefined,
	turn: AgentMetrics | undefined,
	overrides: Partial<AgentMetrics> = {},
): AgentMetrics {
	return {
		durationMs: addOptionalMetric(previous?.durationMs, turn?.durationMs),
		queueDurationMs: previous?.queueDurationMs ?? turn?.queueDurationMs,
		startupDurationMs: previous?.startupDurationMs ?? turn?.startupDurationMs,
		firstProgressMs: turn?.firstProgressMs ?? previous?.firstProgressMs,
		outputChars: overrides.outputChars ?? turn?.outputChars ?? previous?.outputChars,
		exitCode: overrides.exitCode ?? turn?.exitCode ?? previous?.exitCode,
		turns: addOptionalMetric(previous?.turns, turn?.turns ?? 1),
		toolCalls: addOptionalMetric(previous?.toolCalls, turn?.toolCalls),
		providerRequests: addOptionalMetric(previous?.providerRequests, turn?.providerRequests),
		compactions: addOptionalMetric(previous?.compactions, turn?.compactions),
		inputTokens: addOptionalMetric(previous?.inputTokens, turn?.inputTokens),
		outputTokens: addOptionalMetric(previous?.outputTokens, turn?.outputTokens),
		cacheReadTokens: addOptionalMetric(previous?.cacheReadTokens, turn?.cacheReadTokens),
		cacheWriteTokens: addOptionalMetric(previous?.cacheWriteTokens, turn?.cacheWriteTokens),
		totalTokens: addOptionalMetric(previous?.totalTokens, turn?.totalTokens),
		costUsd: addOptionalMetric(previous?.costUsd, turn?.costUsd),
		...overrides,
	};
}
