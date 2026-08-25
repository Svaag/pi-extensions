/**
 * Pure utility functions for goal mode.
 * Extracted for testability without loading Pi extension runtime packages.
 */

/** Message type used for the authoritative, LLM-visible goal context. */
export const GOAL_MODE_CONTEXT_TYPE = "goal-mode-context";

/** Hidden message type used to force another execution turn. */
export const GOAL_MODE_RESUME_TYPE = "goal-mode-auto-resume";

/** Pi's default token reserve for the model response after compaction. */
export const DEFAULT_GOAL_COMPACTION_RESERVE_TOKENS = 16_384;

/** Unambiguous final lines that signal the whole goal is complete. */
const GOAL_COMPLETE_PATTERN = /^(?:\[GOAL\s+COMPLETE\]|\[TASK\s+COMPLETE\]|Goal complete\.)$/i;

/** Return whether Goal Mode should compact before another model request. */
export function shouldCompactGoalContext(
	usage: { tokens: number | null; contextWindow?: number } | undefined,
	reserveTokens = DEFAULT_GOAL_COMPACTION_RESERVE_TOKENS,
): boolean {
	if (
		usage?.tokens === null ||
		usage?.tokens === undefined ||
		!Number.isFinite(usage.tokens) ||
		usage.tokens < 0 ||
		usage.contextWindow === undefined ||
		!Number.isFinite(usage.contextWindow) ||
		usage.contextWindow <= 0 ||
		!Number.isFinite(reserveTokens) ||
		reserveTokens < 0
	) {
		return false;
	}

	return usage.tokens > usage.contextWindow - reserveTokens;
}

/** Choose how a submitted goal reaches the agent. */
export function getGoalDeliveryMode(isIdle: boolean): "immediate" | "steer" {
	return isIdle ? "immediate" : "steer";
}

/**
 * Remove stale goal contexts and prepend the authoritative one.
 *
 * Context hooks run before every provider request. The checkpoint must stay at
 * a fixed position so each request extends, rather than rewrites, the cached
 * prompt prefix as assistant and tool messages are added.
 */
export function replaceGoalModeContext<T>(messages: readonly T[], activeContext?: T): T[] {
	const filtered = messages.filter(
		(message) =>
			(message as { customType?: unknown }).customType !== GOAL_MODE_CONTEXT_TYPE,
	);
	return activeContext === undefined ? filtered : [activeContext, ...filtered];
}

/**
 * Build the follow-up user message used to resume a goal run that stopped
 * without completing (API error, dropped stream, or any other pause).
 */
export function buildAutoResumePrompt(reason: string, revision: number): string {
	return [
		`[Goal Mode auto-resume] The previous run stopped ${reason}.`,
		`The persisted active goal (revision ${revision}) is still in effect.`,
		"",
		"Continue executing it from where you left off. Verify current state before redoing work, do not repeat completed steps, and do not ask open-ended questions.",
		"Take the next concrete action now. Do not stop at a diagnosis, blocker report, failed command, missing optional tool, or list of proposed next steps.",
		"Investigate the obstacle, try a sensible correction, and switch to a materially different approach if the first attempt fails. If a genuine external blocker remains, finish every unblocked part before reporting the exact unblock action.",
		"Only emit [GOAL COMPLETE] once the entire goal has been delivered and verified.",
	].join("\n");
}

/** Backoff delay before the nth consecutive auto-resume (1-based), in ms. */
export function getAutoResumeDelayMs(attempt: number, baseMs: number, maxMs: number): number {
	return Math.min(baseMs * attempt, maxMs);
}

/** Build the authoritative context re-injected for every model call. */
export function buildPersistentGoalContext(goal: string, revision: number): string {
	return [
		"## Active Goal (persisted by Goal Mode)",
		`Revision: ${revision}`,
		"",
		goal,
		"",
		"This is the authoritative active goal. It supersedes earlier Goal Mode goals and remains active across turns, tool calls, and context compaction.",
		"Continue executing it independently. Do not treat a compaction summary, an ordinary obstacle, a failed attempt, or the end of one turn as a reason to stop.",
		"When work gets stuck, inspect the failure, try a sensible correction, then change tactics rather than repeating the same blocker report. Keep taking concrete actions and finish all unblocked work.",
		"Only include [GOAL COMPLETE] as the final non-empty line after the entire goal has been delivered and verified.",
	].join("\n");
}

export interface PlanModeState {
	executing: boolean;
	todos: Array<{ step: number; text: string; completed: boolean }>;
}

export interface ProgressItem {
	text: string;
	done: boolean;
}

export function isGoalCompleteSignal(text: string): boolean {
	const finalLine = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	return finalLine !== undefined && GOAL_COMPLETE_PATTERN.test(finalLine);
}

export function buildPlanModeCoordinationPrompt(state: PlanModeState): string {
	const remaining = state.todos.filter((t) => !t.completed);
	const allSteps = state.todos
		.map((t) => `${t.step}. ${t.completed ? "[x]" : "[ ]"} ${t.text}`)
		.join("\n");
	return [
		"## Active Plan Mode Todos",
		"The user previously created an implementation plan with the following steps. Continue executing them in order as part of this goal.",
		"",
		"All plan steps:",
		allSteps,
		"",
		remaining.length > 0
			? `Next unfinished step: ${remaining[0].step}. ${remaining[0].text}`
			: "All plan steps appear complete.",
		"",
		"Whenever you finish a plan step, mark it with [DONE:n] where n is the step number (e.g. [DONE:2]). You may also say \"Completed step N\", \"Completed phase N\", or \"Completed steps 1-3\".",
		"Only emit [GOAL COMPLETE] after every unfinished plan step above is marked done. Once you emit [GOAL COMPLETE], goal mode will exit automatically.",
	].join("\n");
}

/** Extract check-list-like items from assistant text: [DONE] item, - [x] item, etc. */
export function extractProgressItems(text: string): ProgressItem[] {
	const items: ProgressItem[] = [];
	// [DONE] some task
	for (const match of text.matchAll(/^\s*\[DONE\]\s*(.+)$/gim)) {
		items.push({ text: match[1].trim(), done: true });
	}
	// - [x] some task
	for (const match of text.matchAll(/^\s*-?\s*\[x\]\s*(.+)$/gim)) {
		items.push({ text: match[1].trim(), done: true });
	}
	// - [ ] some task
	for (const match of text.matchAll(/^\s*-?\s*\[\s*\]\s*(.+)$/gim)) {
		if (!items.find((i) => i.text === match[1].trim())) {
			items.push({ text: match[1].trim(), done: false });
		}
	}
	return items;
}

export function mergeProgressItems(existing: ProgressItem[], extracted: ProgressItem[]): ProgressItem[] {
	const merged = existing.map((item) => ({ ...item }));
	for (const item of extracted) {
		const previous = merged.find((p) => p.text.toLowerCase() === item.text.toLowerCase());
		if (previous) {
			previous.done = previous.done || item.done;
		} else {
			merged.push({ ...item });
		}
	}
	return merged;
}
