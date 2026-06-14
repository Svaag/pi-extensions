/**
 * Pure utility functions for goal mode.
 * Extracted for testability without loading Pi extension runtime packages.
 */

/** Tag that signals the agent considers the goal complete. */
const GOAL_COMPLETE_PATTERN = /\[GOAL\s+COMPLETE\]|\[TASK\s+COMPLETE\]|\[DONE\]|Goal complete\./i;

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
