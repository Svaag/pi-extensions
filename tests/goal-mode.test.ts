import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPlanModeCoordinationPrompt,
	extractProgressItems,
	isGoalCompleteSignal,
	mergeProgressItems,
} from "../goal-mode/utils.ts";

test("extractProgressItems extracts done and pending checklist items", () => {
	assert.deepEqual(extractProgressItems("[DONE] Bootstrap project\n- [x] Add tests\n- [ ] Push branch"), [
		{ text: "Bootstrap project", done: true },
		{ text: "Add tests", done: true },
		{ text: "Push branch", done: false },
	]);
});

test("extractProgressItems does not add a pending duplicate after a done item", () => {
	assert.deepEqual(extractProgressItems("[DONE] Add tests\n- [ ] Add tests"), [
		{ text: "Add tests", done: true },
	]);
});

test("mergeProgressItems preserves done status and merges case-insensitively", () => {
	const merged = mergeProgressItems(
		[{ text: "Add tests", done: false }],
		[
			{ text: "add tests", done: true },
			{ text: "Push branch", done: false },
		],
	);

	assert.deepEqual(merged, [
		{ text: "Add tests", done: true },
		{ text: "Push branch", done: false },
	]);
});

test("isGoalCompleteSignal recognizes completion markers", () => {
	assert.equal(isGoalCompleteSignal("[GOAL COMPLETE]"), true);
	assert.equal(isGoalCompleteSignal("[TASK COMPLETE]"), true);
	assert.equal(isGoalCompleteSignal("Goal complete."), true);
	assert.equal(isGoalCompleteSignal("Still working."), false);
});

test("buildPlanModeCoordinationPrompt points to the first unfinished plan step", () => {
	const prompt = buildPlanModeCoordinationPrompt({
		executing: true,
		todos: [
			{ step: 1, text: "Create worktrees", completed: true },
			{ step: 2, text: "Implement feature", completed: false },
			{ step: 3, text: "Run tests", completed: false },
		],
	});

	assert.match(prompt, /1\. \[x\] Create worktrees/);
	assert.match(prompt, /2\. \[ \] Implement feature/);
	assert.match(prompt, /Next unfinished step: 2\. Implement feature/);
	assert.match(prompt, /\[DONE:n\]/);
	assert.match(prompt, /Only emit \[GOAL COMPLETE\]/);
});
