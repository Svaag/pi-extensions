/**
 * Pure utility functions for goal mode.
 * Extracted for testability without loading Pi extension runtime packages.
 */

/** Message type used for the authoritative, LLM-visible goal context. */
export const GOAL_MODE_CONTEXT_TYPE = "goal-mode-context";

/** Unambiguous tags that signal the agent considers the whole goal complete. */
const GOAL_COMPLETE_PATTERN = /^\s*(?:\[GOAL\s+COMPLETE\]|\[TASK\s+COMPLETE\]|Goal complete\.)\s*$/im;

/** Choose how a submitted goal reaches the agent. */
export function getGoalDeliveryMode(isIdle: boolean): "immediate" | "steer" {
	return isIdle ? "immediate" : "steer";
}

/** Remove stale goal contexts and optionally append the authoritative one. */
export function replaceGoalModeContext<T>(messages: readonly T[], activeContext?: T): T[] {
	const filtered = messages.filter(
		(message) =>
			(message as { customType?: unknown }).customType !== GOAL_MODE_CONTEXT_TYPE,
	);
	if (activeContext !== undefined) filtered.push(activeContext);
	return filtered;
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
		"Continue executing it independently. Do not treat a compaction summary or the end of one turn as completion.",
		"Only include [GOAL COMPLETE] after the entire goal has been delivered and verified.",
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
	return GOAL_COMPLETE_PATTERN.test(text);
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
