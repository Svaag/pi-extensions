export interface SubagentLimits {
	maxAgentsTotal: number;
	maxOpenAgents: number;
	maxAgentsRunning: number;
	maxDepth: number;
	maxOutputCharsPerAgent: number;
	maxPersistedOutputTailChars: number;
	maxTaskPromptChars: number;
	maxRuntimeMsPerAgent: number;
	maxQueuedMessages: number;
	allowedCwdRoots: string[];
	requireConfirmationForProjectAgents: boolean;
	requireConfirmationForWrites: boolean;
	idleTtlMs: number;
}

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
	maxAgentsTotal: 32,
	maxOpenAgents: 12,
	maxAgentsRunning: 4,
	maxDepth: 3,
	maxOutputCharsPerAgent: 64_000,
	maxPersistedOutputTailChars: 8_192,
	maxTaskPromptChars: 40_000,
	maxRuntimeMsPerAgent: 30 * 60_000,
	maxQueuedMessages: 50,
	allowedCwdRoots: [],
	requireConfirmationForProjectAgents: true,
	requireConfirmationForWrites: true,
	idleTtlMs: 30 * 60_000,
};

export function normalizeLimits(overrides: Partial<SubagentLimits> = {}): SubagentLimits {
	return {
		...DEFAULT_SUBAGENT_LIMITS,
		...overrides,
		allowedCwdRoots: overrides.allowedCwdRoots ? [...overrides.allowedCwdRoots] : [...DEFAULT_SUBAGENT_LIMITS.allowedCwdRoots],
	};
}
